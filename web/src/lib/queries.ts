import type { DocKind, KpiKey, OfferStatus, Status } from "@shared/types";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { ApiError, api } from "./api";

export const useBootstrap = () => useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap, staleTime: 30_000 });
export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: api.settings });
export const useDashboard = () => useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard, refetchInterval: 60_000 });
export const usePerformance = (days: "7" | "30" | "90" | "all") => useQuery({ queryKey: ["performance", days], queryFn: () => api.performance(days) });
export const useKpi = (key: KpiKey | null) => useQuery({ queryKey: ["dashboard", key], queryFn: () => api.kpi(key!), enabled: Boolean(key) });
export const useOffers = (f: { status?: OfferStatus | "all"; q?: string; minScore?: number }) => useQuery({ queryKey: ["offers", f], queryFn: () => api.offers(f) });
export const useOffer = (id: string | null) => useQuery({ queryKey: ["offer", id], queryFn: () => api.offer(id!), enabled: Boolean(id) });
export const useApplications = (f: { status?: Status; q?: string } = {}) => useQuery({ queryKey: ["applications", f], queryFn: () => api.applications(f) });
export const useApplication = (id: string | null) => useQuery({ queryKey: ["application", id], queryFn: () => api.application(id!), enabled: Boolean(id) });
export const useDocuments = (f: { kind?: DocKind; q?: string } = {}) => useQuery({ queryKey: ["documents", f], queryFn: () => api.documents(f) });
export const useMails = (f: { q?: string; unassigned?: boolean }) => useQuery({ queryKey: ["mails", f], queryFn: () => api.mails(f) });
export const useGmail = () => useQuery({ queryKey: ["gmail"], queryFn: api.gmailStatus });
export const useMailReviews = () => useQuery({ queryKey: ["mail-reviews"], queryFn: api.mailReviews });
export const useHistory = (f: { applicationId?: string; offerId?: string; limit?: number } = {}) => useQuery({ queryKey: ["history", f], queryFn: () => api.history(f) });
export const useBackups = () => useQuery({ queryKey: ["backups"], queryFn: api.backups });
export const useAiStatus = () => useQuery({ queryKey: ["ai-status"], queryFn: () => api.aiStatus(), staleTime: 5 * 60_000, refetchOnWindowFocus: false });
export const useConnectors = (enabled: boolean) => useQuery({ queryKey: ["connectors"], queryFn: () => api.connectors(), enabled, staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false });
export const useSearchSources = () => useQuery({ queryKey: ["search-sources"], queryFn: api.searchSources });
export const useAiProviders = () => useQuery({ queryKey: ["ai-providers"], queryFn: api.aiProviders, staleTime: 30_000 });
export const useConversation = () => useQuery({ queryKey: ["conversation"], queryFn: api.conversation });

/** After any change: everything is local and small, so all lists are simply read again. */
export const refreshAll = (qc: QueryClient) => qc.invalidateQueries({ predicate: (q) => !["ai-status", "conversation", "connectors", "ai-providers"].includes(String(q.queryKey[0])) });

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Une erreur est survenue.";
}
