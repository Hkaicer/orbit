// What every AI service behind the assistant offers ORBIT: its state, and one
// request run with ORBIT's tools. Claude Code (Claude plan), ChatGPT (ChatGPT
// plan) and an API key (Anthropic or OpenAI) each implement it.

import type { ChatImage, ConnectorInfo, RunnerStatus } from "../../shared/types";
import type { RunContext } from "./tools";

export class AssistantError extends Error {
  constructor(
    readonly code: "unavailable" | "rate_limit" | "auth" | "timeout" | "cancelled" | "network" | "missing_key" | "billing" | "model_unavailable" | "refused" | "invalid_output" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "AssistantError";
  }
}

export interface RunRequest {
  system: string;
  prompt: string;
  /** haiku, sonnet or opus: a Claude model family, or for OpenAI models how much reasoning to ask for. */
  model: string;
  effort: string | null;
  token: string;
  timeoutMs: number;
  signal: AbortSignal;
  onEvent: (e: { type: "text"; delta: string } | { type: "status"; text: string }) => void;
  /** claude.ai connectors allowed for this request (Claude Code only), e.g. mcp__claude_ai_Indeed. */
  connectors?: string[];
  /** Images the user attached to this request (screenshots, photos). */
  images?: ChatImage[];
  /** The request's tools, for the services ORBIT calls itself (Claude Code reaches them through the MCP bridge). */
  run?: RunContext;
}

export interface RunResult {
  text: string;
  model: string | null;
}

export interface AssistantRunner {
  status(force?: boolean): Promise<RunnerStatus>;
  run(req: RunRequest): Promise<RunResult>;
  /** The claude.ai connectors of the account (Claude Code only). */
  connectors?(force?: boolean): Promise<ConnectorInfo[]>;
}

/** How long a tool loop may go before the request is stopped. */
export const MAX_STEPS = 40;
