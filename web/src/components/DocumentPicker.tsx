import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DOC_STATUS_LABELS, fmtDate } from "../lib/format";
import { useDocuments } from "../lib/queries";
import { Badge, Button, Dialog, Spinner } from "./ui";

/** Choose which CV or letter of the library an application used. Files are only referenced, never copied or changed. */
export function DocumentPicker({
  kind,
  current,
  company,
  onPick,
  onClose,
}: {
  kind: "cv" | "letter" | null;
  current: string | null;
  company: string;
  onPick: (path: string | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const docs = useDocuments(kind ? { kind } : {});
  useEffect(() => setQ(""), [kind]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const key = company.toLowerCase();
    return (docs.data ?? [])
      .filter((d) => !needle || d.name.toLowerCase().includes(needle) || (d.company ?? "").toLowerCase().includes(needle))
      .sort((a, b) => Number((b.company ?? "").toLowerCase() === key) - Number((a.company ?? "").toLowerCase() === key) || b.mtime.localeCompare(a.mtime));
  }, [docs.data, q, company]);

  return (
    <Dialog open={kind !== null} onClose={onClose} title={kind === "cv" ? "Choisir le CV utilisé" : "Choisir la lettre utilisée"} size="lg" labelledBy="pick-doc-title">
      <div className="dialog-body">
        <div className="search-box">
          <Search />
          <input className="input input-bare" placeholder="Nom du fichier ou entreprise" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher" data-autofocus />
        </div>
        {docs.isLoading && <Spinner label="Chargement" />}
        <ul className="pick-list">
          {rows.map((d) => (
            <li key={d.id}>
              <button type="button" className={`pick-row ${d.path === current ? "is-current" : ""}`} onClick={() => onPick(d.path)}>
                <span className="pick-main">
                  <span className="truncate">{d.name}</span>
                  <span className="text-3 truncate">{[d.company, d.language?.toUpperCase(), fmtDate(d.mtime)].filter(Boolean).join(" · ")}</span>
                </span>
                <Badge tone={d.status === "master" ? "accent" : d.status === "adapted" ? "success" : "outline"}>{DOC_STATUS_LABELS[d.status]}</Badge>
                {d.validated && <Badge tone="success">Validé</Badge>}
              </button>
            </li>
          ))}
          {docs.data && rows.length === 0 && <li className="text-3">Aucun document. Vérifiez les dossiers indexés dans les réglages.</li>}
        </ul>
      </div>
      <div className="dialog-footer">
        {current && (
          <Button variant="danger-ghost" onClick={() => onPick(null)}>
            Retirer le lien
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          Fermer
        </Button>
      </div>
    </Dialog>
  );
}
