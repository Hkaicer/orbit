// What needs the user's attention: confirmations, validations, close dates,
// tests and interviews, applications without an answer, offers to look at.

import type { Analysis, Dashboard, KpiDetails, KpiItem, KpiKey, Status } from "../../shared/types";
import { STATUS_LABELS } from "../../shared/types";
import type { Database } from "../db/database";
import { getApplication, rowToEvidence, rowToPending } from "../domain/applications";

const DAY = 86_400_000;

type AppRow = {
  id: string;
  status: Status;
  company: string;
  title: string;
  score: number | null;
  sent_at: string | null;
  updated_at: string;
  next_action: string | null;
  next_action_due: string | null;
};

const APP_COLUMNS = "a.id, a.status, o.company, o.title, o.score, a.sent_at, a.updated_at, a.next_action, a.next_action_due";
const APP_SELECT = `SELECT ${APP_COLUMNS} FROM applications a JOIN offers o ON o.id = a.offer_id`;
const SENT = "('sent','received','waiting','followup')";
/** The next open deadline of a kind for each application, if any. */
const nextDeadline = (kind: "test" | "interview") =>
  `(SELECT d.title FROM deadlines d WHERE d.application_id = a.id AND d.kind = '${kind}' AND d.status = 'todo' ORDER BY COALESCE(d.due_at, '9999') LIMIT 1) AS dl_title,
   (SELECT d.due_at FROM deadlines d WHERE d.application_id = a.id AND d.kind = '${kind}' AND d.status = 'todo' ORDER BY COALESCE(d.due_at, '9999') LIMIT 1) AS dl_due`;

type DeadlineRow = AppRow & { dl_title: string | null; dl_due: string | null };

/** The rows behind each dashboard number: the count is always the length of this list. */
function kpiRows(db: Database, followupAfterDays: number, now: Date) {
  const cutoff = new Date(now.getTime() - followupAfterDays * DAY).toISOString();
  return {
    newOffers: () =>
      db.all<{ id: string; company: string; title: string; score: number | null; location: string | null; contract: string | null; discovered_at: string; analysis: string | null }>(
        "SELECT id, company, title, score, location, contract, discovered_at, analysis FROM offers WHERE status = 'new' ORDER BY COALESCE(score, -1) DESC, discovered_at DESC",
      ),
    active: () => db.all<AppRow>(`${APP_SELECT} WHERE a.status NOT IN ('refused','closed','offer') ORDER BY a.updated_at DESC`),
    waiting: () => db.all<AppRow>(`${APP_SELECT} WHERE a.status IN ${SENT} ORDER BY COALESCE(a.sent_at, a.updated_at)`),
    tests: () =>
      db.all<DeadlineRow>(
        `SELECT * FROM (SELECT ${APP_COLUMNS}, ${nextDeadline("test")} FROM applications a JOIN offers o ON o.id = a.offer_id) t
         WHERE t.status = 'test_todo' OR t.dl_title IS NOT NULL ORDER BY COALESCE(t.dl_due, '9999')`,
      ),
    interviews: () =>
      db.all<DeadlineRow>(
        `SELECT ${APP_COLUMNS}, ${nextDeadline("interview")} FROM applications a JOIN offers o ON o.id = a.offer_id
         WHERE a.status IN ('interview_proposed','interview_confirmed') ORDER BY COALESCE(dl_due, '9999')`,
      ),
    // Sent, without any email from the company since, for a while.
    noAnswer: () =>
      db.all<AppRow>(
        `${APP_SELECT} WHERE a.status IN ${SENT} AND COALESCE(a.sent_at, a.updated_at) < ?
         AND NOT EXISTS (SELECT 1 FROM mails m WHERE m.application_id = a.id AND m.date > COALESCE(a.sent_at, a.updated_at) AND m.category <> 'ack')
         ORDER BY COALESCE(a.sent_at, a.updated_at)`,
        cutoff,
      ),
  };
}

const KPI_TEXT: Record<KpiKey, { title: string; rule: (days: number) => string }> = {
  newOffers: { title: "Nouvelles offres", rule: () => "Offres à l'état « Nouvelle » : ni retenues, ni ignorées. Les mieux notées en premier." },
  active: { title: "Candidatures actives", rule: () => "Toutes les candidatures qui ne sont ni refusées, ni clôturées, ni arrivées à une offre. Les plus récemment modifiées en premier." },
  waiting: {
    title: "En attente",
    rule: () => "Candidatures envoyées qui attendent la suite : envoyée, réception confirmée, en attente de réponse ou relance à envisager. Les plus anciennes en premier.",
  },
  tests: { title: "Tests à faire", rule: () => "Candidatures au statut « Test à faire », ou avec un test encore à faire dans leurs échéances. La date la plus proche en premier." },
  interviews: { title: "Entretiens", rule: () => "Candidatures au statut « Entretien proposé » ou « Entretien confirmé ». La date la plus proche en premier." },
  noAnswer: {
    title: "Sans réponse",
    rule: (days) =>
      `Candidatures envoyées depuis plus de ${days} jours, sans e-mail de l'entreprise depuis l'envoi (un accusé de réception ne compte pas). Une relance est à envisager. Le délai se règle dans les Réglages.`,
  },
};

const VERDICTS: Record<Analysis["verdict"], string> = { priority: "Postuler en priorité", apply: "Postuler", check: "Vérifier un point", skip: "Ne pas prioriser" };

const appItem = (r: AppRow, date: string | null, dateKind: KpiItem["dateKind"], detail: string | null, flag: string | null = null): KpiItem => ({
  type: "application",
  id: r.id,
  company: r.company,
  title: r.title,
  status: r.status,
  score: r.score,
  date,
  dateKind: date ? dateKind : null,
  detail,
  flag,
});

/** The list behind one dashboard number, for its detail window. */
export function kpiDetails(db: Database, key: KpiKey, followupAfterDays: number, now: Date = new Date()): KpiDetails {
  const rows = kpiRows(db, followupAfterDays, now);
  const today = now.toISOString().slice(0, 10);
  let items: KpiItem[];
  switch (key) {
    case "newOffers":
      items = rows.newOffers().map((o) => {
        let a: Analysis | null = null;
        try {
          a = o.analysis ? (JSON.parse(o.analysis) as Analysis) : null;
        } catch {
          a = null;
        }
        const blocking = a?.practical?.find((p) => p.severity === "blocking");
        return {
          type: "offer" as const,
          id: o.id,
          company: o.company,
          title: o.title,
          status: null,
          score: o.score,
          date: o.discovered_at,
          dateKind: "found" as const,
          detail: [a ? VERDICTS[a.verdict] : o.score !== null ? "Score importé, sans analyse détaillée" : "Pas encore analysée", o.location, o.contract].filter(Boolean).join(" · "),
          flag: blocking ? `Bloquant : ${blocking.label}` : null,
        };
      });
      break;
    case "active":
      items = rows
        .active()
        .map((r) =>
          appItem(r, r.next_action_due ?? r.updated_at, r.next_action_due ? "due" : "updated", r.next_action, r.next_action_due && r.next_action_due < today ? "Prochaine action en retard" : null),
        );
      break;
    case "waiting":
      items = rows.waiting().map((r) => appItem(r, r.sent_at ?? r.updated_at, r.sent_at ? "sent" : "updated", r.next_action));
      break;
    case "tests":
    case "interviews": {
      const none = key === "tests" ? "Aucune date de test enregistrée" : "Aucune date d'entretien enregistrée";
      items = (key === "tests" ? rows.tests() : rows.interviews()).map((r) => appItem(r, r.dl_due, "due", r.dl_title ?? none, r.dl_due && r.dl_due < today ? "Date dépassée" : null));
      break;
    }
    case "noAnswer":
      items = rows.noAnswer().map((r) => appItem(r, r.sent_at ?? r.updated_at, r.sent_at ? "sent" : "updated", r.next_action ?? "Relance à envisager"));
      break;
  }
  const byStatus = new Map<Status, number>();
  for (const i of items) if (i.status) byStatus.set(i.status, (byStatus.get(i.status) ?? 0) + 1);
  return {
    key,
    title: KPI_TEXT[key].title,
    rule: KPI_TEXT[key].rule(followupAfterDays),
    items,
    breakdown: byStatus.size > 1 ? [...byStatus].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count) : [],
  };
}

export function dashboard(db: Database, followupAfterDays: number, now: Date = new Date()): Dashboard {
  const today = now.toISOString().slice(0, 10);
  const soon = new Date(now.getTime() + 7 * DAY).toISOString().slice(0, 10);

  const seen = new Set<string>();
  const confirmations = db
    .all("SELECT * FROM evidence WHERE confirmed = 0 AND dismissed = 0 ORDER BY COALESCE(mail_date, created_at) DESC LIMIT 200")
    .map((r) => {
      const evidence = rowToEvidence(r);
      const a = getApplication(db, evidence.applicationId);
      return { evidence, application: { id: a.id, status: a.status, offer: a.offer } };
    })
    // A proposal of the status already in place changes nothing, and the same proposal twice is shown once (the latest email).
    .filter((c) => {
      const key = `${c.application.id}:${c.evidence.suggests ?? c.evidence.id}`;
      if (c.evidence.suggests === c.application.status || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 50);
  const pendingActions = db.all("SELECT * FROM pending_actions WHERE status IN ('pending','approved') ORDER BY created_at DESC").map(rowToPending);

  const upcoming = db
    .all<Record<string, unknown>>(
      `SELECT d.*, o.company, o.title AS offer_title FROM deadlines d JOIN applications a ON a.id = d.application_id JOIN offers o ON o.id = a.offer_id
       WHERE d.status = 'todo' ORDER BY COALESCE(d.due_at, '9999') LIMIT 30`,
    )
    .map((r) => ({
      id: String(r.id),
      applicationId: String(r.application_id),
      kind: r.kind as "test" | "interview" | "followup" | "deadline",
      title: String(r.title),
      dueAt: (r.due_at as string | null) ?? null,
      status: "todo" as const,
      evidenceId: (r.evidence_id as string | null) ?? null,
      createdAt: String(r.created_at),
      company: String(r.company),
      offerTitle: String(r.offer_title),
    }));

  const rows = kpiRows(db, followupAfterDays, now);
  const noAnswer = rows.noAnswer();

  const priorities: Dashboard["priorities"] = [];
  for (const c of confirmations.slice(0, 10)) {
    priorities.push({
      kind: "confirm",
      title: `À confirmer : ${c.application.offer.company}`,
      detail: `${c.evidence.mailSubject ?? c.evidence.excerpt ?? "preuve"}${c.evidence.suggests ? ` → ${STATUS_LABELS[c.evidence.suggests]}` : ""}`,
      due: null,
      applicationId: c.application.id,
      offerId: null,
    });
  }
  for (const p of pendingActions) {
    priorities.push({
      kind: p.status === "pending" ? "validate" : "todo_external",
      title: p.status === "pending" ? `À valider : ${p.kind}` : `Validé, à faire par vous : ${p.kind}`,
      detail: p.description.slice(0, 200),
      due: null,
      applicationId: p.applicationId,
      offerId: null,
    });
  }
  for (const d of upcoming.filter((x) => x.dueAt && x.dueAt <= soon)) {
    priorities.push({ kind: d.kind, title: d.dueAt! < today ? `En retard : ${d.title}` : d.title, detail: d.company, due: d.dueAt, applicationId: d.applicationId, offerId: null });
  }
  for (const a of noAnswer.slice(0, 10)) {
    priorities.push({
      kind: "followup",
      title: `Sans réponse : ${a.company}`,
      detail: `${a.title}, envoyée il y a plus de ${followupAfterDays} jours : relance à envisager`,
      due: null,
      applicationId: a.id,
      offerId: null,
    });
  }
  const unanalyzed = db.all<{ id: string; company: string; title: string }>("SELECT id, company, title FROM offers WHERE status = 'new' AND analysis IS NULL ORDER BY discovered_at DESC LIMIT 5");
  for (const o of unanalyzed) priorities.push({ kind: "analyze", title: `Nouvelle offre à analyser : ${o.company}`, detail: o.title, due: null, applicationId: null, offerId: o.id });

  return {
    // Each number is the length of the list its detail window shows.
    counts: {
      newOffers: rows.newOffers().length,
      active: rows.active().length,
      waiting: rows.waiting().length,
      tests: rows.tests().length,
      interviews: rows.interviews().length,
      noAnswer: noAnswer.length,
    },
    priorities,
    upcoming,
    confirmations,
    pendingActions,
  };
}
