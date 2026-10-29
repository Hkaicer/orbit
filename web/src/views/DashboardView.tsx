import { PHASES, type Dashboard, type KpiKey } from "@shared/types";
import { ArrowRight, Briefcase, CalendarClock, CheckCircle2, Plus } from "lucide-react";
import { useState } from "react";
import { BarList, ChartCard, StatTile } from "../components/charts";
import { KpiDialog } from "../components/KpiDialog";
import { ConfirmationCard, DueBadge, PendingActionCard, Section, ViewHeader } from "../components/bits";
import { Button, Empty, ErrorState, Spinner } from "../components/ui";
import { DEADLINE_LABELS, fmtDate } from "../lib/format";
import { errorMessage, useApplications, useDashboard } from "../lib/queries";
import { useUi } from "../lib/store";

const PRIORITY_LABELS: Record<string, string> = {
  confirm: "À confirmer",
  validate: "À valider",
  todo_external: "À faire",
  test: "Test",
  interview: "Entretien",
  followup: "Relance",
  deadline: "Échéance",
  analyze: "À analyser",
};

export function DashboardView() {
  const ui = useUi();
  const dash = useDashboard();
  const apps = useApplications();
  const d = dash.data;
  const [kpi, setKpi] = useState<KpiKey | null>(null);

  return (
    <>
      <ViewHeader
        title="Tableau de bord"
        sub={new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}
        actions={
          <Button size="sm" variant="primary" icon={<Plus />} onClick={() => ui.set({ importOpen: true })}>
            Ajouter une offre
          </Button>
        }
      />
      <div className="view-body">
        <div className="view-inner">
          {dash.isLoading && <Spinner label="Chargement" />}
          {dash.error && <ErrorState message={errorMessage(dash.error)} onRetry={() => void dash.refetch()} />}
          {d && (
            <>
              <div className="perf-kpis kpis-6">
                <StatTile label="Nouvelles offres" value={d.counts.newOffers} hint="à trier" onClick={() => setKpi("newOffers")} />
                <StatTile label="Candidatures actives" value={d.counts.active} hint="en cours" onClick={() => setKpi("active")} />
                <StatTile label="En attente" value={d.counts.waiting} hint="envoyées, suite attendue" onClick={() => setKpi("waiting")} />
                <StatTile label="Tests" value={d.counts.tests} hint="à faire" onClick={() => setKpi("tests")} />
                <StatTile label="Entretiens" value={d.counts.interviews} hint="proposés ou confirmés" onClick={() => setKpi("interviews")} />
                <StatTile label="Sans réponse" value={d.counts.noAnswer} hint="relance à envisager" onClick={() => setKpi("noAnswer")} />
              </div>
              <KpiDialog kpi={kpi} onClose={() => setKpi(null)} />

              <Section title="À faire maintenant" hint="Classé par urgence : confirmations, validations, échéances proches, relances.">
                {d.priorities.length === 0 ? (
                  <Empty small icon={<CheckCircle2 />} title="Rien d'urgent" body="Les confirmations et les échéances apparaîtront ici." />
                ) : (
                  <ul className="prio-list">
                    {d.priorities.map((p, i) => (
                      <li key={i}>
                        <button type="button" className="prio-row" onClick={() => (p.applicationId ? ui.go("applications", p.applicationId) : p.offerId ? ui.go("offers", p.offerId) : undefined)}>
                          <span className={`prio-kind is-${p.kind}`}>{PRIORITY_LABELS[p.kind] ?? p.kind}</span>
                          <span className="prio-main">
                            <span className="prio-title truncate">{p.title}</span>
                            <span className="prio-detail truncate">{p.detail}</span>
                          </span>
                          {p.due && <DueBadge due={p.due} />}
                          <ArrowRight className="prio-go" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {d.confirmations.length > 0 && (
                <Section title="Confirmations à donner" hint="Lu dans Gmail ou proposé par Claude. Aucun statut ne change sans votre accord.">
                  <div className="card-stack">
                    {d.confirmations.map((c) => (
                      <ConfirmationCard key={c.evidence.id} item={c} />
                    ))}
                  </div>
                </Section>
              )}

              {d.pendingActions.length > 0 && (
                <Section title="Actions externes" hint="Envois, dépôts ou formulaires : chacun attend votre accord, un par un.">
                  <div className="card-stack">
                    {d.pendingActions.map((a) => (
                      <PendingActionCard key={a.id} action={a} />
                    ))}
                  </div>
                </Section>
              )}

              <div className="dash-grid">
                <Upcoming items={d.upcoming} />
                <ChartCard
                  title="Candidatures par étape"
                  table={{ head: ["Étape", "Candidatures"], rows: PHASES.map((p) => [p.label, (apps.data ?? []).filter((a) => p.statuses.includes(a.status)).length]) }}
                >
                  {apps.data && apps.data.length > 0 ? (
                    <BarList rows={PHASES.map((p) => ({ key: p.id, label: p.label, value: (apps.data ?? []).filter((a) => p.statuses.includes(a.status)).length }))} format={(n) => String(n)} />
                  ) : (
                    <Empty small icon={<Briefcase />} title="Aucune candidature" body="Créez-en une depuis une offre." />
                  )}
                </ChartCard>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Upcoming({ items }: { items: Dashboard["upcoming"] }) {
  const ui = useUi();
  return (
    <figure className="perf-card">
      <div className="perf-card-head">
        <figcaption className="perf-card-title">Prochaines échéances</figcaption>
      </div>
      {items.length === 0 ? (
        <Empty small icon={<CalendarClock />} title="Aucune échéance" body="Tests, entretiens et relances datés." />
      ) : (
        <ul className="upcoming-list">
          {items.map((u) => (
            <li key={u.id}>
              <button type="button" className="upcoming-row" onClick={() => ui.go("applications", u.applicationId)}>
                <span className="upcoming-date tnum">{u.dueAt ? fmtDate(u.dueAt, false) : "sans date"}</span>
                <span className="upcoming-main">
                  <span className="truncate">
                    {DEADLINE_LABELS[u.kind]} · {u.title}
                  </span>
                  <span className="text-3 truncate">
                    {u.company} · {u.offerTitle}
                  </span>
                </span>
                <DueBadge due={u.dueAt} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
