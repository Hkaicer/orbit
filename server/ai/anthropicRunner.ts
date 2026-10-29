// The assistant through the Anthropic API, with an API key the user saved in
// Settings (billed separately from any Claude plan). ORBIT runs the tool loop
// itself, with the same tools as through Claude Code.

import Anthropic from "@anthropic-ai/sdk";
import type { RunnerStatus } from "../../shared/types";
import { log } from "../logger";
import type { Settings } from "../services/settings";
import type { Fetch } from "./chatgptAuth";
import { AssistantError, MAX_STEPS, type AssistantRunner, type RunRequest, type RunResult } from "./runner";
import { executeTool, toolDefinitions } from "./tools";
import type { AiVault } from "./vault";

interface ModelInfo {
  id: string;
  label: string;
  family: "haiku" | "sonnet" | "opus" | "other";
  createdAt: string;
}

export class AnthropicRunner implements AssistantRunner {
  private client: { key: string; api: Anthropic } | null = null;
  private models: { at: number; key: string; list: ModelInfo[] } | null = null;

  constructor(private readonly deps: { vault: AiVault; settings: () => Settings; fetch?: Fetch }) {}

  /** A client for the key saved now (rebuilt when the key changes). */
  private async api(): Promise<{ key: string; api: Anthropic }> {
    await this.deps.vault.ready();
    const saved = this.deps.vault.read().apiKey;
    if (saved?.service !== "anthropic") throw new AssistantError("missing_key", "Aucune clé d'API Anthropic n'est enregistrée. Ajoutez-la dans Réglages, partie Assistant IA.");
    if (this.client?.key !== saved.key) {
      this.client = { key: saved.key, api: new Anthropic({ apiKey: saved.key, maxRetries: 2, timeout: 600_000, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) }) };
    }
    return this.client;
  }

  private async listModels(): Promise<ModelInfo[]> {
    const { key, api } = await this.api();
    if (this.models && this.models.key === key && Date.now() - this.models.at < 10 * 60_000) return this.models.list;
    const list: ModelInfo[] = [];
    for await (const m of api.models.list({ limit: 100 })) {
      const family = m.id.includes("opus") ? "opus" : m.id.includes("sonnet") ? "sonnet" : m.id.includes("haiku") ? "haiku" : "other";
      list.push({ id: m.id, label: m.display_name ?? m.id, family, createdAt: String(m.created_at) });
    }
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.models = { at: Date.now(), key, list };
    return list;
  }

  /** haiku, sonnet or opus: the newest model of that family the key can use. */
  private async resolveModel(alias: string): Promise<string> {
    const match = (await this.listModels()).find((m) => m.family === alias);
    if (!match) throw new AssistantError("model_unavailable", `Aucun modèle ${alias} n'est disponible pour cette clé d'API.`);
    return match.id;
  }

  async status(): Promise<RunnerStatus> {
    const base: RunnerStatus = { state: "ready", message: "", plan: null, version: null };
    await this.deps.vault.ready();
    if (this.deps.vault.read().apiKey?.service !== "anthropic") {
      return { ...base, state: "missing_key", message: "Aucune clé d'API Anthropic n'est enregistrée. Ajoutez-la dans Réglages, partie Assistant IA." };
    }
    if (!this.deps.settings().apiConsentAt) return { ...base, state: "needs_consent", message: "Confirmez dans les Réglages que l'usage de la clé est facturé à part." };
    try {
      const models = await this.listModels();
      return {
        ...base,
        message: "Clé d'API Anthropic : l'usage est facturé à part sur votre compte Anthropic.",
        models: models.filter((m) => m.family !== "other").map((m) => ({ id: m.id, label: m.label })),
      };
    } catch (err) {
      const e = toAssistantError(err);
      return { ...base, state: e.code === "auth" ? "missing_key" : "error", message: e.message };
    }
  }

  async run(req: RunRequest): Promise<RunResult> {
    const rc = req.run;
    if (!rc) throw new AssistantError("unknown", "Demande sans outils : rien n'a été fait.");
    if (!this.deps.settings().apiConsentAt) throw new AssistantError("billing", "Confirmez dans les Réglages que l'usage de la clé est facturé à part.");
    const { api } = await this.api();
    const model = await this.resolveModel(req.model);
    const effort = req.effort as "low" | "medium" | "high" | "xhigh" | null;
    const tools: Anthropic.Tool[] = toolDefinitions(rc).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.prompt }];
    const timeout = AbortSignal.timeout(req.timeoutMs);
    const signal = AbortSignal.any([req.signal, timeout]);
    req.onEvent({ type: "status", text: "thinking" });

    for (let i = 0; i < MAX_STEPS; i++) {
      if (i > 0) req.onEvent({ type: "status", text: "continuing" });
      let response: Anthropic.Message;
      try {
        // Streamed, so a long answer arrives as it is written and never hits a request timeout.
        const stream = api.messages.stream({ model, max_tokens: 16000, system: req.system, messages, tools, ...(effort ? { output_config: { effort } } : {}) }, { signal });
        stream.on("text", (delta) => req.onEvent({ type: "text", delta }));
        response = await stream.finalMessage();
      } catch (err) {
        if (req.signal.aborted) throw new AssistantError("cancelled", "Demande annulée.");
        if (timeout.aborted) throw new AssistantError("timeout", `Claude n'a pas terminé en ${Math.round(req.timeoutMs / 1000)} secondes.`);
        throw toAssistantError(err);
      }
      if (response.stop_reason === "refusal") throw new AssistantError("refused", "Claude a refusé cette demande.");
      if (response.stop_reason === "max_tokens") throw new AssistantError("invalid_output", "La réponse a été coupée avant la fin.");
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || uses.length === 0) {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        log.info("anthropic api run finished", { model: response.model, tools: rc.calls.length });
        return { text, model: response.model };
      }
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        const r = await executeTool(rc, u.name, u.input);
        results.push(r.ok ? { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(r.result) } : { type: "tool_result", tool_use_id: u.id, content: r.error, is_error: true });
      }
      messages.push({ role: "user", content: results });
    }
    throw new AssistantError("invalid_output", "La demande a demandé trop d'étapes et a été arrêtée.");
  }
}

function toAssistantError(err: unknown): AssistantError {
  if (err instanceof AssistantError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new AssistantError("cancelled", "Demande annulée.");
  if (err instanceof Anthropic.RateLimitError) return new AssistantError("rate_limit", "La limite de l'API Anthropic est atteinte. Réessayez dans un instant.");
  if (err instanceof Anthropic.AuthenticationError) return new AssistantError("auth", "La clé d'API Anthropic a été refusée. Vérifiez-la dans Réglages, partie Assistant IA.");
  if (err instanceof Anthropic.PermissionDeniedError) return new AssistantError("billing", "Cette clé n'a pas accès à ce modèle, ou le compte n'a plus de crédit.");
  if (err instanceof Anthropic.NotFoundError) return new AssistantError("model_unavailable", "Ce modèle n'est pas disponible pour cette clé d'API.");
  if (err instanceof Anthropic.APIConnectionError) return new AssistantError("network", "L'API Anthropic est injoignable. Vérifiez la connexion internet.");
  if (err instanceof Anthropic.InternalServerError) return new AssistantError("unavailable", "L'API Anthropic a eu une erreur de serveur. Réessayez.");
  if (err instanceof Anthropic.APIError) return new AssistantError("unknown", `L'API Anthropic a refusé la demande : ${err.message.slice(0, 200)}`);
  return new AssistantError("unknown", (err as Error)?.message?.slice(0, 200) ?? "Erreur inconnue.");
}
