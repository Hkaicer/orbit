import { MODE_LABELS, MODEL_LABELS, type AiStatus, type AssistantTask, type ChatMessage, type ModelChoice, type Proposal, type RequestMode } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronDown, CircleStop, Download, FolderOpen, ListChecks, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "../components/bits";
import { Button, IconButton, Menu, Segmented, Spinner, confirmAction } from "../components/ui";
import { api, downloadUrl, streamChat } from "../lib/api";
import { Markdown } from "../lib/markdown";
import { refreshAll, useAiStatus, useConversation, useSettings } from "../lib/queries";
import { useUi } from "../lib/store";
import { toast } from "../lib/toast";

const TOOL_LABELS: Record<string, string> = {
  get_profile: "Lecture du profil",
  get_dashboard: "Lecture du tableau de bord",
  list_offers: "Lecture des offres",
  get_offer: "Lecture d'une offre",
  list_applications: "Lecture des candidatures",
  get_application: "Lecture d'une candidature",
  list_documents: "Recherche dans les documents",
  read_document: "Lecture d'un document",
  fetch_offer_page: "Lecture de la page de l'offre",
  search_tracked_mails: "Recherche dans les e-mails suivis",
  search_gmail: "Recherche dans Gmail",
  read_gmail: "Lecture d'un e-mail",
  create_offer: "Création de la fiche",
  save_analysis: "Enregistrement de l'analyse",
  set_offer_status: "Classement de l'offre",
  create_application: "Création de la candidature",
  update_application: "Mise à jour de la candidature",
  add_note: "Ajout d'une note",
  add_deadline: "Ajout d'une échéance",
  write_folder: "Écriture du dossier",
  write_folder_file: "Écriture d'un fichier du dossier",
  propose_status: "Proposition de statut",
  request_external_action: "Demande d'action externe",
  get_writing_rules: "Lecture de vos règles de rédaction",
  list_cv_bases: "Lecture de vos modèles de CV",
  get_cv_base: "Lecture d'un modèle de CV",
  generate_documents: "Création du CV et de la lettre",
  choose_mode: "Choix du mode",
  save_profile: "Enregistrement du profil",
};

const MODE_HINTS: Record<RequestMode, string> = {
  auto: "Claude choisit : il fait tout de suite ce que vous demandez clairement, et vous propose le reste avant de le faire.",
  A: "Claude prépare les changements, rien n'est fait avant votre validation.",
  B: "Les étapes locales sont faites seules. Tout envoi attend votre accord.",
  C: "Claude enchaîne le plus d'étapes possible. Tout envoi attend toujours votre accord.",
};

const MODEL_HINTS: Record<ModelChoice, string> = {
  haiku: "rapide, questions simples",
  sonnet: "équilibré, travail courant",
  opus: "le plus soigné, CV et lettres",
};

const TASK_LABELS: Record<AssistantTask, string> = {
  discovery: "Découverte par Claude : lis mes CV et mes lettres et crée mon profil.",
};

const SUGGESTIONS = [
  "Qu'est-ce que je dois faire en priorité cette semaine ?",
  "Quelles candidatures n'ont pas de réponse depuis deux semaines ?",
  "Analyse les nouvelles offres qui n'ont pas encore de score.",
  "Compare mes deux meilleures offres et dis-moi laquelle prioriser.",
];

interface Streaming {
  userText: string;
  status: string | null;
  tools: { name: string; ok: boolean }[];
  text: string;
}

export function AssistantPanel() {
  const ui = useUi();
  const qc = useQueryClient();
  const status = useAiStatus();
  const settings = useSettings();
  const convo = useConversation();
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mode: RequestMode = ui.mode ?? settings.data?.defaultMode ?? "auto";
  const model: ModelChoice = ui.model ?? settings.data?.model ?? "sonnet";
  const ready = status.data?.state === "ready";
  const busy = Boolean(streaming) || Boolean(convo.data?.busy);
  const proposals = useMemo(() => new Map((convo.data?.proposals ?? []).map((p) => [p.id, p])), [convo.data]);
  const messages = convo.data?.messages ?? [];

  // A button elsewhere ("Analyser avec Claude"...) prepares a request: it is shown here, never sent on its own.
  useEffect(() => {
    if (ui.draft) {
      setInput(ui.draft);
      ui.set({ draft: "" });
      window.setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
      }, 30);
    }
  }, [ui.draft]); // eslint-disable-line react-hooks/exhaustive-deps

  // A task started elsewhere (the discovery of the profile) is sent once Claude is ready.
  useEffect(() => {
    if (!ui.task || !ready || busy) return;
    const task = ui.task;
    ui.set({ task: null });
    void send(TASK_LABELS[task], task);
  }, [ui.task, ready, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, streaming?.text, streaming?.tools.length]);

  const send = async (text: string, task?: AssistantTask) => {
    const message = text.trim();
    if (!message || busy || !ready) return;
    if (!task) setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setStreaming({ userText: message, status: null, tools: [], text: "" });
    try {
      await streamChat({ message, mode, model, ...(task ? { task } : {}) }, (e) => {
        if (e.type === "status") setStreaming((s) => s && { ...s, status: e.text });
        else if (e.type === "tool") setStreaming((s) => s && { ...s, tools: [...s.tools, { name: e.name, ok: e.ok }] });
        else if (e.type === "text") setStreaming((s) => s && { ...s, text: s.text + e.delta });
        else if (e.type === "done" && e.proposal) toast.show({ message: "Des changements attendent votre validation." });
        else if (e.type === "fatal") {
          toast.error(e.message);
          if (!task) setInput(message);
        }
      });
    } finally {
      await qc.invalidateQueries({ queryKey: ["conversation"] });
      await refreshAll(qc);
      setStreaming(null);
    }
  };

  const clear = async () => {
    const { ok } = await confirmAction({ title: "Effacer la conversation ?", body: "Les offres, candidatures et l'historique ne sont pas touchés.", confirmLabel: "Effacer", danger: true });
    if (!ok) return;
    await api.clearConversation();
    await qc.invalidateQueries({ queryKey: ["conversation"] });
  };

  return (
    <aside className="assistant" aria-label="Assistant">
      <header className="as-header">
        <div className="as-title">
          <Sparkles />
          <span>Assistant</span>
          <StatusPill status={status.data} />
        </div>
        <IconButton label="Effacer la conversation" onClick={() => void clear()} disabled={busy || messages.length === 0}>
          <Trash2 />
        </IconButton>
        <IconButton label="Fermer" onClick={() => ui.set({ assistantOpen: false })}>
          <X />
        </IconButton>
      </header>

      <div className="as-mode">
        <Segmented<RequestMode>
          label="Mode de cette demande"
          value={mode}
          onChange={(m) => ui.set({ mode: m })}
          options={[
            { value: "auto", label: "Auto", ariaLabel: "Auto · Claude choisit le mode" },
            ...(["A", "B", "C"] as const).map((m) => ({ value: m, label: `Mode ${m}`, ariaLabel: MODE_LABELS[m] })),
          ]}
        />
        <p className="as-mode-hint">{MODE_HINTS[mode]}</p>
      </div>

      <div className="as-messages" ref={scrollRef}>
        {messages.length === 0 && !streaming && (
          <div className="as-empty">
            <div className="as-empty-mark">
              <Sparkles />
            </div>
            <p className="text-2">Demandez une analyse, un tri des offres, la préparation d'un dossier ou un point sur vos candidatures.</p>
            <div className="as-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="as-suggestion" disabled={!ready} onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <MessageView key={m.id} message={m} proposal={m.meta.proposalId ? proposals.get(m.meta.proposalId) : undefined} />
        ))}
        {streaming && <StreamingView s={streaming} />}
      </div>

      {status.data && !ready && <NotReady status={status.data} />}
      <div className="composer">
        <div className={`composer-box ${!ready ? "is-disabled" : ""}`}>
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            placeholder={ready ? "Votre demande..." : "Claude n'est pas disponible"}
            aria-label="Votre demande"
            disabled={!ready}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input);
              }
            }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
            }}
          />
          <div className="composer-tools">
            <Menu
              label="Modèle de cette demande"
              items={[
                { heading: "Modèle de cette demande" },
                ...(["haiku", "sonnet", "opus"] as ModelChoice[]).map((m) => ({
                  label: `${MODEL_LABELS[m]} · ${MODEL_HINTS[m]}`,
                  icon: m === model ? <Check /> : <span style={{ width: 15 }} />,
                  onSelect: () => ui.set({ model: m }),
                })),
              ]}
              trigger={(p) => (
                <button type="button" {...p} className="composer-chip" disabled={busy} title="Changer de modèle pour cette demande">
                  {MODEL_LABELS[model]}
                  <ChevronDown />
                </button>
              )}
            />
            <span className="composer-chip is-static">{mode === "auto" ? "mode auto" : `mode ${mode}`}</span>
            <span className="spacer" />
            {busy ? (
              <Button variant="secondary" size="sm" icon={<CircleStop />} onClick={() => void api.cancel()}>
                Arrêter
              </Button>
            ) : (
              <button type="button" className="send-btn" aria-label="Envoyer" disabled={!ready || !input.trim()} onClick={() => void send(input)}>
                <ArrowUp />
              </button>
            )}
          </div>
        </div>
        <div className="composer-hint">Entrée pour envoyer, Maj+Entrée pour aller à la ligne. Claude ne reçoit que ce qu'il consulte, jamais les documents privés.</div>
      </div>
    </aside>
  );
}

function StatusPill({ status }: { status: AiStatus | undefined }) {
  const tone = !status ? "is-checking" : status.state === "ready" ? "is-ready" : "is-warn";
  return (
    <span className={`status-pill ${tone}`} title={status?.message}>
      <span className="status-dot" />
      {!status ? "Vérification" : status.state === "ready" ? "Prêt" : "Indisponible"}
    </span>
  );
}

function NotReady({ status }: { status: AiStatus }) {
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  return (
    <div className="as-notready">
      <div className="as-notready-title">Claude n'est pas disponible</div>
      <p>{status.message}</p>
      <p className="text-3 small">Les offres, candidatures, documents et Gmail restent utilisables sans Claude.</p>
      <div className="row">
        <Button
          size="sm"
          icon={checking ? <Spinner /> : <RefreshCw />}
          onClick={async () => {
            setChecking(true);
            try {
              await qc.fetchQuery({ queryKey: ["ai-status"], queryFn: () => api.aiStatus(true) });
            } finally {
              setChecking(false);
            }
          }}
        >
          Vérifier à nouveau
        </Button>
      </div>
    </div>
  );
}

function StreamingView({ s }: { s: Streaming }) {
  const last = s.tools[s.tools.length - 1];
  const failed = s.tools.filter((t) => !t.ok).length;
  return (
    <>
      <div className="msg msg-user">
        <div className="msg-bubble">{s.userText}</div>
      </div>
      <div className="msg msg-assistant is-streaming">
        {s.text ? <Markdown text={s.text} /> : null}
        <div className="msg-progress">
          <Spinner />
          <span>{s.status === "indeed" ? "Recherche sur Indeed" : last ? (TOOL_LABELS[last.name] ?? last.name) : "Réflexion"}</span>
          {s.tools.length > 0 && (
            <span className="faint tnum">
              · {s.tools.length} étape{s.tools.length > 1 ? "s" : ""}
              {failed ? ` (${failed} refusée${failed > 1 ? "s" : ""})` : ""}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function MessageView({ message: m, proposal }: { message: ChatMessage; proposal?: Proposal }) {
  if (m.role === "user") {
    return (
      <div className="msg msg-user">
        <div className="msg-bubble">{m.content}</div>
      </div>
    );
  }
  const tools = m.meta.tools ?? [];
  const failed = tools.filter((t) => !t.ok).length;
  return (
    <div className={`msg msg-assistant ${m.meta.status === "error" ? "msg-error" : ""}`}>
      <Markdown text={m.content} />
      {proposal && <ProposalCard proposal={proposal} />}
      {m.meta.files && m.meta.files.length > 0 && (
        <div className="msg-files">
          {m.meta.files.map((f) => (
            <a key={f.path} className="file-chip" href={downloadUrl(f.path)} download={f.name} title={`Télécharger ${f.name}`}>
              <Download />
              <span className="truncate">{f.name}</span>
            </a>
          ))}
          <OpenFolder path={m.meta.files[0]!.path} />
        </div>
      )}
      <div className="msg-meta">
        {m.meta.mode && <span>{m.meta.auto ? `Auto · mode ${m.meta.mode}` : `Mode ${m.meta.mode}`}</span>}
        {m.meta.model && <span>· {m.meta.model}</span>}
        {tools.length > 0 && (
          <span title={tools.map((t) => `${TOOL_LABELS[t.name] ?? t.name}${t.ok ? "" : " (refusée)"}`).join("\n")}>
            · {tools.length} étape{tools.length > 1 ? "s" : ""}
            {failed ? `, ${failed} refusée${failed > 1 ? "s" : ""}` : ""}
          </span>
        )}
        {m.meta.durationMs !== undefined && <span>· {Math.max(1, Math.round(m.meta.durationMs / 1000))} s</span>}
      </div>
    </div>
  );
}

/** Opens the application's folder in Explorer, on the CV and the letter. */
function OpenFolder({ path }: { path: string }) {
  const folder = path.replace(/[\\/][^\\/]+$/, "");
  return (
    <button
      type="button"
      className="file-chip"
      title={`${folder}\nOuvrir le dossier dans l'Explorateur`}
      onClick={() => void api.open(path).catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Le dossier n'a pas pu être ouvert."))}
    >
      <FolderOpen />
      <span>Ouvrir le dossier</span>
    </button>
  );
}

/** Mode A: what Claude prepared, applied only on the user's click. */
function ProposalCard({ proposal: p }: { proposal: Proposal }) {
  const qc = useQueryClient();
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const after = () => qc.invalidateQueries({ queryKey: ["conversation"] });
  if (p.status !== "pending") {
    return (
      <div className={`proposal proposal-collapsed is-${p.status}`}>
        <span className="proposal-icon">{p.status === "applied" ? <Check /> : <X />}</span>
        <span className="proposal-summary-strong grow">
          {p.status === "applied" ? "Appliqué" : "Écarté"} · {p.ops.length} changement{p.ops.length > 1 ? "s" : ""}
        </span>
        <button type="button" className="proposal-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "Masquer" : "Détails"}
        </button>
        {open && <OpsList ops={p.ops} />}
      </div>
    );
  }
  return (
    <div className="proposal is-pending">
      <div className="proposal-head">
        <span className="proposal-icon">
          <ListChecks />
        </span>
        <div className="proposal-heading">
          <span className="proposal-title">À valider</span>
          <span className="proposal-summary">
            {p.ops.length} changement{p.ops.length > 1 ? "s" : ""} préparé{p.ops.length > 1 ? "s" : ""}, rien n'est encore fait
          </span>
        </div>
      </div>
      <OpsList ops={p.ops} />
      <div className="proposal-actions">
        <Button size="sm" variant="ghost" loading={busy === "discard"} onClick={() => void run("discard", () => api.discardProposal(p.id), "Écarté.").then(after)}>
          Écarter
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Check />}
          loading={busy === "apply"}
          onClick={() =>
            void run(
              "apply",
              () => api.applyProposal(p.id),
              (r) => `${r.applied.length} changement${r.applied.length > 1 ? "s" : ""} appliqué${r.applied.length > 1 ? "s" : ""}.`,
            ).then(after)
          }
        >
          Appliquer
        </Button>
      </div>
    </div>
  );
}

function OpsList({ ops }: { ops: Proposal["ops"] }) {
  return (
    <ul className="proposal-items">
      {ops.map((o, i) => (
        <li key={i} className="proposal-item">
          <div className="proposal-item-main">
            <div className="proposal-item-title">
              <span className="proposal-kind">{TOOL_LABELS[o.tool] ?? o.tool}</span>
            </div>
            <div className="proposal-item-details">{o.summary}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
