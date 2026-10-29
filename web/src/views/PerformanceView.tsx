import type { JobsPerformance } from "@shared/types";
import { ChartColumnIncreasing } from "lucide-react";
import { useState, type ReactNode } from "react";
import { BarList, ChartCard, ColumnChart, StatTile, type Series } from "../components/charts";
import { ViewHeader } from "../components/bits";
import { Empty, ErrorState, Segmented, Spinner } from "../components/ui";
import { MAIL_LABELS } from "../lib/format";
import { errorMessage, usePerformance } from "../lib/queries";

type Range = "7" | "30" | "90" | "all";
type Tab = "search" | "assistant";

const RANGES: { value: Range; label: string }[] = [
  { value: "7", label: "7 jours" },
  { value: "30", label: "30 jours" },
  { value: "90", label: "90 jours" },
  { value: "all", label: "Depuis le début" },
];

const FLOW: Series[] = [
  { key: "offers", label: "Offres trouvées", color: "var(--series-1)" },
  { key: "sent", label: "Candidatures envoyées", color: "var(--series-2)" },
];

const n = (v: number) => String(v);

/** The change since the previous period of the same length, already signed. */
function delta(cur: number | null, prev: number | null | undefined, unit = ""): { value: number; text: string } | null {
  if (cur === null || prev === null || prev === undefined) return null;
  const d = cur - prev;
  return { value: d, text: `${d > 0 ? "+" : ""}${d}${unit}` };
}

export function PerformanceView() {
  const [range, setRange] = useState<Range>("30");
  const [tab, setTab] = useState<Tab>("search");
  const q = usePerformance(range);
  const p = q.data;
  return (
    <>
      <ViewHeader title="Performance" sub={p?.since ? `depuis le ${new Date(p.since).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}` : "depuis le début"} />
      <div className="view-body">
        <div className="view-inner perf">
          <div className="perf-toolbar">
            <Segmented<Tab>
              label="Partie"
              value={tab}
              onChange={setTab}
              options={[
                { value: "search", label: "Recherche" },
                { value: "assistant", label: "Assistant" },
              ]}
            />
            <Segmented<Range> label="Période" value={range} onChange={setRange} options={RANGES} />
          </div>
          {q.isLoading && <Spinner label="Chargement" />}
          {q.error && <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />}
          {p && (tab === "search" ? <SearchDashboard p={p} /> : <AssistantDashboard p={p} />)}
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="perf-section">
      <h2 className="perf-section-title">{title}</h2>
      {children}
    </section>
  );
}

function SearchDashboard({ p }: { p: JobsPerformance }) {
  const t = p.tiles;
  const vs = p.days ? `par rapport aux ${p.days} jours d'avant` : undefined;
  const values = p.series.map((s) => [s.offers, s.sent]);
  const label = (i: number) => new Date(p.series[i]!.start).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  const tip = (i: number) => (p.bucket === "day" ? label(i) : `Semaine du ${label(i)}`);
  const funnelMax = Math.max(1, ...p.funnel.map((f) => f.value));
  return (
    <>
      <Section title="Vue d'ensemble">
        <div className="perf-kpis">
          <StatTile label="Offres trouvées" value={t.offers} delta={delta(t.offers, t.previous?.offers)} deltaTitle={vs} hint="ajoutées à ORBIT" />
          <StatTile label="Candidatures envoyées" value={t.sent} delta={delta(t.sent, t.previous?.sent)} deltaTitle={vs} hint={`${t.created} préparée${t.created > 1 ? "s" : ""}`} />
          <StatTile
            label="Taux de réponse"
            value={t.responseRate === null ? "–" : `${t.responseRate} %`}
            meter={t.responseRate}
            delta={delta(t.responseRate, t.previous?.responseRate, " pts")}
            deltaTitle={vs}
            hint="des envois de la période, hors accusés de réception"
          />
          <StatTile
            label="Délai de réponse"
            value={t.avgDelay === null ? "–" : `${String(t.avgDelay).replace(".", ",")} j`}
            goodWhenUp={false}
            hint={`en moyenne · ${t.steps} test${t.steps > 1 ? "s" : ""} ou entretien${t.steps > 1 ? "s" : ""}`}
          />
        </div>
        <ChartCard
          title={p.bucket === "day" ? "Activité par jour" : "Activité par semaine"}
          series={FLOW}
          table={{ head: [p.bucket === "day" ? "Jour" : "Semaine", ...FLOW.map((s) => s.label)], rows: p.series.map((s, i) => [tip(i), s.offers, s.sent]) }}
        >
          {values.some((v) => v[0]! + v[1]! > 0) ? <ColumnChart series={FLOW} values={values} xLabel={label} tipTitle={tip} format={n} /> : <NoData />}
        </ChartCard>
      </Section>

      <Section title="Du premier regard à l'offre">
        <div className="perf-grid">
          <ChartCard title="Étapes franchies sur la période" table={{ head: ["Étape", "Nombre"], rows: p.funnel.map((f) => [f.label, f.value]) }}>
            {funnelMax > 0 && p.funnel.some((f) => f.value) ? <BarList rows={p.funnel.map((f) => ({ key: f.key, label: f.label, value: f.value }))} format={n} max={6} /> : <NoData />}
          </ChartCard>
          <ChartCard title="Où en sont vos candidatures" table={{ head: ["Étape", "Candidatures"], rows: p.phases.map((f) => [f.label, f.value]) }}>
            {p.phases.some((f) => f.value) ? <BarList rows={p.phases.map((f) => ({ key: f.id, label: f.label, value: f.value }))} format={n} color="var(--series-2)" /> : <NoData />}
          </ChartCard>
        </div>
      </Section>

      <Section title="Sources et réponses">
        <div className="perf-grid">
          <ChartCard title="D'où viennent les offres" table={{ head: ["Source", "Offres"], rows: p.sources.map((s) => [s.label, s.value]) }}>
            {p.sources.length ? <BarList rows={p.sources.map((s) => ({ key: s.label, label: s.label, value: s.value }))} format={n} max={7} otherLabel="Autres sources" /> : <NoData />}
          </ChartCard>
          <ChartCard title="E-mails rattachés à vos candidatures" table={{ head: ["Type", "E-mails"], rows: p.replies.map((r) => [MAIL_LABELS[r.category], r.value]) }}>
            {p.replies.some((r) => r.value) ? (
              <BarList rows={p.replies.map((r) => ({ key: r.category, label: MAIL_LABELS[r.category], value: r.value }))} format={n} color="var(--series-3)" max={6} />
            ) : (
              <NoData />
            )}
          </ChartCard>
        </div>
      </Section>
    </>
  );
}

function AssistantDashboard({ p }: { p: JobsPerformance }) {
  const a = p.assistant;
  const decided = a.proposalsApplied + a.proposalsDiscarded;
  return (
    <Section title="Ce que l'assistant a fait">
      <div className="perf-kpis">
        <StatTile label="Demandes" value={a.requests} hint="envoyées à l'IA" />
        <StatTile label="Offres ajoutées" value={a.offersAdded} hint={`${a.analyses} analyse${a.analyses > 1 ? "s" : ""}`} />
        <StatTile label="CV et lettres" value={a.documents} hint="préparations de documents" />
        <StatTile
          label="Propositions validées"
          value={decided ? `${a.proposalsApplied} / ${decided}` : "–"}
          meter={decided ? Math.round((100 * a.proposalsApplied) / decided) : null}
          hint={`${a.proposalsDiscarded} écartée${a.proposalsDiscarded > 1 ? "s" : ""} · ${a.statusProposals} statut${a.statusProposals > 1 ? "s" : ""} proposé${a.statusProposals > 1 ? "s" : ""}`}
        />
      </div>
      <p className="perf-note">Compté à partir de l'historique d'ORBIT. La consommation de votre abonnement ou de votre clé d'API ne se voit pas ici : elle se suit sur le site du service (claude.ai, chatgpt.com ou la console de la clé).</p>
    </Section>
  );
}

const NoData = () => <Empty small icon={<ChartColumnIncreasing />} title="Rien sur cette période" />;
