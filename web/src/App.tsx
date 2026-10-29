import { useEffect } from "react";
import { AssistantPanel } from "./assistant/AssistantPanel";
import { ImportOfferDialog } from "./components/OfferDialogs";
import { Sidebar } from "./components/Sidebar";
import { ConfirmHost, Toaster } from "./components/ui";
import { useBootstrap } from "./lib/queries";
import { routeFromHash, useUi } from "./lib/store";
import { ApplicationsView } from "./views/ApplicationsView";
import { DashboardView } from "./views/DashboardView";
import { DocumentsView } from "./views/DocumentsView";
import { HistoryView } from "./views/HistoryView";
import { MailView } from "./views/MailView";
import { OffersView } from "./views/OffersView";
import { PerformanceView } from "./views/PerformanceView";
import { SettingsView } from "./views/SettingsView";
import { WelcomeView } from "./views/WelcomeView";

export function App() {
  const ui = useUi();
  const boot = useBootstrap();

  useEffect(() => {
    const onPop = () => useUi.setState(routeFromHash());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Heartbeat: a server started by the shortcut stops by itself once no window is open.
  useEffect(() => {
    const id = window.setInterval(() => void fetch("/api/health").catch(() => undefined), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        ui.set({ assistantOpen: !useUi.getState().assistantOpen });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui]);

  return (
    <div className="app">
      <Sidebar />
      <div className={`scrim ${ui.sidebarOpen ? "is-open" : ""}`} onClick={() => ui.set({ sidebarOpen: false })} aria-hidden />
      <main className="main">
        {boot.data?.firstRun && <WelcomeView />}
        {!boot.data?.firstRun && ui.view === "dashboard" && <DashboardView />}
        {!boot.data?.firstRun && ui.view === "offers" && <OffersView />}
        {!boot.data?.firstRun && ui.view === "applications" && <ApplicationsView />}
        {!boot.data?.firstRun && ui.view === "performance" && <PerformanceView />}
        {!boot.data?.firstRun && ui.view === "documents" && <DocumentsView />}
        {!boot.data?.firstRun && ui.view === "mail" && <MailView />}
        {!boot.data?.firstRun && ui.view === "history" && <HistoryView />}
        {!boot.data?.firstRun && ui.view === "settings" && <SettingsView />}
      </main>
      {ui.assistantOpen && <div className="assistant-scrim" onClick={() => ui.set({ assistantOpen: false })} aria-hidden />}
      {ui.assistantOpen && <AssistantPanel />}
      <ImportOfferDialog />
      <ConfirmHost />
      <Toaster />
    </div>
  );
}
