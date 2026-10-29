import type { ConnectorInfo, ModelChoice, RequestMode } from "@shared/types";
import { MODE_LABELS, MODEL_LABELS } from "@shared/types";
import {
  Archive,
  ArrowLeft,
  BellRing,
  ChevronRight,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Info,
  Mail,
  Plug,
  RefreshCw,
  Scale,
  Sparkles,
  Upload,
  UserRound,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { PathLink, ViewHeader, useAction } from "../components/bits";
import { Badge, Button, ErrorState, Field, IconButton, Segmented, Spinner, Switch, confirmAction } from "../components/ui";
import { api, type ImportReport, type Settings } from "../lib/api";
import { fileName, sizeLabel } from "../lib/format";
import { errorMessage, useAiStatus, useBackups, useBootstrap, useConnectors, useSettings } from "../lib/queries";
import { useUi } from "../lib/store";

type SectionId = "profil" | "grille" | "claude" | "connecteurs" | "documents" | "dossiers" | "gmail" | "alertes" | "donnees";

interface SectionDef {
  id: SectionId;
  title: string;
  icon: ReactNode;
  /** One line on the index: what is set now. */
  summary: (s: Settings) => string;
  /** Shown at the top of the section: what it is for and how Claude uses it. */
  about: ReactNode;
  body: (s: Settings) => ReactNode;
}

/** The profile is still the neutral template (or nearly empty). */
export const emptyProfile = (text: string) => text.trim().length < 50 || text.includes("(à remplir, ou à confier à la Découverte par Claude");

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^[-•]\s*/, "").trim())
    .find((l) => l && !/^profil de référence/i.test(l)) ?? "";

const SECTIONS: SectionDef[] = [
  {
    id: "profil",
    title: "Profil",
    icon: <UserRound />,
    summary: (s) => (emptyProfile(s.profile) ? "À remplir, ou à confier à Claude" : firstLine(s.profile)),
    about: (
      <>
        Le profil résume votre parcours et ce que vous cherchez. Claude le reçoit à chaque demande : il s'en sert pour juger les offres, choisir le modèle de CV le plus proche et rédiger les lettres. Les
        lignes « Orientations », « Préférences », « Recherche », « Dates » et « Critère éliminatoire » sont envoyées avec chaque message. Vos CV font foi : si le profil s'en écarte, corrigez-le ici, ou
        laissez la Découverte par Claude le refaire à partir de vos documents.
      </>
    ),
    body: (s) => <ProfileSection s={s} />,
  },
  {
    id: "grille",
    title: "Grille d'analyse",
    icon: <Scale />,
    summary: () => "Score sur 100 et points bloquants",
    about: (
      <>
        La grille dit à Claude comment noter une offre sur 100 et ce qui est bloquant pour vous. Le score juge seulement l'adéquation du profil au poste. Les points pratiques (date de début, durée, lieu,
        langue) sont listés à part avec leur gravité, sans baisser le score. Modifiez-la pour durcir ou assouplir le tri : elle est envoyée en entier avec chaque demande.
      </>
    ),
    body: (s) => <GridSection s={s} />,
  },
  {
    id: "claude",
    title: "Claude",
    icon: <Sparkles />,
    summary: (s) => `${MODEL_LABELS[s.model]} · ${s.defaultMode === "auto" ? "mode auto" : `mode ${s.defaultMode}`}`,
    about: (
      <>
        ORBIT passe par Claude Code et votre abonnement Claude, jamais par une clé d'API facturée à part. Claude reçoit votre demande, le profil, la grille, et seulement ce qu'il consulte avec les outils
        d'ORBIT. Les documents privés ne lui sont jamais transmis. Le modèle et le mode choisis ici sont ceux de départ : ils se changent aussi pour chaque demande, dans la fenêtre de l'assistant.
      </>
    ),
    body: (s) => <ClaudeSection s={s} />,
  },
  {
    id: "connecteurs",
    title: "Connecteurs",
    icon: <Plug />,
    summary: (s) => (s.indeedConnector ? "Indeed activé · LinkedIn et HelloWork par alertes e-mail" : "Indeed désactivé"),
    about: (
      <>
        Les connecteurs sont ceux de votre compte claude.ai, ajoutés dans claude.ai, Paramètres, Connecteurs. L'assistant n'utilise que ceux autorisés ici, et seulement pour chercher des offres et lire leur
        description : aucun connecteur ne postule ni n'envoie quoi que ce soit à votre place. Les sites sans connecteur de recherche d'emploi arrivent par leurs alertes e-mail, lues avec Gmail.
      </>
    ),
    body: (s) => <ConnectorsSection s={s} />,
  },
  {
    id: "documents",
    title: "CV et lettre",
    icon: <FileText />,
    summary: (s) => (s.autoDocuments ? "Préparés tout de suite pour une offre donnée à l'assistant" : "Préparés seulement sur demande"),
    about: (
      <>
        Claude rédige le contenu, le modèle intégré d'ORBIT (ou votre propre générateur de CV, s'il est indiqué ici) fait la mise en page et LibreOffice fait le PDF. Les fichiers vont dans le dossier ORBIT de la candidature, jamais dans vos dossiers, et une
        nouvelle version ne remplace jamais l'ancienne. Quand la préparation automatique est activée, une offre que vous donnez à l'assistant (lien ou texte) reçoit tout de suite son CV et sa lettre.
      </>
    ),
    body: (s) => <DocumentsSection s={s} />,
  },
  {
    id: "dossiers",
    title: "Dossiers et suivi",
    icon: <FolderOpen />,
    summary: (s) => `${s.documentRoots.length} dossier${s.documentRoots.length > 1 ? "s" : ""} de documents · ${s.trackingFiles.length} fichier${s.trackingFiles.length > 1 ? "s" : ""} de suivi`,
    about: (
      <>
        ORBIT lit vos CV, vos lettres et vos fichiers de suivi sans jamais les modifier, les déplacer ni les renommer. Un fichier dont le chemin contient un des mots privés n'est jamais transmis à Claude.
      </>
    ),
    body: (s) => <FoldersSection s={s} />,
  },
  {
    id: "gmail",
    title: "Gmail et relances",
    icon: <Mail />,
    summary: (s) => `${s.mailLookbackDays} jours relus · relance après ${s.followupAfterDays} jours`,
    about: (
      <>
        Gmail est lu en lecture seule pour repérer les accusés de réception, tests, entretiens et refus, et les rattacher à vos candidatures. Un statut qu'un e-mail suggère attend toujours votre confirmation.
        La connexion se fait dans la page Gmail. Ici, la période relue et le délai avant de proposer une relance.
      </>
    ),
    body: (s) => <MailSection s={s} />,
  },
  {
    id: "alertes",
    title: "Alertes d'offres",
    icon: <BellRing />,
    summary: (s) => `${s.alertKeywords.length} mots de recherche · ${s.alertExclude.length} mots exclus`,
    about: (
      <>
        Les alertes e-mail de LinkedIn, Indeed, HelloWork, Welcome to the Jungle et APEC sont lues avec Gmail. Une offre devient une fiche quand son titre contient un des mots de votre recherche et aucun mot
        exclu. Seul le lien propre de l'offre est gardé, sans les jetons de connexion des e-mails.
      </>
    ),
    body: (s) => <AlertsSection s={s} />,
  },
  {
    id: "donnees",
    title: "Données et sauvegardes",
    icon: <Database />,
    summary: () => "Exports Excel et CSV, sauvegardes",
    about: <>Tout reste sur cet ordinateur. Une sauvegarde est faite à chaque démarrage et les 30 dernières sont gardées.</>,
    body: () => <DataSection />,
  },
];

export function SettingsView() {
  const ui = useUi();
  const settings = useSettings();
  const section = SECTIONS.find((x) => x.id === ui.id) ?? null;
  return (
    <>
      <ViewHeader
        title={section ? section.title : "Réglages"}
        sub={section ? "Réglages" : undefined}
        leading={
          section ? (
            <IconButton label="Retour aux réglages" onClick={() => ui.go("settings")}>
              <ArrowLeft />
            </IconButton>
          ) : undefined
        }
      />
      <div className="view-body">
        <div className="view-inner view-inner-narrow settings-stack">
          {settings.isLoading && <Spinner label="Chargement" />}
          {settings.error && <ErrorState message={errorMessage(settings.error)} onRetry={() => void settings.refetch()} />}
          {settings.data &&
            (section ? (
              <>
                <div className="settings-about">
                  <Info />
                  <p>{section.about}</p>
                </div>
                {section.body(settings.data)}
              </>
            ) : (
              <SettingsIndex s={settings.data} />
            ))}
        </div>
      </div>
    </>
  );
}

function SettingsIndex({ s }: { s: Settings }) {
  const ui = useUi();
  return (
    <ul className="settings-index">
      {SECTIONS.map((x) => (
        <li key={x.id}>
          <button type="button" className="settings-tile" onClick={() => ui.go("settings", x.id)}>
            <span className="settings-tile-icon">{x.icon}</span>
            <span className="settings-tile-main">
              <span className="settings-tile-title">{x.title}</span>
              <span className="settings-tile-sub truncate">{x.summary(s)}</span>
            </span>
            <ChevronRight className="settings-tile-chevron" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="settings-card">
      {title && <div className="settings-card-title">{title}</div>}
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

/** Local copy of some settings, saved on demand. */
function useDraft<K extends keyof Settings>(s: Settings, keys: K[]) {
  const pick = () => Object.fromEntries(keys.map((k) => [k, s[k]])) as Pick<Settings, K>;
  const [draft, setDraft] = useState(pick);
  useEffect(() => setDraft(pick()), [s]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = keys.some((k) => JSON.stringify(draft[k]) !== JSON.stringify(s[k]));
  return { draft, setDraft, dirty };
}

function SaveRow({ dirty, busy, onSave }: { dirty: boolean; busy: boolean; onSave: () => void }) {
  return (
    <div className="save-row">
      <Button variant="primary" size="sm" disabled={!dirty} loading={busy} onClick={onSave}>
        Enregistrer
      </Button>
    </div>
  );
}

/** Starts the discovery: Claude reads the CVs and letters and writes the profile. */
export async function startDiscovery(hasProfile: boolean) {
  const { ok } = await confirmAction({
    title: "Confier le profil à Claude ?",
    body: hasProfile
      ? "Claude lit vos CV et vos lettres (jamais les documents privés) et propose un nouveau profil. Votre profil actuel ne change pas tant que vous n'avez pas validé la proposition. Aucune offre n'est créée."
      : "Claude lit vos CV et vos lettres (jamais les documents privés) et écrit votre premier profil, que vous pourrez relire et corriger. Aucune offre n'est créée.",
    confirmLabel: "Lancer la découverte",
  });
  if (!ok) return false;
  useUi.getState().startTask("discovery");
  return true;
}

function ProfileSection({ s }: { s: Settings }) {
  const { draft, setDraft, dirty } = useDraft(s, ["profile"]);
  const { busy, run } = useAction();
  const ai = useAiStatus();
  return (
    <>
      <Card title="Découverte par Claude">
        <div className="settings-row">
          <div className="settings-row-label">
            <span className="text-2">Claude lit vos CV et vos lettres et écrit le profil à votre place. Ce qu'il déduit est marqué « à confirmer », ce qui manque « à compléter ».</span>
          </div>
          <div className="settings-row-control">
            <Button size="sm" icon={<Sparkles />} disabled={ai.data?.state !== "ready"} onClick={() => void startDiscovery(!emptyProfile(s.profile))}>
              Lancer la découverte
            </Button>
          </div>
        </div>
      </Card>
      <Card title="Profil de référence">
        <textarea className="textarea" rows={16} aria-label="Profil de référence" value={draft.profile} onChange={(e) => setDraft({ profile: e.target.value })} />
        <SaveRow dirty={dirty} busy={busy === "save"} onSave={() => void run("save", () => api.saveSettings(draft), "Profil enregistré.")} />
      </Card>
    </>
  );
}

function GridSection({ s }: { s: Settings }) {
  const { draft, setDraft, dirty } = useDraft(s, ["scoring"]);
  const { busy, run } = useAction();
  return (
    <Card>
      <textarea className="textarea" rows={12} aria-label="Grille d'analyse" value={draft.scoring} onChange={(e) => setDraft({ scoring: e.target.value })} />
      <SaveRow dirty={dirty} busy={busy === "save"} onSave={() => void run("save", () => api.saveSettings(draft), "Grille enregistrée.")} />
    </Card>
  );
}

function ClaudeSection({ s }: { s: Settings }) {
  const ai = useAiStatus();
  const { draft, setDraft, dirty } = useDraft(s, ["model", "effort", "defaultMode", "timeoutSec", "claudePath"]);
  const { busy, run } = useAction();
  const st = ai.data;
  return (
    <Card>
      <div className="settings-row">
        <div className="settings-row-label">
          <span>État</span>
          <span className="text-3 small">{st?.message ?? "Vérification..."}</span>
        </div>
        <div className="settings-row-control row-gap">
          {st && <Badge tone={st.state === "ready" ? "success" : "warning"}>{st.state === "ready" ? `Prêt${st.plan ? ` (${st.plan})` : ""}` : "À configurer"}</Badge>}
          <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={ai.isFetching} onClick={() => void api.aiStatus(true).then(() => ai.refetch())}>
            Vérifier
          </Button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <span>Modèle de départ</span>
          <span className="text-3 small">Haiku est rapide, Sonnet convient au travail courant, Opus soigne le plus les CV, les lettres et les analyses.</span>
        </div>
        <div className="settings-row-control">
          <Segmented<ModelChoice>
            label="Modèle"
            value={draft.model}
            onChange={(model) => setDraft({ ...draft, model })}
            options={(["haiku", "sonnet", "opus"] as ModelChoice[]).map((m) => ({ value: m, label: MODEL_LABELS[m] }))}
          />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <span>Effort</span>
          <span className="text-3 small">Plus d'effort : réponses plus soignées, plus lentes, plus d'usage de l'abonnement.</span>
        </div>
        <div className="settings-row-control">
          <Segmented<Settings["effort"]>
            label="Effort"
            value={draft.effort}
            onChange={(effort) => setDraft({ ...draft, effort })}
            options={[
              { value: "low", label: "Bas" },
              { value: "medium", label: "Moyen" },
              { value: "high", label: "Élevé" },
              { value: "xhigh", label: "Très élevé" },
            ]}
          />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <span>Mode de départ</span>
          <span className="text-3 small">En auto, Claude fait tout de suite ce que vous demandez clairement et vous propose le reste avant de le faire.</span>
        </div>
        <div className="settings-row-control">
          <select className="select select-sm" value={draft.defaultMode} onChange={(e) => setDraft({ ...draft, defaultMode: e.target.value as RequestMode })} aria-label="Mode de départ">
            <option value="auto">Auto · Claude choisit</option>
            {(["A", "B", "C"] as const).map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field-row">
        <Field label="Durée maximale d'une demande (secondes)" htmlFor="st-timeout">
          <input id="st-timeout" className="input" type="number" min={60} max={1800} value={draft.timeoutSec} onChange={(e) => setDraft({ ...draft, timeoutSec: Number(e.target.value) })} />
        </Field>
        <Field label="Chemin de Claude Code" htmlFor="st-claude" hint="Vide : trouvé automatiquement.">
          <input id="st-claude" className="input" value={draft.claudePath} onChange={(e) => setDraft({ ...draft, claudePath: e.target.value })} />
        </Field>
      </div>
      <SaveRow
        dirty={dirty}
        busy={busy === "save"}
        onSave={() => void run("save", () => api.saveSettings({ ...draft, timeoutSec: Math.min(1800, Math.max(60, Math.round(draft.timeoutSec || 600))) }), "Réglages enregistrés.")}
      />
    </Card>
  );
}

/** Job sites, and how each one reaches ORBIT. */
const SITES: { name: string; how: string }[] = [
  {
    name: "LinkedIn",
    how: "Pas de connecteur de recherche d'emploi. Le connecteur « LinkedIn Hiring Pro » sert seulement à publier une offre comme recruteur : ORBIT ne l'utilise jamais. Les offres arrivent par vos alertes LinkedIn Emplois, lues dans Gmail.",
  },
  { name: "HelloWork", how: "Pas de connecteur. Créez une alerte HelloWork avec vos mots-clés : ses e-mails sont lus dans Gmail." },
  { name: "Welcome to the Jungle", how: "Pas de connecteur. Les alertes e-mail sont lues dans Gmail." },
  { name: "APEC", how: "Pas de connecteur. Les alertes e-mail sont lues dans Gmail." },
];

const CONNECTOR_STATUS: Record<ConnectorInfo["status"], { label: string; tone: "success" | "warning" | "danger" }> = {
  connected: { label: "Connecté", tone: "success" },
  needs_auth: { label: "À reconnecter", tone: "warning" },
  failed: { label: "En erreur", tone: "danger" },
};

function connectorRole(c: ConnectorInfo, s: Settings): string {
  if (/^indeed$/i.test(c.name)) return s.indeedConnector ? "Recherche d'offres et descriptions · utilisé par l'assistant" : "Recherche d'offres · désactivé pour l'assistant";
  if (/linkedin/i.test(c.name)) return "Publication d'offres côté recruteur · jamais utilisé par ORBIT";
  return "Jamais utilisé par ORBIT";
}

function ConnectorsSection({ s }: { s: Settings }) {
  const { draft, setDraft, dirty } = useDraft(s, ["indeedConnector"]);
  const { busy, run } = useAction();
  const list = useConnectors(true);
  const [checking, setChecking] = useState(false);
  const indeed = list.data?.items.find((c) => /^indeed$/i.test(c.name));
  return (
    <>
      <Card title="Indeed">
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Recherche d'offres sur Indeed</span>
            <span className="text-3 small">
              Le connecteur officiel Indeed de votre compte claude.ai : l'assistant cherche des offres et lit leur description quand vous le lui demandez. Il ne postule pas.
              {list.data && !indeed && " Ce connecteur n'apparaît pas sur votre compte : ajoutez-le dans claude.ai."}
            </span>
          </div>
          <div className="settings-row-control">
            <Switch checked={draft.indeedConnector} label="Connecteur Indeed" onChange={(v) => setDraft({ indeedConnector: v })} />
          </div>
        </div>
        <SaveRow dirty={dirty} busy={busy === "save"} onSave={() => void run("save", () => api.saveSettings(draft), "Réglage enregistré.")} />
      </Card>

      <Card title="Sites sans connecteur">
        <ul className="connector-list">
          {SITES.map((x) => (
            <li key={x.name} className="connector-row">
              <span className="connector-name">{x.name}</span>
              <span className="text-3 small">{x.how}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Connecteurs de votre compte claude.ai">
        {list.isLoading && <Spinner label="Lecture des connecteurs (quelques secondes)" />}
        {list.error && <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />}
        {list.data && list.data.items.length === 0 && <p className="text-3 small">Aucun connecteur claude.ai trouvé.</p>}
        {list.data && list.data.items.length > 0 && (
          <ul className="connector-list">
            {list.data.items.map((c) => (
              <li key={c.prefix} className="connector-row connector-row-inline">
                <span className="connector-main">
                  <span className="connector-name">{c.name}</span>
                  <span className="text-3 small">{connectorRole(c, s)}</span>
                </span>
                <Badge tone={CONNECTOR_STATUS[c.status].tone}>{CONNECTOR_STATUS[c.status].label}</Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="save-row save-row-start">
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw />}
            loading={checking}
            onClick={async () => {
              setChecking(true);
              try {
                await api.connectors(true);
                await list.refetch();
              } finally {
                setChecking(false);
              }
            }}
          >
            Vérifier à nouveau
          </Button>
          <a className="btn btn-sm btn-ghost" href="https://claude.ai/settings/connectors" target="_blank" rel="noreferrer">
            <ExternalLink /> Gérer mes connecteurs sur claude.ai
          </a>
        </div>
      </Card>
    </>
  );
}

function DocumentsSection({ s }: { s: Settings }) {
  const { draft, setDraft, dirty } = useDraft(s, ["autoDocuments", "writingRules", "contact", "cvGenerator", "soffice"]);
  const { busy, run } = useAction();
  const c = draft.contact;
  const setC = (k: keyof Settings["contact"]) => (e: { target: { value: string } }) => setDraft({ ...draft, contact: { ...c, [k]: e.target.value } });
  return (
    <Card>
      <div className="settings-row">
        <div className="settings-row-label">
          <span>Préparer tout de suite le CV et la lettre</span>
          <span className="text-3 small">
            Pour une nouvelle offre donnée à l'assistant. Sauf point bloquant, où il vous demande d'abord. Pour une offre déjà traitée, il vous demande si vous voulez une nouvelle version.
          </span>
        </div>
        <div className="settings-row-control">
          <Switch checked={draft.autoDocuments} label="Préparation automatique" onChange={(v) => setDraft({ ...draft, autoDocuments: v })} />
        </div>
      </div>
      <Field label="Règles de rédaction" htmlFor="st-rules" hint="Claude les lit avant chaque CV et chaque lettre.">
        <textarea id="st-rules" className="textarea" rows={12} value={draft.writingRules} onChange={(e) => setDraft({ ...draft, writingRules: e.target.value })} />
      </Field>
      <div className="field-row">
        <Field label="Nom (en-tête)" htmlFor="st-c-name">
          <input id="st-c-name" className="input" value={c.name} onChange={setC("name")} />
        </Field>
        <Field label="Signature" htmlFor="st-c-sign">
          <input id="st-c-sign" className="input" value={c.signature} onChange={setC("signature")} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Téléphone" htmlFor="st-c-phone">
          <input id="st-c-phone" className="input" value={c.phone} onChange={setC("phone")} />
        </Field>
        <Field label="E-mail" htmlFor="st-c-mail">
          <input id="st-c-mail" className="input" value={c.email} onChange={setC("email")} />
        </Field>
        <Field label="Ville" htmlFor="st-c-city" hint="Jamais l'adresse complète.">
          <input id="st-c-city" className="input" value={c.city} onChange={setC("city")} />
        </Field>
      </div>
      <Field label="Générateur de CV personnel" htmlFor="st-gen" hint="Vide : le modèle intégré d'ORBIT, une page sur une colonne.">
        <input id="st-gen" className="input mono" value={draft.cvGenerator} onChange={(e) => setDraft({ ...draft, cvGenerator: e.target.value })} />
      </Field>
      <Field label="LibreOffice (pour le PDF)" htmlFor="st-soffice">
        <input id="st-soffice" className="input mono" value={draft.soffice} onChange={(e) => setDraft({ ...draft, soffice: e.target.value })} />
      </Field>
      <SaveRow dirty={dirty} busy={busy === "save"} onSave={() => void run("save", () => api.saveSettings(draft), "Réglages des documents enregistrés.")} />
    </Card>
  );
}

const lines = (v: string) =>
  v
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

function FoldersSection({ s }: { s: Settings }) {
  const [roots, setRoots] = useState(s.documentRoots.join("\n"));
  const [tracking, setTracking] = useState(s.trackingFiles.join("\n"));
  const [patterns, setPatterns] = useState(s.privatePatterns.join(", "));
  const [report, setReport] = useState<ImportReport[] | null>(null);
  useEffect(() => {
    setRoots(s.documentRoots.join("\n"));
    setTracking(s.trackingFiles.join("\n"));
    setPatterns(s.privatePatterns.join(", "));
  }, [s]);
  const { busy, run } = useAction();
  const next = {
    documentRoots: lines(roots),
    trackingFiles: lines(tracking),
    privatePatterns: patterns
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  };
  const dirty = JSON.stringify(next) !== JSON.stringify({ documentRoots: s.documentRoots, trackingFiles: s.trackingFiles, privatePatterns: s.privatePatterns });
  return (
    <Card>
      <Field label="Dossiers de documents (un par ligne)" htmlFor="st-roots">
        <textarea id="st-roots" className="textarea mono" rows={3} value={roots} onChange={(e) => setRoots(e.target.value)} />
      </Field>
      <Field label="Fichiers de suivi à importer (un par ligne)" htmlFor="st-tracking">
        <textarea id="st-tracking" className="textarea mono" rows={3} value={tracking} onChange={(e) => setTracking(e.target.value)} />
      </Field>
      <Field label="Mots qui rendent un fichier privé" htmlFor="st-private">
        <input id="st-private" className="input" value={patterns} onChange={(e) => setPatterns(e.target.value)} />
      </Field>
      <div className="save-row">
        <Button
          size="sm"
          icon={<Upload />}
          loading={busy === "import"}
          disabled={dirty}
          onClick={async () => {
            const r = await run(
              "import",
              () => api.importTracking(),
              (x) => `${x.reduce((n, f) => n + f.offersCreated, 0)} offre(s) et ${x.reduce((n, f) => n + f.applicationsCreated, 0)} candidature(s) ajoutées.`,
            );
            if (r) setReport(r);
          }}
        >
          Réimporter le suivi
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty}
          loading={busy === "save"}
          onClick={() => void run("save", () => api.saveSettings(next), "Dossiers enregistrés. Relisez les documents pour appliquer.")}
        >
          Enregistrer
        </Button>
      </div>
      {report && (
        <ul className="settings-list">
          {report.map((r) => (
            <li key={r.file}>
              {fileName(r.file)} :{" "}
              {r.missing
                ? "introuvable"
                : `${r.offersCreated} offre(s) ajoutée(s), ${r.offersKnown} déjà connue(s), ${r.applicationsCreated} candidature(s) ajoutée(s)${r.skipped.length ? `, ${r.skipped.length} ligne(s) ignorée(s)` : ""}`}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MailSection({ s }: { s: Settings }) {
  const ui = useUi();
  const { draft, setDraft, dirty } = useDraft(s, ["mailLookbackDays", "followupAfterDays"]);
  const { busy, run } = useAction();
  return (
    <Card>
      <div className="field-row">
        <Field label="Chercher dans Gmail sur (jours)" htmlFor="st-lookback">
          <input id="st-lookback" className="input" type="number" min={7} max={400} value={draft.mailLookbackDays} onChange={(e) => setDraft({ ...draft, mailLookbackDays: Number(e.target.value) })} />
        </Field>
        <Field label="Proposer une relance après (jours sans réponse)" htmlFor="st-followup">
          <input
            id="st-followup"
            className="input"
            type="number"
            min={3}
            max={60}
            value={draft.followupAfterDays}
            onChange={(e) => setDraft({ ...draft, followupAfterDays: Number(e.target.value) })}
          />
        </Field>
      </div>
      <div className="save-row">
        <Button size="sm" variant="ghost" icon={<Mail />} onClick={() => ui.go("mail")}>
          Connexion Gmail
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty}
          loading={busy === "save"}
          onClick={() =>
            void run(
              "save",
              () =>
                api.saveSettings({ mailLookbackDays: Math.min(400, Math.max(7, Math.round(draft.mailLookbackDays))), followupAfterDays: Math.min(60, Math.max(3, Math.round(draft.followupAfterDays))) }),
              "Enregistré.",
            )
          }
        >
          Enregistrer
        </Button>
      </div>
    </Card>
  );
}

const words = (v: string) =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function AlertsSection({ s }: { s: Settings }) {
  const [keywords, setKeywords] = useState(s.alertKeywords.join(", "));
  const [exclude, setExclude] = useState(s.alertExclude.join(", "));
  useEffect(() => {
    setKeywords(s.alertKeywords.join(", "));
    setExclude(s.alertExclude.join(", "));
  }, [s]);
  const { busy, run } = useAction();
  const next = { alertKeywords: words(keywords), alertExclude: words(exclude) };
  const dirty = JSON.stringify(next) !== JSON.stringify({ alertKeywords: s.alertKeywords, alertExclude: s.alertExclude });
  return (
    <Card>
      <Field
        label="Mots de votre recherche (séparés par des virgules)"
        htmlFor="st-akw"
        hint="Vide : toutes les offres des alertes sont gardées. Les mots courts (IA, SOC, SI, IT) comptent seulement en mot entier. « cyber » couvre aussi cybersécurité."
      >
        <textarea id="st-akw" className="textarea" rows={4} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
      </Field>
      <Field label="Mots exclus" htmlFor="st-aex">
        <input id="st-aex" className="input" value={exclude} onChange={(e) => setExclude(e.target.value)} />
      </Field>
      <SaveRow dirty={dirty} busy={busy === "save"} onSave={() => void run("save", () => api.saveSettings(next), "Filtre des alertes enregistré.")} />
    </Card>
  );
}

function DataSection() {
  const boot = useBootstrap();
  const backups = useBackups();
  const { busy, run } = useAction();
  const b = boot.data;
  return (
    <Card>
      <dl className="kv">
        <dt>Base et sauvegardes</dt>
        <dd>{b ? <PathLink path={b.dataDir} folder /> : "..."}</dd>
        <dt>Dossiers de candidature</dt>
        <dd>{b ? <PathLink path={b.applicationsDir} folder /> : "..."}</dd>
        <dt>Version</dt>
        <dd>ORBIT {b?.version}</dd>
      </dl>
      <div className="save-row save-row-start">
        <a className="btn btn-sm" href="/api/export.xlsx" download>
          <FileSpreadsheet /> Exporter en Excel
        </a>
        <a className="btn btn-sm" href="/api/export.csv" download>
          <Download /> Exporter en CSV
        </a>
        <Button
          size="sm"
          icon={<Archive />}
          loading={busy === "backup"}
          onClick={() =>
            void run(
              "backup",
              () => api.backup(),
              (r) => `Sauvegarde ${r.name} créée.`,
            )
          }
        >
          Sauvegarder maintenant
        </Button>
      </div>
      {backups.data && backups.data.length > 0 && (
        <details className="backups">
          <summary>
            {backups.data.length} sauvegarde{backups.data.length > 1 ? "s" : ""}
          </summary>
          <ul className="settings-list">
            {backups.data.slice(0, 15).map((x) => (
              <li key={x.name}>
                {x.name} <span className="text-3">({sizeLabel(x.size)})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
