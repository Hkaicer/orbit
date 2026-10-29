import { useQueryClient } from "@tanstack/react-query";
import { Briefcase, ChartColumnIncreasing, FileText, History, LayoutDashboard, Mail, Moon, Plus, Settings, Sparkles, SquareKanban, Sun } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { relative } from "../lib/format";
import { applyTheme, isDark } from "../lib/theme";
import { toast } from "../lib/toast";
import { useAiStatus, useDashboard, useGmail, useSettings } from "../lib/queries";
import { useUi, type View } from "../lib/store";

const NAV: { view: View; icon: ReactNode; label: string }[] = [
  { view: "dashboard", icon: <LayoutDashboard />, label: "Tableau de bord" },
  { view: "offers", icon: <Briefcase />, label: "Offres" },
  { view: "applications", icon: <SquareKanban />, label: "Candidatures" },
  { view: "performance", icon: <ChartColumnIncreasing />, label: "Performance" },
  { view: "documents", icon: <FileText />, label: "Documents" },
  { view: "mail", icon: <Mail />, label: "Gmail" },
  { view: "history", icon: <History />, label: "Historique" },
];

const RING = "M5 32a27 21 0 1 0 54 0a27 21 0 1 0-54 0ZM13.6 31.4a21 15.5 0 1 0 42 0a21 15.5 0 1 0-42 0Z";

/** The ORBIT ring. Its colors come from the theme (--orbit-*), so it reads on light and dark. */
export function OrbitMark({ size = 22 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="orbit-mark">
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: "var(--orbit-1)" }} />
          <stop offset="1" style={{ stopColor: "var(--orbit-2)" }} />
        </linearGradient>
        <linearGradient id={`${id}h`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--orbit-hi)", stopOpacity: 0.95 }} />
          <stop offset="0.32" style={{ stopColor: "var(--orbit-hi)", stopOpacity: 0 }} />
          <stop offset="0.66" style={{ stopColor: "var(--orbit-hi)", stopOpacity: 0 }} />
          <stop offset="1" style={{ stopColor: "var(--orbit-hi)", stopOpacity: 0.85 }} />
        </linearGradient>
      </defs>
      <g transform="rotate(-30 32 32)">
        <path d={RING} fillRule="evenodd" fill={`url(#${id}b)`} />
        <path d={RING} fillRule="evenodd" fill={`url(#${id}h)`} />
      </g>
    </svg>
  );
}

/** Switches between light and dark at once (the choice "system" is in Settings, Apparence). */
function ThemeToggle() {
  const qc = useQueryClient();
  const theme = useSettings().data?.theme;
  const [dark, setDark] = useState(isDark);
  // Follow a choice made in Settings, and the system when the theme is "system".
  useEffect(() => {
    setDark(isDark());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(isDark());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);
  const toggle = async () => {
    const next = dark ? "light" : "dark";
    applyTheme(next);
    setDark(!dark);
    try {
      await api.saveSettings({ theme: next });
      await qc.invalidateQueries({ queryKey: ["settings"] });
      await qc.invalidateQueries({ queryKey: ["bootstrap"] });
    } catch {
      toast.error("Le thème n'a pas pu être enregistré.");
    }
  };
  const label = dark ? "Passer en mode clair" : "Passer en mode sombre";
  return (
    <button type="button" className="sb-theme" onClick={() => void toggle()} aria-label={label} data-tip={label} data-tip-pos="right">
      {dark ? <Sun /> : <Moon />}
    </button>
  );
}

export function Sidebar() {
  const ui = useUi();
  const dash = useDashboard();
  const ai = useAiStatus();
  const gmail = useGmail();
  const d = dash.data;
  const counts: Partial<Record<View, number>> = {
    dashboard: d ? d.priorities.length || undefined : undefined,
    offers: d?.counts.newOffers || undefined,
    applications: d?.counts.active || undefined,
    mail: d ? d.confirmations.filter((c) => c.evidence.kind === "email").length || undefined : undefined,
  };
  const aiState = ai.data?.state;
  const g = gmail.data;

  return (
    <aside className={`sidebar ${ui.sidebarOpen ? "is-open" : ""}`} aria-label="Navigation">
      <div className="sb-brand">
        <OrbitMark />
        <span className="sb-name">ORBIT</span>
      </div>

      <div className="sb-actions">
        <button type="button" className="sb-primary" onClick={() => ui.set({ importOpen: true })}>
          <Plus />
          <span>Ajouter une offre</span>
        </button>
      </div>

      <button type="button" className={`sb-ask ${ui.assistantOpen ? "is-active" : ""}`} onClick={() => ui.set({ assistantOpen: !ui.assistantOpen })} aria-pressed={ui.assistantOpen}>
        <Sparkles />
        <span>Assistant</span>
        <span className={`sb-ai-dot is-${aiState === "ready" ? "ready" : aiState ? "warn" : "checking"}`} />
      </button>

      <nav className="sb-nav">
        {NAV.map((n) => (
          <button key={n.view} type="button" className={`sb-item ${ui.view === n.view ? "is-active" : ""}`} aria-current={ui.view === n.view ? "page" : undefined} onClick={() => ui.go(n.view)}>
            {n.icon}
            <span className="truncate">{n.label}</span>
            {counts[n.view] !== undefined && <span className="sb-count tnum">{counts[n.view]}</span>}
          </button>
        ))}
      </nav>

      <div className="sb-footer">
        <button type="button" className="sb-progress" onClick={() => ui.go("mail")}>
          <span className={`sb-mail-dot ${g?.email ? "is-on" : ""}`} />
          <div className="sb-progress-text">
            <span className="sb-progress-title">{g?.email ? "Gmail en lecture seule" : "Gmail non connecté"}</span>
            <span className="truncate">{g?.email ? (g.lastSyncAt ? `Lu ${relative(g.lastSyncAt)}` : "Jamais lu") : "Connecter"}</span>
          </div>
        </button>
        <div className="sb-footer-row">
          <button type="button" className={`sb-item ${ui.view === "settings" ? "is-active" : ""}`} aria-current={ui.view === "settings" ? "page" : undefined} onClick={() => ui.go("settings")}>
            <Settings />
            <span>Réglages</span>
          </button>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
