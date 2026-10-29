// One request to the assistant: its mode, the conversation, the run of tools,
// and in mode A the proposal of the prepared changes. One request at a time.

import { randomBytes } from "node:crypto";
import type { AssistantTask, ChatMessage, ModelChoice, Proposal, RequestMode, StreamEvent } from "../../shared/types";
import type { Database } from "../db/database";
import { addEvent } from "../domain/history";
import { AppError, newId } from "../errors";
import { log } from "../logger";
import { DEFAULT_PROFILE, loadSettings } from "../services/settings";
import { ClaudeError, type ClaudeRunner } from "./claude";
import { buildPrompt, SYSTEM_PROMPT, TASK_MESSAGES, TASK_TOOLS } from "./prompt";
import { applyStaged, type RunContext, type StagedOp, type ToolDeps } from "./tools";

const rowToMessage = (r: Record<string, unknown>): ChatMessage => ({
  id: String(r.id),
  role: r.role as ChatMessage["role"],
  content: String(r.content),
  meta: JSON.parse(String(r.meta ?? "{}")) as ChatMessage["meta"],
  createdAt: String(r.created_at),
});

const rowToProposal = (r: Record<string, unknown>): Proposal => ({
  id: String(r.id),
  messageId: (r.message_id as string | null) ?? null,
  status: r.status as Proposal["status"],
  ops: (JSON.parse(String(r.ops)) as StagedOp[]).map((o) => ({ tool: o.tool, summary: o.summary })),
  createdAt: String(r.created_at),
});

export function addMessage(db: Database, role: ChatMessage["role"], content: string, meta: ChatMessage["meta"] = {}): ChatMessage {
  const m: ChatMessage = { id: newId("msg"), role, content, meta, createdAt: new Date().toISOString() };
  db.run("INSERT INTO messages (id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)", m.id, role, content, JSON.stringify(meta), m.createdAt);
  return m;
}

export function conversation(db: Database): { messages: ChatMessage[]; proposals: Proposal[] } {
  const messages = db.all("SELECT * FROM (SELECT * FROM messages ORDER BY created_at DESC LIMIT 200) ORDER BY created_at").map(rowToMessage);
  const ids = messages.map((m) => m.meta.proposalId).filter((x): x is string => Boolean(x));
  const proposals = ids.length ? db.all(`SELECT * FROM proposals WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).map(rowToProposal) : [];
  return { messages, proposals };
}

export class Agent {
  private readonly runs = new Map<string, RunContext>();
  private active: AbortController | null = null;

  constructor(
    private readonly db: Database,
    private readonly claude: ClaudeRunner,
    private readonly deps: () => Omit<ToolDeps, "settings">,
  ) {}

  get busy() {
    return this.active !== null;
  }

  getRun(token: string) {
    return this.runs.get(token);
  }

  cancel() {
    this.active?.abort();
    return this.active !== null;
  }

  async chat(input: { message: string; mode?: RequestMode; model?: ModelChoice; task?: AssistantTask }, emit: (e: StreamEvent) => void): Promise<void> {
    const text = input.task ? TASK_MESSAGES[input.task] : input.message.trim();
    if (!text) throw new AppError("validation", "Écrivez un message.");
    if (text.length > 60_000) throw new AppError("validation", "Message trop long (60 000 caractères au plus).");
    if (this.active) throw new AppError("conflict", "ORBIT traite encore la demande précédente.");
    const settings = loadSettings(this.db);
    // Discovery writes the profile at once on a new install (or when there is none), and only prepares it otherwise.
    const fresh = !this.db.get("SELECT 1 AS x FROM offers LIMIT 1") && !this.db.get("SELECT 1 AS x FROM applications LIMIT 1");
    const asked = input.task === "discovery" ? (fresh || settings.profile.trim().length < 50 || settings.profile === DEFAULT_PROFILE ? "B" : "A") : (input.mode ?? settings.defaultMode);
    const auto = asked === "auto";
    // In auto, nothing local is done before Claude picks the mode: until then, changes are only prepared (A).
    const mode = auto ? "A" : asked;
    const model = input.model ?? settings.model;
    const controller = new AbortController();
    this.active = controller;
    const started = Date.now();
    const history = conversation(this.db).messages;
    const user = addMessage(this.db, "user", text, auto ? { auto } : { mode });
    emit({ type: "accepted", message: user });
    const rc: RunContext = {
      token: randomBytes(24).toString("hex"),
      mode,
      auto,
      deps: { ...this.deps(), settings },
      calls: [],
      staged: [],
      maxCalls: mode === "C" || auto ? 80 : 50,
      ...(input.task ? { only: TASK_TOOLS[input.task] } : {}),
      closed: false,
      files: [],
      onTool: (c) => emit({ type: "tool", name: c.name, ok: c.ok }),
    };
    this.runs.set(rc.token, rc);
    try {
      const result = await this.claude.run({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(text, asked, input.task ? [] : history, settings, new Date(), input.task),
        model,
        effort: settings.effort,
        token: rc.token,
        timeoutMs: settings.timeoutSec * 1000,
        signal: controller.signal,
        connectors: settings.indeedConnector && !input.task ? ["mcp__claude_ai_Indeed"] : [],
        onEvent: (e) => emit(e.type === "text" ? { type: "text", delta: e.delta } : { type: "status", text: e.text }),
      });
      rc.closed = true;
      let proposal: Proposal | null = null;
      if (rc.staged.length) {
        const pid = newId("pr");
        this.db.run("INSERT INTO proposals (id, status, ops, created_at) VALUES (?, 'pending', ?, ?)", pid, JSON.stringify(rc.staged), new Date().toISOString());
        proposal = rowToProposal(this.db.get("SELECT * FROM proposals WHERE id = ?", pid)!);
      }
      const reply = addMessage(this.db, "assistant", result.text.trim() || (proposal ? "Voici ce que j'ai préparé." : "C'est fait."), {
        mode: rc.mode,
        ...(auto ? { auto } : {}),
        model: result.model ?? model,
        status: "ok",
        tools: rc.calls.map((c) => ({ name: c.name, ok: c.ok })),
        durationMs: Date.now() - started,
        ...(proposal ? { proposalId: proposal.id } : {}),
        ...(rc.files.length ? { files: rc.files } : {}),
      });
      if (proposal) this.db.run("UPDATE proposals SET message_id = ? WHERE id = ?", reply.id, proposal.id);
      emit({ type: "done", message: reply, proposal });
    } catch (err) {
      rc.closed = true;
      const message = err instanceof ClaudeError || err instanceof AppError ? err.message : "Une erreur est survenue avec Claude. Vos données n'ont pas été modifiées.";
      if (!(err instanceof ClaudeError)) log.error("agent run failed", { error: (err as Error).message });
      emit({
        type: "error",
        message: addMessage(this.db, "assistant", message, { mode: rc.mode, ...(auto ? { auto } : {}), status: "error", tools: rc.calls.map((c) => ({ name: c.name, ok: c.ok })), durationMs: Date.now() - started }),
      });
    } finally {
      this.runs.delete(rc.token);
      this.active = null;
    }
  }

  /** Apply the changes prepared in mode A, all together or not at all. */
  applyProposal(id: string): { applied: string[] } {
    const r = this.db.get<Record<string, unknown>>("SELECT * FROM proposals WHERE id = ?", id);
    if (!r) throw new AppError("not_found", "Cette proposition n'existe plus.");
    if (r.status !== "pending") throw new AppError("invalid_state", "Cette proposition a déjà été traitée.");
    const ops = JSON.parse(String(r.ops)) as StagedOp[];
    const deps = { ...this.deps(), settings: loadSettings(this.db) };
    let applied: string[];
    try {
      applied = this.db.tx(() => {
        const done = applyStaged(deps, ops);
        this.db.run("UPDATE proposals SET status = 'applied', resolved_at = ? WHERE id = ?", new Date().toISOString(), id);
        return done;
      });
    } catch (err) {
      throw err instanceof AppError ? err : new AppError("invalid_state", `La proposition n'a pas pu être appliquée : ${(err as Error).message}. Rien n'a été modifié dans la base.`);
    }
    addEvent(this.db, { actor: "user", kind: "validation", summary: `Proposition validée (mode A) : ${applied.join(" · ")}`.slice(0, 500) });
    return { applied };
  }

  discardProposal(id: string) {
    const r = this.db.get<{ status: string }>("SELECT status FROM proposals WHERE id = ?", id);
    if (!r) throw new AppError("not_found", "Cette proposition n'existe plus.");
    if (r.status !== "pending") throw new AppError("invalid_state", "Cette proposition a déjà été traitée.");
    this.db.run("UPDATE proposals SET status = 'discarded', resolved_at = ? WHERE id = ?", new Date().toISOString(), id);
    addEvent(this.db, { actor: "user", kind: "validation", summary: "Proposition écartée (mode A)" });
  }

  clear() {
    this.db.run("DELETE FROM messages");
  }
}
