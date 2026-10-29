import type { HistoryEvent } from "@shared/types";
import { History } from "lucide-react";
import { useMemo, useState } from "react";
import { ViewHeader } from "../components/bits";
import { Empty, ErrorState, Segmented, Spinner } from "../components/ui";
import { ACTOR_LABELS, fmtDate } from "../lib/format";
import { errorMessage, useHistory } from "../lib/queries";
import { useUi } from "../lib/store";

type Who = "all" | HistoryEvent["actor"];

export function HistoryView() {
  const ui = useUi();
  const [who, setWho] = useState<Who>("all");
  const events = useHistory({ limit: 1000 });
  const groups = useMemo(() => {
    const out = new Map<string, HistoryEvent[]>();
    for (const e of events.data ?? []) {
      if (who !== "all" && e.actor !== who) continue;
      const day = e.at.slice(0, 10);
      out.set(day, [...(out.get(day) ?? []), e]);
    }
    return [...out.entries()];
  }, [events.data, who]);

  return (
    <>
      <ViewHeader title="Historique" sub="Tout ce qui a été fait, par qui et quand" />
      <div className="view-body">
        <div className="view-inner view-inner-narrow">
          <div className="toolbar">
            <Segmented<Who>
              label="Filtrer par auteur"
              value={who}
              onChange={setWho}
              options={[
                { value: "all", label: "Tout" },
                { value: "user", label: "Vous" },
                { value: "agent", label: "Assistant IA" },
                { value: "gmail", label: "Gmail" },
                { value: "import", label: "Import" },
                { value: "system", label: "ORBIT" },
              ]}
            />
          </div>
          {events.isLoading && <Spinner label="Chargement" />}
          {events.error && <ErrorState message={errorMessage(events.error)} onRetry={() => void events.refetch()} />}
          {events.data && groups.length === 0 && <Empty icon={<History />} title="Rien pour l'instant" />}
          {groups.map(([day, list]) => (
            <section key={day} className="history-day">
              <h2 className="history-date">{fmtDate(day)}</h2>
              <ol className="timeline">
                {list.map((e) => (
                  <li key={e.id} className={`tl-item is-${e.actor}`}>
                    <span className="tl-dot" />
                    <span className="tl-body">
                      {e.applicationId || e.offerId ? (
                        <button type="button" className="tl-link" onClick={() => (e.applicationId ? ui.go("applications", e.applicationId) : ui.go("offers", e.offerId))}>
                          {e.summary}
                        </button>
                      ) : (
                        <span>{e.summary}</span>
                      )}
                      <span className="text-3">
                        {new Date(e.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · {ACTOR_LABELS[e.actor]}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
