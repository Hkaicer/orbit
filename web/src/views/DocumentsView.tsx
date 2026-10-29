import type { DocKind, LibraryDocument } from "@shared/types";
import { Copy, Eye, FileText, FolderSearch, Lock, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PathLink, ViewHeader, useAction } from "../components/bits";
import { Badge, Button, Dialog, Empty, ErrorState, IconButton, Spinner, Switch } from "../components/ui";
import { api, type IndexResult } from "../lib/api";
import { DOC_KIND_LABELS, DOC_STATUS_LABELS, fileName, fmtDate, sizeLabel } from "../lib/format";
import { errorMessage, useDocuments, useSettings } from "../lib/queries";

type StatusFilter = "" | LibraryDocument["status"] | "signals" | "private";

export function DocumentsView() {
  const settings = useSettings();
  const [kind, setKind] = useState<DocKind | "">("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [report, setReport] = useState<IndexResult | null>(null);
  const [preview, setPreview] = useState<LibraryDocument | null>(null);
  const docs = useDocuments({ kind: kind || undefined, q: q.trim() || undefined });
  const { busy, run } = useAction();
  const rows = useMemo(
    () =>
      (docs.data ?? []).filter((d) => {
        if (status === "signals") return d.signals.length > 0;
        if (status === "private") return d.private;
        return !status || d.status === status;
      }),
    [docs.data, status],
  );

  const reindex = async () => {
    const r = await run(
      "reindex",
      () => api.reindex(),
      (x) => `${x.indexed} fichier${x.indexed > 1 ? "s" : ""} lu${x.indexed > 1 ? "s" : ""}, ${x.unchanged} inchangé${x.unchanged > 1 ? "s" : ""}.`,
    );
    if (r) setReport(r);
  };

  return (
    <>
      <ViewHeader
        title="Documents"
        sub={docs.data ? `${docs.data.length} fichier${docs.data.length > 1 ? "s" : ""}, en lecture seule` : undefined}
        actions={
          <Button size="sm" icon={<RefreshCw />} loading={busy === "reindex"} onClick={() => void reindex()}>
            Relire les dossiers
          </Button>
        }
      />
      <div className="view-body">
        <div className="view-inner">
          <div className="callout callout-accent banner">
            <FolderSearch />
            <span>
              ORBIT lit ces dossiers sans jamais déplacer, renommer ni modifier un fichier :{" "}
              {(settings.data?.documentRoots ?? []).map((r, i) => (
                <span key={r}>
                  {i > 0 && ", "}
                  <PathLink path={r} label={fileName(r)} folder />
                </span>
              ))}
              . Un document marqué privé n'est jamais transmis à Claude.
            </span>
          </div>

          {report && (report.errors.length > 0 || report.roots.some((r) => r.missing)) && (
            <div className="callout callout-warning">
              {report.roots
                .filter((r) => r.missing)
                .map((r) => (
                  <p key={r.root}>Dossier introuvable : {r.root}</p>
                ))}
              {report.errors.slice(0, 5).map((e) => (
                <p key={e.path}>
                  {fileName(e.path)} : {e.error}
                </p>
              ))}
            </div>
          )}

          <div className="toolbar">
            <div className="search-box">
              <Search />
              <input className="input input-bare" placeholder="Nom, entreprise..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher un document" />
            </div>
            <select className="select select-sm" value={kind} onChange={(e) => setKind(e.target.value as DocKind | "")} aria-label="Type de document">
              <option value="">Tous les types</option>
              {(Object.keys(DOC_KIND_LABELS) as DocKind[]).map((k) => (
                <option key={k} value={k}>
                  {DOC_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <select className="select select-sm" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Filtrer">
              <option value="">Tous les états</option>
              {(Object.keys(DOC_STATUS_LABELS) as LibraryDocument["status"][]).map((s) => (
                <option key={s} value={s}>
                  {DOC_STATUS_LABELS[s]}
                </option>
              ))}
              <option value="signals">Avec un signal</option>
              <option value="private">Privés</option>
            </select>
          </div>

          {docs.isLoading && <Spinner label="Chargement" />}
          {docs.error && <ErrorState message={errorMessage(docs.error)} onRetry={() => void docs.refetch()} />}
          {docs.data && rows.length === 0 && <Empty icon={<FileText />} title="Aucun document" body="Relisez les dossiers, ou vérifiez leur chemin dans les réglages." />}
          <ul className="doc-list">
            {rows.map((d) => (
              <DocRow key={d.id} doc={d} onPreview={() => setPreview(d)} />
            ))}
          </ul>
        </div>
      </div>
      <PreviewDialog doc={preview} onClose={() => setPreview(null)} />
    </>
  );
}

function DocRow({ doc: d, onPreview }: { doc: LibraryDocument; onPreview: () => void }) {
  const { run } = useAction();
  return (
    <li className={`doc-row ${d.private ? "is-private" : ""}`}>
      <span className={`doc-ext ext-${d.ext.replace(".", "")}`}>{d.ext.replace(".", "").toUpperCase()}</span>
      <span className="doc-main">
        <span className="doc-name truncate" title={d.path}>
          {d.name}
        </span>
        <span className="text-3 truncate">{[DOC_KIND_LABELS[d.kind], d.company, d.language?.toUpperCase(), sizeLabel(d.size), `modifié le ${fmtDate(d.mtime)}`].filter(Boolean).join(" · ")}</span>
        {d.signals.length > 0 && (
          <span className="doc-signals">
            {d.signals.map((s) => (
              <span key={s} className={/retouché|manuelle/.test(s) ? "is-warning" : undefined}>
                {s}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="doc-badges">
        <Badge tone={d.status === "master" ? "accent" : d.status === "adapted" ? "success" : "outline"}>{DOC_STATUS_LABELS[d.status]}</Badge>
        {d.pairPath && <Badge tone="outline">{d.ext === ".pdf" ? "+ DOCX" : "+ PDF"}</Badge>}
        {d.duplicates.length > 0 && (
          <Badge tone="warning">
            <Copy /> {d.duplicates.length} copie{d.duplicates.length > 1 ? "s" : ""}
          </Badge>
        )}
        {d.private && (
          <Badge tone="danger">
            <Lock /> Privé
          </Badge>
        )}
      </span>
      <span className="doc-flags">
        <label className="flag">
          <Switch
            checked={d.validated}
            label={`Validé : ${d.name}`}
            onChange={(v) => void run("flag", () => api.documentFlags(d.id, { validated: v }), v ? "Marqué comme validé." : "Validation retirée.")}
          />
          <span>Validé</span>
        </label>
        <label className="flag">
          <Switch
            checked={d.private}
            label={`Privé : ${d.name}`}
            onChange={(v) => void run("flag", () => api.documentFlags(d.id, { private: v }), v ? "Ce document ne sera jamais transmis à Claude." : "Document de nouveau consultable par Claude.")}
          />
          <span>Privé</span>
        </label>
      </span>
      <span className="doc-actions">
        {d.hasText && (
          <IconButton size="sm" label="Aperçu du texte" onClick={onPreview}>
            <Eye />
          </IconButton>
        )}
        <PathLink path={d.path} label="" />
      </span>
    </li>
  );
}

function PreviewDialog({ doc, onClose }: { doc: LibraryDocument | null; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    setError(null);
    if (!doc) return;
    let live = true;
    api.documentText(doc.id).then(
      (r) => live && setText(r.text),
      (err) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [doc]);
  return (
    <Dialog open={doc !== null} onClose={onClose} title={doc?.name} size="xl" labelledBy="doc-preview-title">
      <div className="dialog-body">
        <p className="text-3 small">Texte extrait pour la lecture, la mise en page n'est pas reproduite. Le fichier n'est pas modifié.</p>
        {error && <div className="callout callout-danger">{error}</div>}
        {text === null && !error && <Spinner label="Chargement" />}
        {text !== null && <pre className="doc-preview">{text}</pre>}
      </div>
    </Dialog>
  );
}
