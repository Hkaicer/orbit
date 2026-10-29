import type { KpiItem, KpiKey } from "@shared/types";
import { ArrowRight, Inbox, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { daysFrom, fmtDate, relative } from "../lib/format";
import { errorMessage, useKpi } from "../lib/queries";
import { useUi } from "../lib/store";
import { DueBadge, ScoreChip, StatusBadge, StatusPicker } from "./bits";
import { Button, Dialog, Empty, ErrorState, Spinner } from "./ui";

/** What is behind one dashboard number: the rule that counts it and every offer or application it counts. */
export function KpiDialog({ kpi, onClose }: { kpi: KpiKey | null; onClose: () => void }) {
  const ui = useUi();
  const q = useKpi(kpi);
  const [filter, setFilter] = useState("");
  useEffect(() => setFilter(""), [kpi]);
  const d = q.data && q.data.key === kpi ? q.data : null;
  const items = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (d?.items ?? []).filter((i) => !needle || `${i.company} ${i.title} ${i.detail ?? ""}`.toLowerCase().includes(needle));
  }, [d, filter]);

  const open = (i: KpiItem) => {
    onClose();
    ui.go(i.type === "offer" ? "offers" : "applications", i.id);
  };
  const page = kpi === "newOffers" ? "offers" : "applications";

  return (
    <Dialog open={kpi !== null} onClose={onClose} title={d ? `${d.title} · ${d.items.length}` : "Détail"} size="lg" labelledBy="kpi-title">
      <div className="dialog-body">
        {q.isLoading && <Spinner label="Chargement" />}
        {q.error && <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />}
        {d && (
          <>
            <p className="kpi-rule">{d.rule}</p>
            {d.breakdown.length > 0 && (
              <div className="kpi-breakdown">
                {d.breakdown.map((b) => (
                  <span key={b.status} className="kpi-chip">
                    <StatusBadge status={b.status} />
                    <span className="tnum">{b.count}</span>
                  </span>
                ))}
              </div>
            )}
            {d.items.length > 8 && (
              <div className="search-box">
                <Search />
                <input className="input input-bare" placeholder="Filtrer par entreprise ou poste" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrer la liste" />
              </div>
            )}
            {d.items.length === 0 ? (
              <Empty small icon={<Inbox />} title="Rien ici pour l'instant" />
            ) : (
              <ul className="kpi-list">
                {items.map((i) => (
                  <li key={i.id} className="kpi-row">
                    <button type="button" className="kpi-open" onClick={() => open(i)}>
                      <ScoreChip score={i.score} />
                      <span className="kpi-main">
                        <span className="truncate">
                          <strong>{i.company}</strong> · {i.title}
                        </span>
                        {i.detail && <span className="kpi-detail truncate">{i.detail}</span>}
                        {i.flag && <span className="kpi-flag">{i.flag}</span>}
                      </span>
                    </button>
                    <span className="kpi-side">
                      {i.status && i.type === "application" && <StatusPicker app={{ id: i.id, status: i.status }} />}
                      <ItemDate item={i} />
                    </span>
                    <button type="button" className="kpi-go" onClick={() => open(i)} aria-label={`Ouvrir ${i.company}`}>
                      <ArrowRight className="prio-go" />
                    </button>
                  </li>
                ))}
                {items.length === 0 && <li className="text-3 small">Aucun résultat pour ce filtre.</li>}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="dialog-footer">
        <Button
          variant="ghost"
          onClick={() => {
            onClose();
            ui.go(page);
          }}
        >
          {page === "offers" ? "Ouvrir la page Offres" : "Ouvrir la page Candidatures"}
        </Button>
        <Button variant="primary" onClick={onClose} data-autofocus>
          Fermer
        </Button>
      </div>
    </Dialog>
  );
}

function ItemDate({ item: i }: { item: KpiItem }) {
  if (!i.date || !i.dateKind) return null;
  if (i.dateKind === "due") return <DueBadge due={i.date} />;
  if (i.dateKind === "sent") {
    const n = daysFrom(i.date);
    return (
      <span className="kpi-date">
        envoyée le {fmtDate(i.date)}
        {n !== null && n < 0 ? ` (${-n} j)` : ""}
      </span>
    );
  }
  return <span className="kpi-date">{i.dateKind === "found" ? `trouvée ${relative(i.date)}` : `modifiée ${relative(i.date)}`}</span>;
}
