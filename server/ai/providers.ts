// The AI services behind the assistant, and the one chosen in Settings:
// - claude: Claude Code with the user's Claude plan (the only one with claude.ai connectors such as Indeed),
// - chatgpt: the user's ChatGPT plan, after signing in with ChatGPT,
// - api: an Anthropic or OpenAI API key, billed separately, used only after the user's consent.

import Anthropic from "@anthropic-ai/sdk";
import type { AiProviders, AiStatus, ApiService, ProviderId } from "../../shared/types";
import type { Settings } from "../services/settings";
import { AnthropicRunner } from "./anthropicRunner";
import { OPENAI_API, type ChatGptAuth, type Fetch } from "./chatgptAuth";
import { OpenAiRunner } from "./openaiRunner";
import type { AssistantRunner } from "./runner";
import type { AiVault } from "./vault";

export interface Picked {
  provider: ProviderId;
  runner: AssistantRunner;
  /** Claude, ChatGPT or GPT. */
  assistant: string;
  family: "claude" | "openai";
}

export type KeyCheck = "ok" | "rejected" | "unreachable";

/** The service of a pasted key, or why it cannot be used. */
export function detectService(key: string): ApiService | "subscription_token" | null {
  const k = key.trim();
  if (/^sk-ant-oat/i.test(k)) return "subscription_token";
  if (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) return "anthropic";
  if (/^sk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}$/.test(k)) return "openai";
  return null;
}

export class Providers {
  readonly chatgpt: OpenAiRunner;
  readonly openaiKey: OpenAiRunner;
  readonly anthropic: AnthropicRunner;

  constructor(
    readonly claude: AssistantRunner,
    private readonly deps: { vault: AiVault; auth: ChatGptAuth; settings: () => Settings; fetch?: Fetch; verifyKey?: (service: ApiService, key: string) => Promise<KeyCheck> },
  ) {
    this.chatgpt = new OpenAiRunner("chatgpt", deps);
    this.openaiKey = new OpenAiRunner("key", deps);
    this.anthropic = new AnthropicRunner(deps);
  }

  async pick(settings: Settings): Promise<Picked> {
    if (settings.provider === "chatgpt") return { provider: "chatgpt", runner: this.chatgpt, assistant: "ChatGPT", family: "openai" };
    if (settings.provider === "api") {
      await this.deps.vault.ready();
      return this.deps.vault.read().apiKey?.service === "openai"
        ? { provider: "api", runner: this.openaiKey, assistant: "GPT", family: "openai" }
        : { provider: "api", runner: this.anthropic, assistant: "Claude", family: "claude" };
    }
    return { provider: "claude", runner: this.claude, assistant: "Claude", family: "claude" };
  }

  async status(settings: Settings, force = false): Promise<AiStatus> {
    const p = await this.pick(settings);
    return { ...(await p.runner.status(force)), provider: p.provider, assistant: p.assistant, family: p.family };
  }

  /** What is set up for each service, for Settings. */
  async overview(settings: Settings): Promise<AiProviders> {
    await this.deps.vault.ready();
    const key = this.deps.vault.read().apiKey;
    return { current: settings.provider, claude: await this.claude.status(), chatgpt: this.deps.auth.account(), apiKey: key ? { service: key.service } : null };
  }

  /** The models of the service in use, when it has a list to choose from (ChatGPT, OpenAI key). */
  async models(settings: Settings): Promise<{ id: string; label: string }[]> {
    const p = await this.pick(settings);
    return p.runner instanceof OpenAiRunner ? p.runner.listModels(true) : [];
  }

  /** Checks a key with a free call: the model list. */
  async verifyKey(service: ApiService, key: string): Promise<KeyCheck> {
    if (this.deps.verifyKey) return this.deps.verifyKey(service, key);
    const fetchFn = this.deps.fetch ?? fetch;
    try {
      if (service === "anthropic") {
        await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15_000, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) }).models.list({ limit: 1 });
        return "ok";
      }
      const res = await fetchFn(`${OPENAI_API}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 401 || res.status === 403) return "rejected";
      return res.ok ? "ok" : "unreachable";
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return "rejected";
      return "unreachable";
    }
  }
}
