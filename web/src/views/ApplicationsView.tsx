import { MODE_LABELS, PHASES, STATUSES, STATUS_LABELS, type Application, type ApplicationDetail, type Deadline, type Mode, type Status } from "@shared/types";
import { ArrowLeft, Briefcase, CalendarPlus, Check, Download, FileText, FolderPlus, LayoutList, Mail, Search, Sparkles, SquareKanban, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmationCard, DueBadge, PathLink, PendingActionCard, ScoreChip, Section, StatusBadge, StatusPicker, ViewHeader, useAction, useChangeStatus } from "../components/bits";
import { DocumentPicker } from "../components/DocumentPicker";
import { Badge, Button, Empty, ErrorState, IconButton, Segmented, Spinner } from "../components/ui";
import { documentsPrompt } from "../components/AnalysisPanel";
import { api, downloadUrl } from "../lib/api";
import { ACTOR_LABELS, DEADLINE_LABELS, MAIL_LABELS, fileName, fmtDate, fmtDateTime, relative } from "../lib/format";
import { errorMessage, useApplication, useApplications } from "../lib/queries";
import { useUi } from "../lib/store";

export function ApplicationsView() {
  const ui = useUi();
  return ui.id ? <ApplicationPage id={ui.id} /> : <ApplicationList />;
}

type Layout = "board" | "list";

function ApplicationList() {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return localStorage.getItem("orbit.appsLayout") === "list" ? "list" : "board";
    } catch {
      return "board";
    }
  });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status | "">("");
  const apps = useApplications({ q: q.trim() || undefined, status: status || undefined });
  const chooseLayout = (l: Layout) => {
    setLayout(l);
    try {
      localStorage.setItem("orbit.appsLayout", l);
    } catch {
      /* only a convenience */
    }
  };

  return (
    <>
      <ViewHeader title="Candidatures" sub={apps.data ? `${apps.data.length} au total` : undefined} />
      <div className="view-body">
        <div className={`view-inner ${layout === "board" ? "view-inner-wide" : ""}`}>
          <div className="toolbar">
            <div className="search-box">
              <Search />
              <input className="input input-bare" placeholder="Entreprise ou poste..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher une candidature" />
            </div>
            <select className="select select-sm" value={status} onChange={(e) => setStatus(e.target.value as Status | "")} aria-label="Filtrer par statut">
              <option value="">Tous les statuts</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <Segmented<Layout>
              label="Affichage"
              value={layout}
              onChange={chooseLayout}
              options={[
                { value: "board", label: "Étapes", icon: <SquareKanban /> },
                { value: "list", label: "Liste", icon: <LayoutList /> },
              ]}
            />
          </div>
          {apps.isLoading && <Spinner label="Chargement" />}
          {apps.error && <ErrorState message={errorMessage(apps.error)} onRetry={() => void apps.refetch()} />}
          {apps.data && apps.data.length === 0 && <Empty icon={<Briefcase />} title="Aucune candidature" body="Ouvrez une offre et choisissez « Créer la candidature »." />}
          {apps.data && apps.data.length > 0 && (layout === "board" ? <Board apps={apps.data} /> : <List apps={apps.data} />)}
        </div>
      </div>
    </>
  );
}

function Board({ apps }: { apps: Application[] }) {
  return (
    <div className="board">
      {PHASES.map((p) => {
        const items = apps.filter((a) => p.statuses.includes(a.status));
        return (
          <section key={p.id} className="board-col" aria-label={p.label}>
            <header className="board-head">
              <span>{p.label}</span>
              <span className="board-count tnum">{items.length}</span>
            </header>
            <div className="board-items">
              {items.map((a) => (
                <AppCard key={a.id} app={a} />
              ))}
              {items.length === 0 && <p className="board-empty">Aucune</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function AppCard({ app: a }: { app: Application }) {
  const ui = useUi();
  return (
    <button type="button" className="app-card" onClick={() => ui.go("applications", a.id)}>
      <span className="app-card-top">
        <strong className="truncate">{a.offer.company}</strong>
        <ScoreChip score={a.offer.score} />
      </span>
      <span className="app-card-title">{a.offer.title}</span>
      <span className="app-card-foot">
        <StatusBadge status={a.status} />
        {a.nextActionDue && <DueBadge due={a.nextActionDue} />}
      </span>
      {a.nextAction && <span className="app-card-next truncate">{a.nextAction}</span>}
    </button>
  );
}

function List({ apps }: { apps: Application[] }) {
  const ui = useUi();
  return (
    <ul className="row-list">
      {apps.map((a) => (
        <li key={a.id} className="list-row list-row-split">
          <button type="button" className="list-open" onClick={() => ui.go("applications", a.id)}>
            <ScoreChip score={a.offer.score} />
            <span className="list-main">
              <span className="list-title truncate">
                <strong>{a.offer.company}</strong> · {a.offer.title}
              </span>
              <span className="list-meta truncate">{[a.sentAt && `envoyée le ${fmtDate(a.sentAt)}`, a.nextAction].filter(Boolean).join(" · ") || "Pas de prochaine action"}</span>
            </span>
          </button>
          <span className="list-badges">
            <StatusPicker app={a} />
            {a.nextActionDue && <DueBadge due={a.nextActionDue} />}
          </span>
          <span className="list-date text-3">{relative(a.updatedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

const MODE_HINTS: Record<Mode, string> = {
  A: "Claude prépare chaque changement et vous le validez avant qu'il soit fait.",
  B: "Les étapes locales (fiche, analyse, dossier) sont faites seules. Tout ce qui sort de l'ordinateur attend votre accord.",
  C: "Claude enchaîne le plus d'étapes possible. Tout ce qui sort de l'ordinateur attend toujours votre accord.",
};

function ApplicationPage({ id }: { id: string }) {
  const ui = useUi();
  const q = useApplication(id);
  const a = q.data;
  return (
    <>
      <ViewHeader
        leading={
          <IconButton label="Retour aux candidatures" onClick={() => ui.go("applications")}>
            <ArrowLeft />
          </IconButton>
        }
        title={a ? a.offer.company : "Candidature"}
        sub={a?.offer.title}
        actions={
          a && (
            <Button size="sm" variant="ghost" icon={<Briefcase />} onClick={() => ui.go("offers", a.offerId)}>
              Voir l'offre
            </Button>
          )
        }
      />
      <div className="view-body">
        <div className="view-inner">
          {q.isLoading && <Spinner label="Chargement" />}
          {q.error && <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />}
          {a && <ApplicationBody app={a} />}
        </div>
      </div>
    </>
  );
}

function ApplicationBody({ app: a }: { app: ApplicationDetail }) {
  const ui = useUi();
  const { busy, run } = useAction();
  // Proposals that would change something, one per status (the latest email).
  const open = a.evidence.filter((e, i, all) => !e.confirmed && e.suggests !== a.status && all.findIndex((x) => !x.confirmed && x.suggests === e.suggests) === i);
  const actions = a.pendingActions.filter((p) => p.status === "pending" || p.status === "approved");
  const notes = a.history.filter((h) => h.kind === "note");
  const ask = (text: string) => ui.ask(`${text} (candidature ${a.id} : ${a.offer.company}, « ${a.offer.title} »)`);

  return (
    <>
      <div className="app-strip">
        <StatusBadge status={a.status} />
        {a.sentAt && <span className="text-2">Envoyée le {fmtDate(a.sentAt)}</span>}
        <span className="app-strip-mode">
          <span className="text-3">Mode</span>
          <Segmented<Mode>
            label="Mode d'action de Claude pour cette candidature"
            value={a.mode}
            onChange={(m) => void run("mode", () => api.setMode(a.id, m), `Mode ${MODE_LABELS[m]}.`)}
            options={(["A", "B", "C"] as Mode[]).map((m) => ({ value: m, label: m, ariaLabel: `${MODE_LABELS[m]} : ${MODE_HINTS[m]}` }))}
          />
        </span>
      </div>

      {open.length > 0 && (
        <Section title="À confirmer" hint="Rien ne change sans votre accord.">
          <div className="card-stack">
            {open.map((e) => (
              <ConfirmationCard key={e.id} item={{ evidence: e, application: { id: a.id, status: a.status, offer: a.offer } }} showApplication={false} />
            ))}
          </div>
        </Section>
      )}

      {actions.length > 0 && (
        <Section title="Actions externes">
          <div className="card-stack">
            {actions.map((p) => (
              <PendingActionCard key={p.id} action={p} />
            ))}
          </div>
        </Section>
      )}

      <div className="detail-grid">
        <div className="detail-main">
          <NextAction app={a} />
          <Deadlines app={a} />

          <Section title="E-mails liés" hint="Lus dans Gmail, en lecture seule.">
            {a.mails.length === 0 ? (
              <p className="text-3">Aucun e-mail rattaché.</p>
            ) : (
              <ul className="mail-rows">
                {a.mails.map((m) => (
                  <li key={m.id} className="mail-item">
                    <Mail />
                    <span className="mail-item-main">
                      <span className="truncate">
                        <strong>{m.subject}</strong>
                      </span>
                      <span className="text-3 truncate">
                        {m.from} · {fmtDateTime(m.date)}
                      </span>
                      {m.snippet && <span className="mail-snippet">{m.snippet}</span>}
                    </span>
                    <Badge tone={m.category === "refusal" ? "danger" : m.category === "other" ? "outline" : "accent"}>{MAIL_LABELS[m.category]}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Notes app={a} notes={notes} />

          <Section title="Historique">
            <ol className="timeline">
              {a.history.map((h) => (
                <li key={h.id} className={`tl-item is-${h.actor}`}>
                  <span className="tl-dot" />
                  <span className="tl-body">
                    <span>{h.summary}</span>
                    <span className="text-3">
                      {fmtDateTime(h.at)} · {ACTOR_LABELS[h.actor]}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        </div>

        <aside className="detail-side">
          <StatusCard app={a} />
          <MadeDocumentsCard app={a} />
          <DocumentsCard app={a} />
          <div className="side-card">
            <h3 className="side-title">Dossier</h3>
            <dl className="kv kv-tight">
              <dt>ORBIT</dt>
              <dd>{a.folder ? <PathLink path={a.folder} label={fileName(a.folder)} folder /> : <span className="text-3">pas encore créé</span>}</dd>
              {a.sourceFolder && (
                <>
                  <dt>D'origine</dt>
                  <dd>
                    <PathLink path={a.sourceFolder} label={fileName(a.sourceFolder)} folder />
                  </dd>
                </>
              )}
            </dl>
            <Button
              size="sm"
              icon={<FolderPlus />}
              loading={busy === "folder"}
              onClick={() =>
                void run(
                  "folder",
                  () => api.writeFolder(a.id),
                  (r) => `Dossier à jour : ${r.written.join(", ")}.`,
                )
              }
            >
              {a.folder ? "Mettre à jour le dossier" : "Créer le dossier"}
            </Button>
            <p className="side-note">Fiche de l'offre, analyse, suivi et sources, dans le dossier Applications d'ORBIT. Le dossier d'origine n'est jamais modifié.</p>
          </div>
          <div className="side-card">
            <h3 className="side-title">Avec Claude</h3>
            <div className="side-actions">
              <Button
                size="sm"
                variant="ghost"
                icon={<Sparkles />}
                onClick={() => ask("Vérifie que le CV et la lettre liés correspondent à l'offre, sans réécrire la lettre : liste seulement les écarts")}
              >
                Vérifier le CV et la lettre
              </Button>
              <Button size="sm" variant="ghost" icon={<Sparkles />} onClick={() => ask("Prépare l'entretien : questions probables, points à mettre en avant, dans PREPARATION_ENTRETIEN.md")}>
                Préparer l'entretien
              </Button>
              <Button size="sm" variant="ghost" icon={<Sparkles />} onClick={() => ask("Propose un texte de relance courte, sans l'envoyer")}>
                Rédiger une relance
              </Button>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

function StatusCard({ app: a }: { app: ApplicationDetail }) {
  const { busy, change } = useChangeStatus();
  const [next, setNext] = useState<Status>(a.status);
  useEffect(() => setNext(a.status), [a.status]);
  return (
    <div className="side-card">
      <h3 className="side-title">Statut</h3>
      <div className="row-gap">
        <select className="select select-sm grow" value={next} onChange={(e) => setNext(e.target.value as Status)} aria-label="Nouveau statut">
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <Button size="sm" variant="primary" disabled={next === a.status} loading={busy === `status-${a.id}`} onClick={() => void change(a, next)}>
          Changer
        </Button>
      </div>
      <p className="side-note">Une candidature préparée n'est jamais comptée comme envoyée sans preuve ou sans votre déclaration.</p>
    </div>
  );
}

/** CVs and letters made by ORBIT for this application: download, or mark as the ones used. */
function MadeDocumentsCard({ app: a }: { app: ApplicationDetail }) {
  const ui = useUi();
  const { busy, run } = useAction();
  // One line per document, with its PDF and DOCX side by side.
  const groups = useMemo(() => {
    const map = new Map<string, { base: string; pdf?: string; docx?: string; mtime: string }>();
    for (const f of a.files ?? []) {
      const base = f.name.replace(/\.(pdf|docx)$/i, "");
      const g = map.get(base) ?? { base, mtime: f.mtime };
      if (/\.pdf$/i.test(f.name)) g.pdf = f.path;
      else g.docx = f.path;
      if (f.mtime > g.mtime) g.mtime = f.mtime;
      map.set(base, g);
    }
    return [...map.values()].sort((x, y) => y.mtime.localeCompare(x.mtime));
  }, [a.files]);
  const isLetter = (base: string) => /^(LM|CoverLetter)_/i.test(base);
  return (
    <div className="side-card">
      <h3 className="side-title">CV et lettre</h3>
      {groups.length === 0 ? (
        <p className="side-note">Aucun document préparé pour cette candidature.</p>
      ) : (
        <ul className="made-list">
          {groups.map((g) => {
            const used = [g.pdf, g.docx].some((p) => p && (p === a.cvPath || p === a.letterPath));
            return (
              <li key={g.base}>
                <span className="made-name" title={g.base}>
                  <FileText />
                  <span className="truncate">{g.base}</span>
                  {used && <Badge tone="success">utilisé</Badge>}
                </span>
                <span className="made-actions">
                  {g.pdf && (
                    <a className="btn btn-sm" href={downloadUrl(g.pdf)} download>
                      <Download /> PDF
                    </a>
                  )}
                  {g.docx && (
                    <a className="btn btn-sm btn-ghost" href={downloadUrl(g.docx)} download>
                      DOCX
                    </a>
                  )}
                  {!used && (g.pdf ?? g.docx) && (
                    <button
                      type="button"
                      className="link small"
                      disabled={busy === g.base}
                      onClick={() =>
                        void run(
                          g.base,
                          () => api.updateApplication(a.id, isLetter(g.base) ? { letterPath: g.pdf ?? g.docx } : { cvPath: g.pdf ?? g.docx }),
                          isLetter(g.base) ? "Lettre liée à la candidature." : "CV lié à la candidature.",
                        )
                      }
                    >
                      {isLetter(g.base) ? "utiliser comme lettre" : "utiliser comme CV"}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Button size="sm" icon={<Sparkles />} onClick={() => ui.ask(documentsPrompt({ id: a.offerId, company: a.offer.company, title: a.offer.title }, a.id))}>
        {groups.length ? "Nouvelle version avec Claude" : "Préparer avec Claude"}
      </Button>
      <p className="side-note">
        Les fichiers sont dans le dossier ORBIT de la candidature. Le bouton PDF ou DOCX les enregistre dans vos Téléchargements. Une nouvelle version ne remplace jamais l'ancienne.
      </p>
    </div>
  );
}

function DocumentsCard({ app: a }: { app: ApplicationDetail }) {
  const { run } = useAction();
  const [picking, setPicking] = useState<"cv" | "letter" | null>(null);
  return (
    <div className="side-card">
      <h3 className="side-title">Documents utilisés</h3>
      <dl className="kv kv-tight">
        <dt>CV</dt>
        <dd className="doc-dd">
          <PathLink path={a.cvPath} label={fileName(a.cvPath)} />
          <button type="button" className="link" onClick={() => setPicking("cv")}>
            {a.cvPath ? "changer" : "choisir"}
          </button>
        </dd>
        <dt>Lettre</dt>
        <dd className="doc-dd">
          <PathLink path={a.letterPath} label={fileName(a.letterPath)} />
          <button type="button" className="link" onClick={() => setPicking("letter")}>
            {a.letterPath ? "changer" : "choisir"}
          </button>
        </dd>
      </dl>
      <DocumentPicker
        kind={picking}
        current={picking === "cv" ? a.cvPath : a.letterPath}
        company={a.offer.company}
        onClose={() => setPicking(null)}
        onPick={async (path) => {
          const k = picking;
          setPicking(null);
          await run("doc", () => api.updateApplication(a.id, k === "cv" ? { cvPath: path } : { letterPath: path }), path ? "Document lié." : "Document retiré.");
        }}
      />
    </div>
  );
}

function NextAction({ app: a }: { app: ApplicationDetail }) {
  const { busy, run } = useAction();
  const [text, setText] = useState(a.nextAction ?? "");
  const [due, setDue] = useState(a.nextActionDue ?? "");
  useEffect(() => {
    setText(a.nextAction ?? "");
    setDue(a.nextActionDue ?? "");
  }, [a.nextAction, a.nextActionDue]);
  const dirty = text !== (a.nextAction ?? "") || due !== (a.nextActionDue ?? "");
  return (
    <Section title="Prochaine action">
      <div className="next-action">
        <input className="input grow" placeholder="Par exemple : relancer le recruteur" value={text} onChange={(e) => setText(e.target.value)} aria-label="Prochaine action" />
        <input className="input input-date" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Avant le" />
        <Button
          size="sm"
          disabled={!dirty}
          loading={busy === "next"}
          onClick={() => void run("next", () => api.updateApplication(a.id, { nextAction: text.trim() || null, nextActionDue: due || null }), "Enregistré.")}
        >
          Enregistrer
        </Button>
      </div>
    </Section>
  );
}

function Deadlines({ app: a }: { app: ApplicationDetail }) {
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<Deadline["kind"]>("test");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const sorted = useMemo(() => [...a.deadlines].sort((x, y) => (x.status === "todo" ? 0 : 1) - (y.status === "todo" ? 0 : 1) || (x.dueAt ?? "9").localeCompare(y.dueAt ?? "9")), [a.deadlines]);
  const add = async () => {
    const r = await run("add", () => api.addDeadline(a.id, { kind, title: title.trim(), dueAt: due || null }), "Échéance ajoutée.");
    if (r) {
      setAdding(false);
      setTitle("");
      setDue("");
    }
  };
  return (
    <Section
      title="Tests, entretiens et échéances"
      actions={
        !adding && (
          <Button size="sm" variant="ghost" icon={<CalendarPlus />} onClick={() => setAdding(true)}>
            Ajouter
          </Button>
        )
      }
    >
      {adding && (
        <div className="next-action add-deadline">
          <select className="select select-sm" value={kind} onChange={(e) => setKind(e.target.value as Deadline["kind"])} aria-label="Type">
            {(Object.keys(DEADLINE_LABELS) as Deadline["kind"][]).map((k) => (
              <option key={k} value={k}>
                {DEADLINE_LABELS[k]}
              </option>
            ))}
          </select>
          <input className="input grow" placeholder="Intitulé" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Intitulé" data-autofocus />
          <input className="input input-date" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Date" />
          <Button size="sm" variant="primary" disabled={!title.trim()} loading={busy === "add"} onClick={() => void add()}>
            Ajouter
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Annuler
          </Button>
        </div>
      )}
      {sorted.length === 0 && !adding && <p className="text-3">Aucune échéance.</p>}
      <ul className="deadline-list">
        {sorted.map((d) => (
          <li key={d.id} className={`deadline is-${d.status}`}>
            <Badge tone={d.kind === "test" ? "warning" : d.kind === "interview" ? "success" : "outline"}>{DEADLINE_LABELS[d.kind]}</Badge>
            <span className="deadline-title">{d.title}</span>
            {d.evidenceId && <span className="text-3 small">depuis un e-mail</span>}
            <span className="deadline-date tnum">{d.dueAt ? fmtDate(d.dueAt) : "sans date"}</span>
            {d.status === "todo" ? (
              <>
                <DueBadge due={d.dueAt} />
                <IconButton size="sm" label="Marquer comme fait" onClick={() => void run(`done-${d.id}`, () => api.deadlineStatus(d.id, "done"), "Marqué comme fait.")}>
                  <Check />
                </IconButton>
                <IconButton size="sm" label="Annuler l'échéance" onClick={() => void run(`cancel-${d.id}`, () => api.deadlineStatus(d.id, "cancelled"), "Échéance annulée.")}>
                  <X />
                </IconButton>
              </>
            ) : (
              <Badge tone={d.status === "done" ? "success" : "neutral"}>{d.status === "done" ? "Fait" : "Annulé"}</Badge>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Notes({ app: a, notes }: { app: ApplicationDetail; notes: ApplicationDetail["history"] }) {
  const { busy, run } = useAction();
  const [text, setText] = useState("");
  const add = async () => {
    if (await run("note", () => api.addNote(a.id, text.trim()), "Note ajoutée.")) setText("");
  };
  return (
    <Section title="Notes">
      <div className="next-action">
        <input
          className="input grow"
          placeholder="Une note pour vous (contact, impression, détail à retenir)"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && text.trim() && void add()}
          aria-label="Nouvelle note"
        />
        <Button size="sm" disabled={!text.trim()} loading={busy === "note"} onClick={() => void add()}>
          Ajouter
        </Button>
      </div>
      {notes.length > 0 && (
        <ul className="note-list">
          {notes.map((n) => (
            <li key={n.id}>
              <FileText />
              <span>{n.summary}</span>
              <span className="text-3">{fmtDate(n.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
