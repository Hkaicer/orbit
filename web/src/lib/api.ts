// Thin client for ORBIT's local API. Every call stays on this computer.

import type {
  AiProviders,
  AiStatus,
  ApiService,
  Analysis,
  Application,
  ApplicationDetail,
  AssistantTask,
  ChatMessage,
  ConnectorInfo,
  Dashboard,
  Deadline,
  DocKind,
  GmailStatus,
  HistoryEvent,
  JobsPerformance,
  KpiDetails,
  KpiKey,
  LibraryDocument,
  MailItem,
  Mode,
  ModelChoice,
  Offer,
  OfferStatus,
  PendingAction,
  Proposal,
  ProviderId,
  RequestMode,
  Status,
  StreamEvent as ServerEvent,
} from "@shared/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, "network", "ORBIT ne répond pas : le serveur est peut-être arrêté.");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? `Erreur ${res.status}.`);
  }
  return data as T;
}

const get = <T>(url: string) => request<T>("GET", url);
const post = <T>(url: string, body: unknown = {}) => request<T>("POST", url, body);
const patch = <T>(url: string, body: unknown) => request<T>("PATCH", url, body);
const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export interface Settings {
  profile: string;
  scoring: string;
  provider: ProviderId;
  chatgptModel: string;
  openaiModel: string;
  apiConsentAt: string | null;
  model: ModelChoice;
  effort: "low" | "medium" | "high" | "xhigh";
  defaultMode: RequestMode;
  claudePath: string;
  timeoutSec: number;
  documentRoots: string[];
  trackingFiles: string[];
  privatePatterns: string[];
  mailLookbackDays: number;
  followupAfterDays: number;
  mailLastSyncAt: string | null;
  cvGenerator: string;
  soffice: string;
  contact: { name: string; phone: string; email: string; city: string; signature: string };
  writingRules: string;
  indeedConnector: boolean;
  autoDocuments: boolean;
  setupDone: boolean;
  theme: "system" | "light" | "dark";
  alertKeywords: string[];
  alertExclude: string[];
}

/** A file ORBIT made (CV, letter), downloaded by the browser into the Downloads folder. */
export const downloadUrl = (path: string) => `/api/files/download?path=${encodeURIComponent(path)}`;

export interface Bootstrap {
  settings: Settings;
  version: string;
  dataDir: string;
  applicationsDir: string;
  documents: number;
  applications: number;
  /** A new install: the welcome screen is shown. */
  firstRun: boolean;
}

export type OfferInput = Partial<Pick<Offer, "location" | "contract" | "duration" | "startDate" | "reference" | "url" | "language">> & {
  company: string;
  title: string;
  description?: string;
  source?: string;
};

export type FromUrlResult =
  | { status: "created" | "known"; offer: Offer; changes: string[] }
  | { status: "needs_text" | "not_found"; message: string }
  | { status: "needs_ai"; title: string | null; text: string; url: string; message: string };

export interface IndexResult {
  indexed: number;
  unchanged: number;
  removed: number;
  errors: { path: string; error: string }[];
  roots: { root: string; files: number; missing: boolean }[];
}

export interface ImportReport {
  file: string;
  missing: boolean;
  offersCreated: number;
  offersKnown: number;
  applicationsCreated: number;
  skipped: string[];
}

export interface SyncResult {
  scanned: number;
  newMails: number;
  matched: number;
  proposals: number;
  unassigned: number;
  alertOffers: number;
  alertKnown: number;
  alertSkipped: number;
}

export const api = {
  bootstrap: () => get<Bootstrap>("/api/bootstrap"),
  settings: () => get<Settings>("/api/settings"),
  saveSettings: (p: Partial<Settings>) => patch<Settings>("/api/settings", p),
  dashboard: () => get<Dashboard>("/api/dashboard"),
  kpi: (key: KpiKey) => get<KpiDetails>(`/api/dashboard/${key}`),
  performance: (days: "7" | "30" | "90" | "all") => get<JobsPerformance>(`/api/performance?days=${days}`),
  history: (f: { applicationId?: string; offerId?: string; limit?: number } = {}) => get<HistoryEvent[]>(`/api/history${qs(f)}`),

  offers: (f: { status?: OfferStatus | "all"; q?: string; minScore?: number } = {}) => get<Offer[]>(`/api/offers${qs(f)}`),
  offer: (id: string) => get<Offer>(`/api/offers/${id}`),
  createOffer: (o: OfferInput) => post<{ offer: Offer; created: boolean; changes: string[] }>("/api/offers", o),
  updateOffer: (id: string, p: Partial<OfferInput>) => patch<Offer>(`/api/offers/${id}`, p),
  offerStatus: (id: string, status: OfferStatus) => post<Offer>(`/api/offers/${id}/status`, { status }),
  resolveSimilar: (id: string, decision: "distinct" | "merge") => post<{ offer: Offer }>(`/api/offers/${id}/similar`, { decision }),
  localScore: (id: string) => post<Offer>(`/api/offers/${id}/local-score`),
  fromUrl: (url: string) => post<FromUrlResult>("/api/offers/from-url", { url }),
  startApplication: (offerId: string, mode?: Mode) => post<Application>(`/api/offers/${offerId}/application`, mode ? { mode } : {}),

  applications: (f: { status?: Status; q?: string } = {}) => get<Application[]>(`/api/applications${qs(f)}`),
  application: (id: string) => get<ApplicationDetail>(`/api/applications/${id}`),
  updateApplication: (id: string, p: { nextAction?: string | null; nextActionDue?: string | null; cvPath?: string | null; letterPath?: string | null }) =>
    patch<Application>(`/api/applications/${id}`, p),
  setStatus: (id: string, status: Status, note?: string) => post<Application>(`/api/applications/${id}/status`, { status, ...(note ? { note } : {}) }),
  setMode: (id: string, mode: Mode) => post<Application>(`/api/applications/${id}/mode`, { mode }),
  addNote: (id: string, text: string) => post<{ ok: true }>(`/api/applications/${id}/notes`, { text }),
  addDeadline: (id: string, d: { kind: Deadline["kind"]; title: string; dueAt?: string | null }) => post<Deadline>(`/api/applications/${id}/deadlines`, d),
  deadlineStatus: (id: string, status: Deadline["status"]) => post<Deadline>(`/api/deadlines/${id}`, { status }),
  writeFolder: (id: string) => post<{ folder: string; written: string[] }>(`/api/applications/${id}/folder`),
  confirmEvidence: (id: string, status?: Status) => post<Application>(`/api/evidence/${id}/confirm`, status ? { status } : {}),
  dismissEvidence: (id: string) => post<{ ok: true }>(`/api/evidence/${id}/dismiss`),
  decideAction: (id: string, decision: "approved" | "rejected" | "done") => post<PendingAction>(`/api/actions/${id}`, { decision }),
  open: (path: string) => post<{ opened: string }>("/api/open", { path }),

  documents: (f: { kind?: DocKind; q?: string } = {}) => get<LibraryDocument[]>(`/api/documents${qs(f)}`),
  documentText: (id: string) => get<{ text: string }>(`/api/documents/${id}/text`),
  documentFlags: (id: string, p: { validated?: boolean; private?: boolean }) => patch<LibraryDocument>(`/api/documents/${id}`, p),
  reindex: () => post<IndexResult>("/api/documents/reindex"),
  importTracking: () => post<ImportReport[]>("/api/import"),

  gmailStatus: () => get<GmailStatus>("/api/gmail/status"),
  gmailConnect: (email: string, password: string) => post<GmailStatus>("/api/gmail/connect", { email, password }),
  gmailDisconnect: () => post<GmailStatus>("/api/gmail/disconnect"),
  gmailSync: () => post<SyncResult>("/api/gmail/sync"),
  mails: (f: { q?: string; unassigned?: boolean } = {}) => get<MailItem[]>(`/api/mails${qs({ q: f.q, unassigned: f.unassigned ? "1" : undefined })}`),
  attachMail: (id: string, applicationId: string) => post<{ ok: true }>(`/api/mails/${id}/attach`, { applicationId }),

  backups: () => get<{ name: string; size: number }[]>("/api/backups"),
  backup: () => post<{ name: string }>("/api/backups"),

  connectors: (force = false) => get<{ items: ConnectorInfo[]; checkedAt: string | null }>(`/api/ai/connectors${force ? "?force=1" : ""}`),
  aiProviders: () => get<AiProviders>("/api/ai/providers"),
  aiModels: () => get<{ id: string; label: string }[]>("/api/ai/models"),
  saveApiKey: (key: string) => post<{ service: ApiService }>("/api/ai/key", { key, consent: true }),
  deleteApiKey: () => request<{ removed: boolean }>("DELETE", "/api/ai/key"),
  chatgptLogin: () => post<{ url: string }>("/api/ai/chatgpt/login"),
  chatgptLogout: () => post<{ revoked: boolean }>("/api/ai/chatgpt/logout"),
  aiStatus: (force = false) => get<AiStatus>(`/api/ai/status${force ? "?force=1" : ""}`),
  conversation: () => get<{ messages: ChatMessage[]; proposals: Proposal[]; busy: boolean }>("/api/ai/conversation"),
  clearConversation: () => request<{ ok: true }>("DELETE", "/api/ai/conversation"),
  cancel: () => post<{ cancelled: boolean }>("/api/ai/cancel"),
  applyProposal: (id: string) => post<{ applied: string[] }>(`/api/proposals/${id}/apply`),
  discardProposal: (id: string) => post<{ ok: true }>(`/api/proposals/${id}/discard`),
};

export type StreamEvent = ServerEvent | { type: "fatal"; message: string };

/** Send a request to the assistant and read its answer as it comes (one JSON event per line). */
export async function streamChat(body: { message: string; mode: RequestMode; model: ModelChoice; task?: AssistantTask }, onEvent: (e: StreamEvent) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    onEvent({ type: "fatal", message: "ORBIT ne répond pas : le serveur est peut-être arrêté." });
    return;
  }
  if (!res.ok || !res.body) {
    let message = `Erreur ${res.status}.`;
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* keep the generic message */
    }
    onEvent({ type: "fatal", message });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as StreamEvent);
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as StreamEvent);
}

export type { Analysis };
