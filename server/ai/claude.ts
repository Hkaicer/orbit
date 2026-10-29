// Claude through the user's own subscription.
//
// Runs the official, unmodified Claude Code CLI in non-interactive mode
// (`claude -p`), signed in with the user's Claude plan. ORBIT never reads,
// stores or forwards Claude credentials, and refuses to run if the CLI would
// bill an API key. The CLI gets no built-in tools (no shell, no file access):
// its only tools are ORBIT's own, served over a loopback MCP endpoint bound to
// one request by an unguessable token.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ConnectorInfo, RunnerStatus } from "../../shared/types";
import { AssistantError as ClaudeError, type AssistantRunner, type RunRequest, type RunResult } from "./runner";
import { log } from "../logger";

const execFileAsync = promisify(execFile);

const ENV_ALLOW = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "SystemDrive",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERDOMAIN",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "LANG",
  "LC_ALL",
  "TERM",
  "XDG_CONFIG_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
];

/** Environment for the CLI: anything Anthropic- or Claude-specific is withheld, so a stray key never switches it to API billing. */
export function cliEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOW) if (source[key] !== undefined) env[key] = source[key];
  for (const key of Object.keys(env)) if (/^(ANTHROPIC|CLAUDE)/i.test(key)) delete env[key];
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_AUTOUPDATER = "1";
  env.MCP_TIMEOUT = "15000";
  // Wait for the MCP servers (ORBIT's own, and an allowed claude.ai connector) before the first turn:
  // otherwise Claude may start before they are connected and not see their tools.
  env.MCP_CONNECTION_NONBLOCKING = "false";
  return env;
}

export function findClaude(configured: string): string | null {
  const list: string[] = [];
  if (configured) list.push(configured);
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    for (const n of process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"]) list.push(path.join(dir, n));
  }
  list.push(path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"));
  if (process.env.APPDATA) list.push(path.join(process.env.APPDATA, "npm", "claude.cmd"));
  for (const p of list) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not there
    }
  }
  return null;
}

const needsShell = (bin: string) => /\.(cmd|bat)$/i.test(bin);
const quote = (arg: string) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

export { ClaudeError };
export type { RunRequest, RunResult };
export type ClaudeRunner = AssistantRunner;

/** The claude.ai connectors of the account that ORBIT never lets the assistant use. */
export const BLOCKED_CONNECTORS = [
  "mcp__claude_ai_Gmail",
  "mcp__claude_ai_Google_Drive",
  "mcp__claude_ai_Google_Calendar",
  "mcp__claude_ai_Canva",
  "mcp__claude_ai_Jotform",
  "mcp__claude_ai_Claude_Docs",
  "mcp__claude_ai_Figma",
  "mcp__claude_ai_LinkedIn_Hiring_Pro",
];

/** The tool prefix Claude Code gives a claude.ai connector: « claude.ai Google Drive » becomes mcp__claude_ai_Google_Drive. */
export const connectorPrefix = (name: string) => `mcp__claude_ai_${name.trim().replace(/[^A-Za-z0-9]+/g, "_")}`;

/** Reads the claude.ai lines of « claude mcp list ». */
export function parseConnectorList(out: string): ConnectorInfo[] {
  const items: ConnectorInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^claude\.ai (.+?): \S+ - (.+)$/.exec(line.trim());
    if (!m) continue;
    const state = m[2]!.toLowerCase();
    const status = /connected/.test(state) ? "connected" : /auth/.test(state) ? "needs_auth" : "failed";
    items.push({ name: m[1]!, prefix: connectorPrefix(m[1]!), status });
  }
  return items;
}

/** The Claude Code plugins of the user, all turned off for ORBIT's requests. */
function userPluginsOff(): Record<string, boolean> {
  try {
    const user = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8")) as { enabledPlugins?: Record<string, boolean> };
    return Object.fromEntries(Object.keys(user.enabledPlugins ?? {}).map((k) => [k, false]));
  } catch {
    return {};
  }
}

export class ClaudeCli implements AssistantRunner {
  private cache: { at: number; status: RunnerStatus; bin: string | null } | null = null;
  private connectorCache: { at: number; items: ConnectorInfo[] } | null = null;

  constructor(
    private readonly workDir: string,
    private readonly mcpUrl: (token: string) => string,
    private readonly claudePath: () => string,
  ) {}

  private exec(bin: string, args: string[], timeout = 15_000) {
    return needsShell(bin)
      ? execFileAsync(`${quote(bin)} ${args.map(quote).join(" ")}`, { shell: true, timeout, env: cliEnvironment(), windowsHide: true })
      : execFileAsync(bin, args, { timeout, env: cliEnvironment(), windowsHide: true });
  }

  /** « claude mcp list » checks each server of the account: a few seconds, kept five minutes. */
  async connectors(force = false): Promise<ConnectorInfo[]> {
    if (!force && this.connectorCache && Date.now() - this.connectorCache.at < 300_000) return this.connectorCache.items;
    const status = await this.status();
    if (status.state !== "ready" || !this.cache?.bin) throw new ClaudeError("unavailable", status.message);
    let out: string;
    try {
      out = (await this.exec(this.cache.bin, ["mcp", "list"], 60_000)).stdout;
    } catch (err) {
      out = (err as { stdout?: string }).stdout ?? "";
      if (!out) throw new ClaudeError("unknown", "Claude Code n'a pas pu lister vos connecteurs.");
    }
    this.connectorCache = { at: Date.now(), items: parseConnectorList(out) };
    return this.connectorCache.items;
  }

  async status(force = false): Promise<RunnerStatus> {
    if (!force && this.cache && Date.now() - this.cache.at < 60_000) return this.cache.status;
    const bin = findClaude(this.claudePath());
    let status: RunnerStatus;
    if (!bin) {
      status = { state: "not_installed", message: "Claude Code n'est pas installé. Installez-le et connectez-vous avec votre compte Claude.", plan: null, version: null };
    } else {
      try {
        const version = (await this.exec(bin, ["--version"])).stdout.trim().split(/\s+/)[0] ?? null;
        let auth: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } = {};
        try {
          auth = JSON.parse((await this.exec(bin, ["auth", "status", "--json"])).stdout) as typeof auth;
        } catch (err) {
          const out = (err as { stdout?: string }).stdout;
          auth = out ? (JSON.parse(out) as typeof auth) : {};
        }
        if (!auth.loggedIn) status = { state: "not_logged_in", message: "Claude Code n'est pas connecté. Lancez « claude auth login » dans un terminal.", plan: null, version };
        else if (auth.authMethod !== "claude.ai") {
          status = {
            state: "api_key_auth",
            message: "Claude Code utilise une clé API, facturée à part : ORBIT refuse de l'utiliser. Reconnectez-le avec votre abonnement (« claude auth login »).",
            plan: null,
            version,
          };
        } else status = { state: "ready", message: `Connecté avec votre abonnement Claude ${auth.subscriptionType ?? ""}`.trim() + ".", plan: auth.subscriptionType ?? null, version };
      } catch (err) {
        log.warn("claude status failed", { error: (err as Error).message.slice(0, 200) });
        status = { state: "error", message: "Claude Code ne répond pas. Réessayez, ou lancez « claude doctor ».", plan: null, version: null };
      }
    }
    this.cache = { at: Date.now(), status, bin };
    return status;
  }

  async run(req: RunRequest): Promise<RunResult> {
    const status = await this.status();
    if (status.state !== "ready" || !this.cache?.bin) throw new ClaudeError(status.state === "not_logged_in" || status.state === "api_key_auth" ? "auth" : "unavailable", status.message);
    const bin = this.cache.bin;
    const runDir = path.join(this.workDir, "runs", req.token.slice(0, 16));
    fs.mkdirSync(runDir, { recursive: true });
    const systemFile = path.join(runDir, "system.md");
    const mcpFile = path.join(runDir, "mcp.json");
    const settingsFile = path.join(runDir, "settings.json");
    fs.writeFileSync(systemFile, req.system, "utf8");
    const connectors = req.connectors ?? [];
    // Every other connector of the account is denied by name, the ones seen by the last check included.
    const blocked = [...new Set([...BLOCKED_CONNECTORS, ...(this.connectorCache?.items ?? []).map((c) => c.prefix)])].filter((p) => !connectors.includes(p));
    // Keep the user's own instruction files, auto memory and plugins out of ORBIT's requests.
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude/rules/**"], autoMemoryEnabled: false, ...(connectors.length ? { enabledPlugins: userPluginsOff() } : {}) }),
      "utf8",
    );
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { orbit: { type: "http", url: this.mcpUrl(req.token) } } }), "utf8");
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      req.model,
      ...(req.effort ? ["--effort", req.effort] : []),
      "--system-prompt-file",
      systemFile,
      "--mcp-config",
      mcpFile,
      // claude.ai connectors only load with the account's settings: then every other connector is denied by name,
      // and dontAsk refuses any tool that is not allowed here. Without a connector, nothing but ORBIT's server exists.
      ...(connectors.length ? ["--disallowedTools", ...blocked] : ["--strict-mcp-config", "--setting-sources", "project"]),
      "--tools",
      "",
      "--allowedTools",
      ["mcp__orbit", ...connectors].join(","),
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--settings",
      settingsFile,
      "--disable-slash-commands",
    ];
    const started = Date.now();
    return await new Promise<RunResult>((resolve, reject) => {
      const child = needsShell(bin)
        ? spawn(`${quote(bin)} ${args.map((a) => (a === "" ? '""' : quote(a))).join(" ")}`, { cwd: runDir, env: cliEnvironment(), shell: true, windowsHide: true })
        : spawn(bin, args, { cwd: runDir, env: cliEnvironment(), windowsHide: true });
      let buffer = "";
      let stderr = "";
      let finalText: string | null = null;
      let resultError: string | null = null;
      let model: string | null = null;
      let retryError: string | null = null;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal.removeEventListener("abort", onAbort);
        try {
          fs.rmSync(runDir, { recursive: true, force: true });
        } catch {
          // best effort
        }
        fn();
      };
      const fail = (err: ClaudeError) => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        finish(() => reject(err));
      };
      const onAbort = () => fail(new ClaudeError("cancelled", "Demande annulée."));
      req.signal.addEventListener("abort", onAbort);
      const timer = setTimeout(() => fail(new ClaudeError("timeout", `Claude n'a pas terminé en ${Math.round(req.timeoutMs / 1000)} secondes.`)), req.timeoutMs);
      const handle = (line: string) => {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (ev.type === "system" && ev.subtype === "init") {
          model = typeof ev.model === "string" ? ev.model : null;
          if (ev.apiKeySource && ev.apiKeySource !== "none") return fail(new ClaudeError("auth", "Claude Code a voulu utiliser une clé API facturée à part : demande arrêtée."));
          const servers = (ev.mcp_servers as { name: string; status: string }[] | undefined) ?? [];
          if (!servers.some((s) => s.name === "orbit" && s.status !== "failed")) return fail(new ClaudeError("unavailable", "Claude n'a pas pu joindre les outils d'ORBIT."));
          req.onEvent({ type: "status", text: "thinking" });
        } else if (ev.type === "stream_event") {
          const e = ev.event as { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string; name?: string } } | undefined;
          if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) req.onEvent({ type: "text", delta: e.delta.text });
          // A connector call does not go through ORBIT's server: say it here.
          else if (e?.type === "content_block_start" && e.content_block?.name?.startsWith("mcp__claude_ai_Indeed")) req.onEvent({ type: "status", text: "indeed" });
          else if (e?.type === "message_start") req.onEvent({ type: "status", text: "continuing" });
        } else if (ev.type === "system" && ev.subtype === "api_retry") {
          retryError = typeof ev.error === "string" ? ev.error : null;
        } else if (ev.type === "result") {
          if (ev.is_error) resultError = typeof ev.result === "string" ? ev.result : String(ev.subtype ?? "error");
          else finalText = typeof ev.result === "string" ? ev.result : "";
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) handle(line);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
      child.on("error", (err) => fail(new ClaudeError("unavailable", `Claude Code n'a pas démarré : ${err.message}`)));
      child.on("close", (code) => {
        if (buffer.trim()) handle(buffer.trim());
        if (settled) return;
        log.info("claude run finished", { code, ms: Date.now() - started, model });
        if (finalText !== null) return finish(() => resolve({ text: finalText!, model }));
        const message = resultError ?? (stderr.trim().split("\n").slice(-3).join(" ") || `Claude Code s'est arrêté (code ${code}).`);
        const m = message.toLowerCase();
        const err =
          retryError === "rate_limit" || /usage limit|rate limit|limit reached/.test(m)
            ? new ClaudeError("rate_limit", "La limite d'usage de votre abonnement Claude est atteinte pour le moment. Le reste d'ORBIT fonctionne sans Claude.")
            : /\/login|not logged in|authentication|oauth/.test(m)
              ? new ClaudeError("auth", "La connexion de Claude Code a expiré. Lancez « claude auth login ».")
              : /econn|network|fetch failed|enotfound/.test(m)
                ? new ClaudeError("network", "Claude est injoignable. Vérifiez la connexion internet.")
                : new ClaudeError("unknown", `Claude Code a signalé une erreur : ${message.slice(0, 300)}`);
        finish(() => reject(err));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(req.prompt, "utf8");
    });
  }
}
