// How the job search is going over a period: offers found, applications sent,
// answers, tests and interviews, sources, and what the assistant did. Computed
// here from the local data only.

import type { JobsPerformance } from "../../shared/types";
import { PHASES } from "../../shared/types";
import type { Database } from "../db/database";

const DAY = 86_400_000;
const ANSWERS = ["refusal", "interview", "test", "test_done", "offer"];
const STEPS = ["test_todo", "test_done", "interview_proposed", "interview_confirmed", "offer"];

/** A short, stable name for where an offer came from. */
export function sourceLabel(source: string): string {
  if (/^alerte /i.test(source)) return `Alerte ${source.slice(7)}`;
  if (/^lien \((.+)\)$/i.test(source)) return `Lien : ${/^lien \((.+)\)$/i.exec(source)![1]}`;
  const file = /([^\\/()\s]+\.csv)\b/i.exec(source);
  if (file) return `Import (${file[1]})`;
  if (/^texte/i.test(source)) return "Texte collé";
  if (/^manuel$/i.test(source)) return "Formulaire";
  return source.charAt(0).toUpperCase() + source.slice(1);
}

export function performance(db: Database, days: number | null, now: Date = new Date()): JobsPerformance {
  const end = now.getTime();
  const start = days ? end - days * DAY : null;
  const sinceIso = start ? new Date(start).toISOString() : "0000";
  const inRange = (iso: string | null | undefined, from = start, to = end) => Boolean(iso) && (from === null || Date.parse(iso!) >= from) && Date.parse(iso!) < to;

  const offers = db.all<{ id: string; source: string; discovered_at: string }>("SELECT id, source, discovered_at FROM offers");
  const apps = db.all<{ id: string; status: string; created_at: string; sent_at: string | null }>("SELECT id, status, created_at, sent_at FROM applications");
  const mails = db.all<{ application_id: string | null; category: string; date: string }>("SELECT application_id, category, date FROM mails WHERE category NOT IN ('other', 'alert')");
  const steps = db
    .all<{ application_id: string; at: string; details: string | null }>("SELECT application_id, at, details FROM events WHERE kind = 'status' AND application_id IS NOT NULL")
    .map((e) => ({ app: e.application_id, at: e.at, to: (JSON.parse(e.details ?? "{}") as { to?: string }).to ?? "" }));

  // The first answer of the company (not an acknowledgment) after the application was sent.
  const firstAnswer = new Map<string, string>();
  for (const m of mails) {
    if (!m.application_id || !ANSWERS.includes(m.category)) continue;
    const cur = firstAnswer.get(m.application_id);
    if (!cur || m.date < cur) firstAnswer.set(m.application_id, m.date);
  }
  for (const s of steps) {
    if (!["refused", ...STEPS].includes(s.to)) continue;
    const cur = firstAnswer.get(s.app);
    if (!cur || s.at < cur) firstAnswer.set(s.app, s.at);
  }

  const window = (from: number | null, to: number) => {
    const sent = apps.filter((a) => inRange(a.sent_at, from, to));
    const answered = sent.filter((a) => {
      const f = firstAnswer.get(a.id);
      return f && f >= a.sent_at!;
    });
    const delays = answered.map((a) => (Date.parse(firstAnswer.get(a.id)!) - Date.parse(a.sent_at!)) / DAY).filter((d) => d >= 0);
    return {
      offers: offers.filter((o) => inRange(o.discovered_at, from, to)).length,
      created: apps.filter((a) => inRange(a.created_at, from, to)).length,
      sent: sent.length,
      answers: new Set(mails.filter((m) => m.application_id && ANSWERS.includes(m.category) && inRange(m.date, from, to)).map((m) => m.application_id)).size,
      responseRate: sent.length ? Math.round((100 * answered.length) / sent.length) : null,
      steps: new Set(steps.filter((s) => STEPS.includes(s.to) && inRange(s.at, from, to)).map((s) => s.app)).size,
      offersReceived: new Set(steps.filter((s) => s.to === "offer" && inRange(s.at, from, to)).map((s) => s.app)).size,
      avgDelay: delays.length ? Math.round((10 * delays.reduce((x, y) => x + y, 0)) / delays.length) / 10 : null,
    };
  };
  const cur = window(start, end);
  const prev = days && start ? window(start - days * DAY, start) : null;

  // Columns: one per day up to a month, then one per week (at most a year of weeks).
  const firstDate = [...offers.map((o) => o.discovered_at), ...apps.map((a) => a.created_at)].sort()[0];
  const byDay = days !== null && days <= 31;
  const step = byDay ? DAY : 7 * DAY;
  const from = start ?? Math.max(firstDate ? Date.parse(firstDate) : end - 28 * DAY, end - 52 * 7 * DAY);
  const count = Math.max(1, Math.ceil((end - from) / step));
  const series = Array.from({ length: count }, (_, i) => {
    const a = end - (count - i) * step;
    const b = a + step;
    return { start: new Date(a).toISOString(), offers: offers.filter((o) => inRange(o.discovered_at, a, b)).length, sent: apps.filter((x) => inRange(x.sent_at, a, b)).length };
  });

  const sources = new Map<string, number>();
  for (const o of offers.filter((x) => inRange(x.discovered_at))) sources.set(sourceLabel(o.source), (sources.get(sourceLabel(o.source)) ?? 0) + 1);

  const replyCounts = new Map<string, number>();
  // Only emails tied to an application: the others may not be about recruiting at all.
  for (const m of mails.filter((x) => x.application_id && inRange(x.date))) replyCounts.set(m.category, (replyCounts.get(m.category) ?? 0) + 1);

  const proposals = db.all<{ status: string; at: string }>("SELECT status, COALESCE(resolved_at, created_at) AS at FROM proposals").filter((p) => inRange(p.at));
  const events = db.all<{ actor: string; kind: string; summary: string; at: string }>("SELECT actor, kind, summary, at FROM events WHERE at >= ?", sinceIso);

  return {
    days,
    since: start ? new Date(start).toISOString() : null,
    bucket: byDay ? "day" : "week",
    tiles: { ...cur, previous: prev ? { offers: prev.offers, sent: prev.sent, answers: prev.answers, responseRate: prev.responseRate } : null },
    series,
    funnel: [
      { key: "offers", label: "Offres trouvées", value: cur.offers },
      { key: "created", label: "Candidatures préparées", value: cur.created },
      { key: "sent", label: "Candidatures envoyées", value: cur.sent },
      { key: "answers", label: "Réponses de l'entreprise", value: cur.answers },
      { key: "steps", label: "Tests et entretiens", value: cur.steps },
      { key: "offer", label: "Offres reçues", value: cur.offersReceived },
    ],
    sources: [...sources].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    replies: ["ack", "refusal", "test", "test_done", "interview", "offer"].map((c) => ({ category: c as JobsPerformance["replies"][number]["category"], value: replyCounts.get(c) ?? 0 })),
    phases: PHASES.map((p) => ({ id: p.id, label: p.label, value: apps.filter((a) => (p.statuses as string[]).includes(a.status)).length })),
    assistant: {
      requests: Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at >= ?", sinceIso)?.n ?? 0),
      proposalsApplied: proposals.filter((p) => p.status === "applied").length,
      proposalsDiscarded: proposals.filter((p) => p.status === "discarded").length,
      offersAdded: events.filter((e) => e.actor === "agent" && e.kind === "offer" && e.summary.startsWith("Offre ajoutée")).length,
      analyses: events.filter((e) => e.actor === "agent" && e.kind === "analysis").length,
      documents: events.filter((e) => e.actor === "agent" && e.kind === "documents" && e.summary.startsWith("Documents préparés")).length,
      statusProposals: Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence WHERE kind = 'agent' AND created_at >= ?", sinceIso)?.n ?? 0),
    },
  };
}
