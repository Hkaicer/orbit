// Interface state: the current page and selection, kept in the address (#/offres/of_123)
// so that the back button and a refresh keep their place.

import type { AssistantTask, ModelChoice, RequestMode } from "@shared/types";
import { create } from "zustand";

export type View = "dashboard" | "offers" | "applications" | "performance" | "documents" | "mail" | "history" | "settings";

const SLUGS: Record<View, string> = {
  dashboard: "accueil",
  offers: "offres",
  applications: "candidatures",
  performance: "performance",
  documents: "documents",
  mail: "gmail",
  history: "historique",
  settings: "reglages",
};

export interface Route {
  view: View;
  id: string | null;
}

export function routeFromHash(hash = window.location.hash): Route {
  const [slug, id] = hash.replace(/^#\/?/, "").split("/");
  const view = (Object.keys(SLUGS) as View[]).find((v) => SLUGS[v] === slug) ?? "dashboard";
  return { view, id: id ? decodeURIComponent(id) : null };
}

const hashOf = (r: Route) => `#/${SLUGS[r.view]}${r.id ? `/${encodeURIComponent(r.id)}` : ""}`;

interface UiState extends Route {
  assistantOpen: boolean;
  sidebarOpen: boolean;
  /** Mode and model of the next request to the assistant; both start from the settings. */
  mode: RequestMode | null;
  model: ModelChoice | null;
  /** A task waiting to be sent by the assistant (discovery). */
  task: AssistantTask | null;
  /** Text waiting in the assistant's composer (set by "ask Claude" buttons). */
  draft: string;
  importOpen: boolean;
  go: (view: View, id?: string | null) => void;
  set: (p: Partial<UiState>) => void;
  ask: (text: string) => void;
  startTask: (task: AssistantTask) => void;
}

const initial = routeFromHash();

export const useUi = create<UiState>((set, get) => ({
  ...initial,
  assistantOpen: (() => {
    try {
      return localStorage.getItem("orbit.assistant") === "1";
    } catch {
      return false;
    }
  })(),
  sidebarOpen: false,
  mode: null,
  model: null,
  task: null,
  draft: "",
  importOpen: false,
  go: (view, id = null) => {
    const r = { view, id };
    if (hashOf(r) !== window.location.hash) window.history.pushState(null, "", hashOf(r));
    set({ ...r, sidebarOpen: false });
    document.querySelector(".view-body")?.scrollTo({ top: 0 });
  },
  set: (p) => {
    if (p.assistantOpen !== undefined) {
      try {
        localStorage.setItem("orbit.assistant", p.assistantOpen ? "1" : "0");
      } catch {
        /* the preference is only a convenience */
      }
    }
    set(p);
  },
  ask: (text) => get().set({ assistantOpen: true, draft: text }),
  startTask: (task) => get().set({ assistantOpen: true, task }),
}));
