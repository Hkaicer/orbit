// Types shared by the server and the interface.

/** The thirteen steps of an application. "sent" and "test_done" need proof or the user's confirmation. */
export const STATUSES = [
  "prepared",
  "validated",
  "sent",
  "received",
  "interview_proposed",
  "interview_confirmed",
  "test_todo",
  "test_done",
  "waiting",
  "followup",
  "refused",
  "offer",
  "closed",
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  prepared: "Préparée",
  validated: "Validée par moi",
  sent: "Envoyée",
  received: "Réception confirmée",
  interview_proposed: "Entretien proposé",
  interview_confirmed: "Entretien confirmé",
  test_todo: "Test à faire",
  test_done: "Test effectué",
  waiting: "En attente de réponse",
  followup: "Relance à envisager",
  refused: "Refus",
  offer: "Offre reçue",
  closed: "Clôturée",
};

/** Columns of the pipeline. */
export const PHASES: { id: string; label: string; statuses: Status[] }[] = [
  { id: "prep", label: "En préparation", statuses: ["prepared", "validated"] },
  { id: "sent", label: "Envoyées", statuses: ["sent", "received", "waiting", "followup"] },
  { id: "steps", label: "Tests et entretiens", statuses: ["test_todo", "test_done", "interview_proposed", "interview_confirmed"] },
  { id: "end", label: "Résultat", statuses: ["offer", "refused", "closed"] },
];

/** Statuses that say something happened outside: never set without proof or the user's confirmation. */
export const PROOF_STATUSES: Status[] = ["sent", "received", "interview_proposed", "interview_confirmed", "test_done", "refused", "offer"];

/**
 * A: every change is prepared, then validated by the user.
 * B: local steps are done automatically; anything external waits for the user.
 * C: as many steps as possible are chained; anything external still waits for the user.
 */
export type Mode = "A" | "B" | "C";

export const MODE_LABELS: Record<Mode, string> = {
  A: "A · je valide chaque étape",
  B: "B · étapes locales automatiques",
  C: "C · automatisation maximale",
};

/** The mode asked for a request to the assistant: one of the three, or auto, where Claude picks it from the request. */
export type RequestMode = Mode | "auto";

export type ModelChoice = "haiku" | "sonnet" | "opus";

/** A special request: discovery reads the documents and writes the first profile, nothing else. */
export type AssistantTask = "discovery";

/** A claude.ai connector of the account, as Claude Code sees it. */
export interface ConnectorInfo {
  name: string;
  /** Tool prefix in Claude Code, e.g. mcp__claude_ai_Indeed. */
  prefix: string;
  status: "connected" | "needs_auth" | "failed";
}

export const MODEL_LABELS: Record<ModelChoice, string> = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };

/** With an OpenAI model (ChatGPT or an OpenAI key) there is one model: the choice sets how much it reasons. */
export const REASONING_LABELS: Record<ModelChoice, string> = { haiku: "Rapide", sonnet: "Équilibré", opus: "Approfondi" };

export type OfferStatus = "new" | "kept" | "ignored";

export interface Analysis {
  /** Profile fit only, out of 100: skills /45, education and level /20, experience and missions /35. */
  score: number;
  breakdown: { skills: number; education: number; experience: number };
  verdict: "priority" | "apply" | "check" | "skip";
  pros: string[];
  gaps: string[];
  /** Mandatory criteria still to check (diplomas, languages, eligibility...). */
  toVerify: string[];
  highlight: string[];
  cvAdjustments: string[];
  nextActions: string[];
  /** Practical points kept apart from the score so that a major incompatibility is never hidden. */
  practical: { label: string; severity: "info" | "warning" | "blocking" }[];
  facts: { verified: string[]; inferred: string[]; missing: string[] };
  /** "claude" for a full analysis, "local" for the keyword estimate made without the AI. */
  by: "claude" | "local" | "import";
  model?: string | null;
  at: string;
}

export interface OfferSource {
  id: string;
  source: string;
  url: string | null;
  seenAt: string;
  note: string | null;
}

export interface Offer {
  id: string;
  company: string;
  title: string;
  location: string | null;
  contract: string | null;
  duration: string | null;
  startDate: string | null;
  reference: string | null;
  url: string | null;
  source: string;
  language: string | null;
  description: string;
  status: OfferStatus;
  score: number | null;
  analysis: Analysis | null;
  /** Original analysis text when imported (OFFRE.md). */
  analysisMd: string | null;
  missing: string[];
  discoveredAt: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sources: OfferSource[];
  applicationId: string | null;
  /** Status of the application, when there is one. */
  applicationStatus: Status | null;
  /** A probable duplicate found on import: the other offer, for the user to decide. */
  similarTo: { id: string; company: string; title: string } | null;
}

export interface Evidence {
  id: string;
  applicationId: string;
  kind: "email" | "user" | "import" | "file" | "agent";
  messageId: string | null;
  mailDate: string | null;
  mailFrom: string | null;
  mailSubject: string | null;
  excerpt: string | null;
  /** What the evidence suggests (a status). */
  suggests: Status | null;
  /** A date found in the message (test or interview deadline), to check. */
  dueAt: string | null;
  confirmed: boolean;
  createdAt: string;
}

export interface Deadline {
  id: string;
  applicationId: string;
  kind: "test" | "interview" | "followup" | "deadline";
  title: string;
  dueAt: string | null;
  status: "todo" | "done" | "cancelled";
  evidenceId: string | null;
  createdAt: string;
}

export interface HistoryEvent {
  id: string;
  applicationId: string | null;
  offerId: string | null;
  at: string;
  actor: "user" | "agent" | "system" | "gmail" | "import";
  kind: string;
  summary: string;
  details: Record<string, unknown> | null;
}

export interface Application {
  id: string;
  offerId: string;
  offer: Pick<Offer, "company" | "title" | "location" | "contract" | "url" | "score" | "reference">;
  status: Status;
  mode: Mode;
  /** Folder made by ORBIT. */
  folder: string | null;
  /** Folder it came from (read only, never modified). */
  sourceFolder: string | null;
  cvPath: string | null;
  letterPath: string | null;
  sentAt: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FolderFile {
  name: string;
  path: string;
  size: number;
  mtime: string;
}

export interface ApplicationDetail extends Application {
  offerFull: Offer;
  evidence: Evidence[];
  deadlines: Deadline[];
  history: HistoryEvent[];
  mails: MailItem[];
  pendingActions: PendingAction[];
  /** CVs and letters in the application's ORBIT folder (given by the HTTP API). */
  files?: FolderFile[];
}

export type DocKind = "cv" | "letter" | "offer" | "generator" | "tracking" | "other";

export interface LibraryDocument {
  id: string;
  path: string;
  root: string;
  name: string;
  ext: string;
  kind: DocKind;
  family: string | null;
  language: string | null;
  company: string | null;
  size: number;
  mtime: string;
  sha256: string;
  status: "master" | "adapted" | "draft" | "unknown";
  /** Why the status was given: signals found, never the file name alone. */
  signals: string[];
  validated: boolean;
  private: boolean;
  /** Files with exactly the same content. */
  duplicates: string[];
  /** The same document in the other format (docx and pdf). */
  pairPath: string | null;
  hasText: boolean;
  indexedAt: string;
}

export type MailCategory = "ack" | "refusal" | "interview" | "test" | "test_done" | "offer" | "followup" | "alert" | "other";

export interface MailItem {
  id: string;
  date: string;
  from: string;
  subject: string;
  snippet: string;
  category: MailCategory;
  applicationId: string | null;
  link: string | null;
}

export interface PendingAction {
  id: string;
  applicationId: string | null;
  kind: string;
  /** Exactly what would be done, where, with which documents and data. */
  description: string;
  details: Record<string, unknown> | null;
  status: "pending" | "approved" | "rejected" | "done";
  createdAt: string;
  decidedAt: string | null;
}

export interface Confirmation {
  evidence: Evidence;
  application: Pick<Application, "id" | "status" | "offer">;
}

export const KPI_KEYS = ["newOffers", "active", "waiting", "tests", "interviews", "noAnswer"] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

/** One offer or application behind a dashboard number. */
export interface KpiItem {
  type: "offer" | "application";
  id: string;
  company: string;
  title: string;
  status: Status | null;
  score: number | null;
  /** The date that matters for this number, and what it is. */
  date: string | null;
  dateKind: "found" | "updated" | "sent" | "due" | null;
  detail: string | null;
  /** A point to notice (a blocking practical point, a late date...). */
  flag: string | null;
}

export interface KpiDetails {
  key: KpiKey;
  title: string;
  /** Exactly what is counted, in plain words. */
  rule: string;
  items: KpiItem[];
  /** How many items per status, when they differ. */
  breakdown: { status: Status; count: number }[];
}

export interface JobsPerformance {
  /** null: since the beginning. */
  days: number | null;
  since: string | null;
  bucket: "day" | "week";
  tiles: {
    offers: number;
    created: number;
    sent: number;
    /** Applications that had an answer from the company (not an acknowledgment) in the period. */
    answers: number;
    /** Share of the applications sent in the period that had an answer. */
    responseRate: number | null;
    steps: number;
    offersReceived: number;
    /** Days from sending to the first answer, on average. */
    avgDelay: number | null;
    previous: { offers: number; sent: number; answers: number; responseRate: number | null } | null;
  };
  series: { start: string; offers: number; sent: number }[];
  funnel: { key: string; label: string; value: number }[];
  sources: { label: string; value: number }[];
  replies: { category: MailCategory; value: number }[];
  phases: { id: string; label: string; value: number }[];
  assistant: { requests: number; proposalsApplied: number; proposalsDiscarded: number; offersAdded: number; analyses: number; documents: number; statusProposals: number };
}

export interface Dashboard {
  counts: Record<KpiKey, number>;
  priorities: { kind: string; title: string; detail: string; due: string | null; applicationId: string | null; offerId: string | null }[];
  upcoming: (Deadline & { company: string; offerTitle: string })[];
  confirmations: Confirmation[];
  pendingActions: PendingAction[];
}

export interface GmailStatus {
  email: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  protectedBy: "dpapi" | "none";
}

/** The AI service behind the assistant: the Claude plan (Claude Code), the ChatGPT plan, or an API key. */
export type ProviderId = "claude" | "chatgpt" | "api";

export type ApiService = "anthropic" | "openai";

/** The state of one service, as the service itself reports it. */
export interface RunnerStatus {
  state: "ready" | "not_installed" | "not_logged_in" | "api_key_auth" | "missing_key" | "needs_consent" | "error";
  message: string;
  plan: string | null;
  version: string | null;
  /** The one model used with ChatGPT or an OpenAI key, and the ones to choose from. */
  model?: string | null;
  models?: { id: string; label: string }[];
}

/** The state of the assistant: the service in use, who answers, and how its models are named. */
export interface AiStatus extends RunnerStatus {
  provider: ProviderId;
  /** Claude, ChatGPT or GPT. */
  assistant: string;
  /** claude: Haiku, Sonnet and Opus. openai: one model, with more or less reasoning. */
  family: "claude" | "openai";
}

/** What is set up for each service, shown in Settings. */
export interface AiProviders {
  current: ProviderId;
  claude: RunnerStatus;
  chatgpt: { email: string | null; planUsage: boolean } | null;
  apiKey: { service: ApiService } | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta: {
    mode?: Mode;
    /** The mode was chosen by the assistant (auto). */
    auto?: boolean;
    model?: string;
    provider?: ProviderId;
    status?: "ok" | "error";
    proposalId?: string;
    tools?: { name: string; ok: boolean }[];
    durationMs?: number;
    /** Files made during the request (CV, letter), to download. */
    files?: { name: string; path: string }[];
  };
  createdAt: string;
}

export interface Proposal {
  id: string;
  messageId: string | null;
  status: "pending" | "applied" | "discarded";
  ops: { tool: string; summary: string }[];
  createdAt: string;
}

export type StreamEvent =
  | { type: "accepted"; message: ChatMessage }
  | { type: "status"; text: string }
  | { type: "tool"; name: string; ok: boolean }
  | { type: "text"; delta: string }
  | { type: "done"; message: ChatMessage; proposal: Proposal | null }
  | { type: "error"; message: ChatMessage };
