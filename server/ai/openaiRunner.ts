// The assistant through OpenAI's Responses API: with the user's ChatGPT plan
// (signed in with ChatGPT), or with an OpenAI API key billed separately. ORBIT
// runs the tool loop itself, with the same tools as with Claude.

import type { RunnerStatus } from "../../shared/types";
import { log } from "../logger";
import type { Settings } from "../services/settings";
import { ChatGptError, OPENAI_API, type ChatGptAuth, type Fetch } from "./chatgptAuth";
import { AssistantError, MAX_STEPS, type AssistantRunner, type RunRequest, type RunResult } from "./runner";
import { executeTool, toolDefinitions } from "./tools";
import type { AiVault } from "./vault";

export const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";

interface Model {
  id: string;
  label: string;
}

interface OutputItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
}

interface ResponseBody {
  output?: OutputItem[];
  error?: { code?: string; message?: string } | null;
  model?: string;
}

/** OpenAI models are one model with more or less reasoning: the model chosen for the request sets how much. */
const REASONING: Record<string, "low" | "medium" | "high"> = { haiku: "low", sonnet: "medium", opus: "high" };

/** Chat models in an API key's model list (not audio, images, embeddings...). */
const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/i;
const NOT_CHAT = /(audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct|dall|whisper|codex)/i;

export class OpenAiRunner implements AssistantRunner {
  private models: { at: number; list: Model[] } | null = null;
  /** Turned off when a model refuses the reasoning settings. */
  private reasoning = true;

  constructor(
    private readonly kind: "chatgpt" | "key",
    private readonly deps: { vault: AiVault; auth: ChatGptAuth; settings: () => Settings; fetch?: Fetch },
  ) {}

  private get fetchFn(): Fetch {
    return this.deps.fetch ?? fetch;
  }

  private get name() {
    return this.kind === "chatgpt" ? "ChatGPT" : "OpenAI";
  }

  private async token(force: boolean): Promise<string> {
    if (this.kind === "key") {
      await this.deps.vault.ready();
      const saved = this.deps.vault.read().apiKey;
      if (saved?.service !== "openai") throw new AssistantError("missing_key", "Aucune clé d'API OpenAI n'est enregistrée. Ajoutez-la dans Réglages, partie Assistant IA.");
      return saved.key;
    }
    try {
      return await this.deps.auth.accessToken(force);
    } catch (err) {
      throw toAssistantError(err);
    }
  }

  /** The models the account or the key can use, newest first. */
  async listModels(force = false): Promise<Model[]> {
    if (!force && this.models && Date.now() - this.models.at < 10 * 60_000) return this.models.list;
    const res = await this.call((token) => this.fetchFn(`${OPENAI_API}/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }));
    const body = (await res.json()) as { data?: Record<string, unknown>[]; models?: Record<string, unknown>[] };
    const rows = body.data ?? body.models ?? [];
    const list =
      this.kind === "chatgpt"
        ? rows.filter((m) => m.visibility === undefined || m.visibility === "list").map((m) => ({ id: String(m.slug ?? m.id ?? ""), label: String(m.display_name ?? m.title ?? m.slug ?? m.id ?? "") }))
        : rows
            .filter((m) => typeof m.id === "string" && CHAT_MODEL.test(m.id) && !NOT_CHAT.test(m.id))
            .sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0))
            .map((m) => ({ id: String(m.id), label: String(m.id) }));
    this.models = { at: Date.now(), list: list.filter((m) => m.id) };
    return this.models.list;
  }

  private async chosenModel(): Promise<Model> {
    const list = await this.listModels();
    const s = this.deps.settings();
    const wanted = this.kind === "chatgpt" ? s.chatgptModel : s.openaiModel;
    const model = (wanted && list.find((m) => m.id === wanted)) || list[0];
    if (!model) throw new AssistantError("model_unavailable", `Votre compte ${this.name} ne propose aucun modèle utilisable pour le moment.`);
    return model;
  }

  async status(): Promise<RunnerStatus> {
    const base: RunnerStatus = { state: "ready", message: "", plan: null, version: null };
    await this.deps.vault.ready();
    if (this.kind === "chatgpt") {
      const account = this.deps.auth.account();
      if (!account) return { ...base, state: "not_logged_in", message: "ORBIT n'est pas connecté à ChatGPT. Utilisez « Continuer avec ChatGPT » dans Réglages, partie Assistant IA." };
      if (!account.planUsage) {
        return { ...base, state: "needs_consent", message: "L'usage de votre abonnement ChatGPT n'a pas été autorisé à la connexion. Déconnectez-vous, puis reconnectez-vous en l'autorisant." };
      }
    } else {
      const saved = this.deps.vault.read().apiKey;
      if (saved?.service !== "openai") return { ...base, state: "missing_key", message: "Aucune clé d'API OpenAI n'est enregistrée. Ajoutez-la dans Réglages, partie Assistant IA." };
      if (!this.deps.settings().apiConsentAt) return { ...base, state: "needs_consent", message: "Confirmez dans les Réglages que l'usage de la clé est facturé à part." };
    }
    try {
      const model = await this.chosenModel();
      const email = this.kind === "chatgpt" ? this.deps.auth.account()?.email : null;
      return {
        ...base,
        plan: this.kind === "chatgpt" ? "ChatGPT" : null,
        message: this.kind === "chatgpt" ? `Connecté avec votre abonnement ChatGPT${email ? ` (${email})` : ""}.` : "Clé d'API OpenAI : l'usage est facturé à part sur votre compte OpenAI.",
        model: model.id,
        models: this.models?.list ?? [],
      };
    } catch (err) {
      const e = toAssistantError(err);
      return { ...base, state: e.code === "auth" ? "not_logged_in" : "error", message: e.message };
    }
  }

  async run(req: RunRequest): Promise<RunResult> {
    const rc = req.run;
    if (!rc) throw new AssistantError("unknown", "Demande sans outils : rien n'a été fait.");
    if (this.kind === "key" && !this.deps.settings().apiConsentAt) throw new AssistantError("billing", "Confirmez dans les Réglages que l'usage de la clé est facturé à part.");
    const model = await this.chosenModel();
    const effort = REASONING[req.model] ?? "medium";
    const tools = toolDefinitions(rc).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
    // The whole exchange goes with each request: nothing is kept on OpenAI's side (store: false).
    const images = (req.images ?? []).map((i) => ({ type: "input_image", image_url: `data:${i.mediaType};base64,${i.data}` }));
    const input: unknown[] = [{ role: "user", content: images.length ? [{ type: "input_text", text: req.prompt }, ...images] : req.prompt }];
    let lastModel: string | null = model.id;
    req.onEvent({ type: "status", text: "thinking" });

    for (let i = 0; i < MAX_STEPS; i++) {
      if (i > 0) req.onEvent({ type: "status", text: "continuing" });
      const response = await this.respond(
        {
          model: model.id,
          instructions: req.system,
          input,
          tools,
          store: false,
          stream: true,
          ...(this.reasoning ? { include: ["reasoning.encrypted_content"], reasoning: { effort } } : {}),
        },
        req,
      );
      lastModel = response.model ?? model.id;
      const output = response.output ?? [];
      const calls = output.filter((o) => o.type === "function_call");
      if (calls.length === 0) {
        const text = output
          .filter((o) => o.type === "message")
          .flatMap((o) => o.content ?? [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text ?? "")
          .join("");
        log.info("openai run finished", { kind: this.kind, model: lastModel, tools: rc.calls.length });
        return { text, model: lastModel };
      }
      input.push(...output);
      for (const call of calls) {
        let args: unknown;
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          args = null;
        }
        const r = args === null ? { ok: false as const, error: "Les arguments ne sont pas du JSON valide." } : await executeTool(rc, call.name ?? "", args);
        input.push({ type: "function_call_output", call_id: call.call_id, output: r.ok ? JSON.stringify(r.result) : `Erreur : ${r.error}` });
      }
    }
    throw new AssistantError("invalid_output", "La demande a demandé trop d'étapes et a été arrêtée.");
  }

  /** One streamed Responses API request, with its text forwarded as it arrives. */
  private async respond(body: Record<string, unknown>, req: RunRequest): Promise<ResponseBody> {
    const timeout = AbortSignal.timeout(req.timeoutMs);
    const signal = AbortSignal.any([req.signal, timeout]);
    let res: Response;
    try {
      res = await this.call((token) =>
        this.fetchFn(`${OPENAI_API}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify(body),
          signal,
        }),
      );
    } catch (err) {
      if (req.signal.aborted) throw new AssistantError("cancelled", "Demande annulée.");
      if (timeout.aborted) throw new AssistantError("timeout", `${this.name} n'a pas terminé en ${Math.round(req.timeoutMs / 1000)} secondes.`);
      const e = toAssistantError(err);
      // Some models take no reasoning settings: try once more without them.
      if (this.reasoning && "reasoning" in body && /reasoning|include/i.test(e.message)) {
        this.reasoning = false;
        const { reasoning: _r, include: _i, ...rest } = body;
        return this.respond(rest, req);
      }
      throw e;
    }

    let completed: ResponseBody | null = null;
    try {
      for await (const event of readEvents(res)) {
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") req.onEvent({ type: "text", delta: event.delta });
        else if (event.type === "response.completed") completed = event.response as ResponseBody;
        else if (event.type === "response.failed") {
          const error = (event.response as ResponseBody | undefined)?.error;
          throw responseError(this.name, error?.code ?? "unknown", error?.message ?? `${this.name} n'a pas pu répondre.`);
        } else if (event.type === "response.incomplete") throw new AssistantError("invalid_output", "La réponse a été coupée avant la fin.");
        else if (event.type === "error") throw responseError(this.name, String(event.code ?? "unknown"), String(event.message ?? `${this.name} n'a pas pu répondre.`));
      }
    } catch (err) {
      if (err instanceof AssistantError) throw err;
      if (req.signal.aborted) throw new AssistantError("cancelled", "Demande annulée.");
      if (timeout.aborted) throw new AssistantError("timeout", `${this.name} n'a pas terminé en ${Math.round(req.timeoutMs / 1000)} secondes.`);
      throw new AssistantError("network", `La connexion à ${this.name} a été coupée. Réessayez.`);
    }
    if (!completed) throw new AssistantError("network", `La connexion à ${this.name} s'est fermée avant la fin de la réponse. Réessayez.`);
    return completed;
  }

  /** A request with a fresh token, renewed once if OpenAI rejects it. */
  private async call(send: (token: string) => Promise<Response>): Promise<Response> {
    let res = await send(await this.token(false));
    if (res.status === 401 && this.kind === "chatgpt") res = await send(await this.token(true));
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw responseError(this.name, body.error?.code ?? `http_${res.status}`, body.error?.message ?? `OpenAI a répondu ${res.status}.`, res.status);
    }
    return res;
  }
}

/** Reads a server-sent event stream as JSON events. */
async function* readEvents(res: Response): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data) as Record<string, unknown>;
      } catch {
        // an incomplete or foreign event
      }
    }
  }
}

function responseError(name: string, code: string, message: string, status?: number): AssistantError {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return new AssistantError("rate_limit", `Vous avez utilisé la part de votre abonnement ChatGPT ouverte à ORBIT pour le moment. Gérer l'usage : ${MANAGE_USAGE_URL}`);
    case "subscription_sharing_usage_unavailable":
      return new AssistantError("unavailable", "ChatGPT n'a pas pu vérifier l'usage de votre abonnement. Réessayez dans un moment.");
    case "subscription_sharing_user_not_eligible":
      return new AssistantError("billing", "Ce compte, cet abonnement ou cet espace ChatGPT ne peut pas être utilisé dans d'autres applications.");
    case "subscription_sharing_invalid_user":
      return new AssistantError("auth", "ChatGPT n'a pas pu valider votre connexion. Déconnectez-vous puis reconnectez-vous dans Réglages, partie Assistant IA.");
    case "insufficient_quota":
      return new AssistantError("billing", "Le compte OpenAI de cette clé n'a plus de crédit.");
    case "model_not_found":
      return new AssistantError("model_unavailable", `Ce modèle n'est pas disponible pour votre compte ${name}. Choisissez-en un autre dans les Réglages.`);
  }
  if (status === 429) return new AssistantError("rate_limit", `${name} limite les demandes en ce moment. Réessayez dans un instant.`);
  if (status === 401) return new AssistantError("auth", name === "ChatGPT" ? "ChatGPT a refusé la connexion d'ORBIT. Reconnectez-vous dans les Réglages." : "La clé d'API OpenAI a été refusée.");
  if (status !== undefined && status >= 500) return new AssistantError("unavailable", `${name} a eu une erreur de serveur. Réessayez.`);
  return new AssistantError("unknown", `Erreur ${name} : ${message.slice(0, 200)}`);
}

function toAssistantError(err: unknown): AssistantError {
  if (err instanceof AssistantError) return err;
  if (err instanceof ChatGptError) return new AssistantError(err.code === "network" ? "network" : "auth", err.message);
  return new AssistantError("network", "OpenAI est injoignable. Vérifiez la connexion internet.");
}
