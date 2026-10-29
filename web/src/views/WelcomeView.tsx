// First start of a new install: where the documents are, which AI service
// answers, then the profile, written by the user or handed to the AI
// ("Découverte par l'IA"). Gmail stays optional, on its own page.

import { useQueryClient } from "@tanstack/react-query";
import { Check, FolderOpen, Mail, PenLine, RefreshCw, Sparkles } from "lucide-react";
import { OrbitMark } from "../components/Sidebar";
import { useEffect, useState, type ReactNode } from "react";
import { useAction } from "../components/bits";
import { Badge, Button, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useAiStatus, useBootstrap, useSettings } from "../lib/queries";
import { useUi } from "../lib/store";
import { startDiscovery } from "./SettingsView";

export function WelcomeView() {
  const ui = useUi();
  const qc = useQueryClient();
  const settings = useSettings();
  const boot = useBootstrap();
  const ai = useAiStatus();
  const { busy, run } = useAction();
  const [roots, setRoots] = useState("");
  useEffect(() => {
    if (settings.data) setRoots(settings.data.documentRoots.join("\n"));
  }, [settings.data]);

  const docs = boot.data?.documents ?? 0;
  const ready = ai.data?.state === "ready";

  /** The welcome screen is not shown again. */
  const finish = async () => {
    await api.saveSettings({ setupDone: true });
    await qc.invalidateQueries({ queryKey: ["bootstrap"] });
    await qc.invalidateQueries({ queryKey: ["settings"] });
  };

  const saveRoots = () =>
    run(
      "roots",
      async () => {
        await api.saveSettings({
          documentRoots: roots
            .split(/\r?\n/)
            .map((x) => x.trim())
            .filter(Boolean),
        });
        const r = await api.reindex();
        await qc.invalidateQueries({ queryKey: ["bootstrap"] });
        await qc.invalidateQueries({ queryKey: ["documents"] });
        return r;
      },
      (r) => `${r.indexed + r.unchanged} document${r.indexed + r.unchanged > 1 ? "s" : ""} trouvé${r.indexed + r.unchanged > 1 ? "s" : ""}.`,
    );

  return (
    <div className="view-body">
      <div className="view-inner view-inner-narrow welcome">
        <header className="welcome-head">
          <OrbitMark size={52} />
          <h1 className="welcome-title">Bienvenue dans ORBIT</h1>
          <p className="welcome-sub">Trois étapes pour commencer. Tout reste sur cet ordinateur, et rien n'est envoyé à une entreprise sans votre accord.</p>
        </header>

        <Step n={1} title="Vos documents" done={docs > 0} icon={<FolderOpen />}>
          <p className="text-2 small">Les dossiers où sont vos CV et vos lettres, un par ligne. Ils sont lus sans jamais être modifiés.</p>
          <textarea className="textarea mono" rows={3} aria-label="Dossiers de documents" placeholder="C:\Users\vous\Documents\CV" value={roots} onChange={(e) => setRoots(e.target.value)} />
          <div className="welcome-row">
            <Button size="sm" loading={busy === "roots"} disabled={!roots.trim()} onClick={() => void saveRoots()}>
              Enregistrer et lire les documents
            </Button>
            {docs > 0 && (
              <span className="text-3 small">
                {docs} document{docs > 1 ? "s" : ""} dans la bibliothèque
              </span>
            )}
          </div>
        </Step>

        <Step n={2} title="Assistant IA" done={ready} icon={<Sparkles />}>
          {ai.isLoading ? (
            <Spinner label="Vérification" />
          ) : (
            <div className="welcome-row">
              <Badge tone={ready ? "success" : "warning"}>{ready ? "Prêt" : "À configurer"}</Badge>
              <span className="text-2 small grow">{ai.data?.message}</span>
              {!ready && (
                <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={ai.isFetching} onClick={() => void api.aiStatus(true).then(() => ai.refetch())}>
                  Vérifier
                </Button>
              )}
            </div>
          )}
          <div className="welcome-row">
            <span className="text-3 small grow">ORBIT marche avec votre abonnement Claude (avec Claude Code), votre abonnement ChatGPT, ou une clé d'API Anthropic ou OpenAI.</span>
            <Button size="sm" variant="ghost" onClick={() => ui.go("settings", "assistant")}>
              Choisir le service
            </Button>
          </div>
        </Step>

        <Step n={3} title="Votre profil" icon={<PenLine />}>
          <p className="text-2 small">Le profil résume votre parcours et ce que vous cherchez. L'IA s'en sert pour noter les offres et adapter vos CV et vos lettres.</p>
          <div className="welcome-choices">
            <button
              type="button"
              className="welcome-choice is-primary"
              disabled={!ready || docs === 0}
              onClick={async () => {
                if (!(await startDiscovery(false))) return;
                await finish();
                ui.go("settings", "profil");
              }}
            >
              <Sparkles />
              <span className="welcome-choice-title">Découverte par {ready ? ai.data?.assistant : "l'IA"}</span>
              <span className="welcome-choice-text">L'IA lit vos CV et vos lettres et crée votre premier profil. Vous le relisez ensuite. Aucune offre n'est créée.</span>
              {(!ready || docs === 0) && <span className="welcome-choice-note">{docs === 0 ? "Ajoutez d'abord vos documents." : "L'assistant IA doit d'abord être prêt."}</span>}
            </button>
            <button
              type="button"
              className="welcome-choice"
              onClick={async () => {
                await finish();
                ui.go("settings", "profil");
              }}
            >
              <PenLine />
              <span className="welcome-choice-title">Je le remplis moi-même</span>
              <span className="welcome-choice-text">Vous écrivez votre profil dans les Réglages. La découverte reste possible plus tard.</span>
            </button>
          </div>
        </Step>

        <div className="welcome-foot">
          <span className="text-3 small">
            <Mail className="inline-icon" /> Gmail est facultatif : connectez-le quand vous voulez, dans la page Gmail.
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await finish();
              ui.go("dashboard");
            }}
          >
            Passer
          </Button>
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, done, icon, children }: { n: number; title: string; done?: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <section className={`welcome-step ${done ? "is-done" : ""}`}>
      <div className="welcome-step-head">
        <span className="welcome-step-num">{done ? <Check /> : n}</span>
        <span className="welcome-step-title">{title}</span>
        <span className="welcome-step-icon">{icon}</span>
      </div>
      <div className="welcome-step-body">{children}</div>
    </section>
  );
}
