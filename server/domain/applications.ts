// Applications, their status, evidence, dates and external actions.
//
// A status that says something happened outside (sent, received, test done,
// interview, refusal, offer) is only set by the user, or by confirming a piece
// of evidence (an email, a statement). The agent and Gmail can only propose it.
// An external action (submitting, sending) waits for the user's validation of
// that one action.

import { z } from "zod";
import type { Application, ApplicationDetail, Deadline, Evidence, MailItem, Mode, PendingAction, Status } from "../../shared/types";
import { PROOF_STATUSES, STATUS_LABELS, STATUSES } from "../../shared/types";
import type { Database } from "../db/database";
import { AppError, newId } from "../errors";
import { addEvent, listEvents } from "./history";
import { getOffer } from "./offers";

export const zStatus = z.enum(STATUSES);
export const zMode = z.enum(["A", "B", "C"]);

type Actor = "user" | "agent" | "system" | "gmail" | "import";

function rowToApplication(db: Database, r: Record<string, unknown>): Application {
  const o = db.get<Record<string, unknown>>("SELECT company, title, location, contract, url, score, reference FROM offers WHERE id = ?", String(r.offer_id));
  const s = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  return {
    id: String(r.id),
    offerId: String(r.offer_id),
    offer: {
      company: String(o?.company ?? ""),
      title: String(o?.title ?? ""),
      location: (o?.location as string | null) ?? null,
      contract: (o?.contract as string | null) ?? null,
      url: (o?.url as string | null) ?? null,
      score: o?.score === null || o?.score === undefined ? null : Number(o.score),
      reference: (o?.reference as string | null) ?? null,
    },
    status: r.status as Status,
    mode: r.mode as Mode,
    folder: s("folder"),
    sourceFolder: s("source_folder"),
    cvPath: s("cv_path"),
    letterPath: s("letter_path"),
    sentAt: s("sent_at"),
    nextAction: s("next_action"),
    nextActionDue: s("next_action_due"),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function getApplication(db: Database, id: string): Application {
  const r = db.get("SELECT * FROM applications WHERE id = ?", id);
  if (!r) throw new AppError("not_found", "Cette candidature n'existe plus.");
  return rowToApplication(db, r);
}

export function listApplications(db: Database, filter: { status?: Status; q?: string } = {}): Application[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.status) {
    where.push("a.status = ?");
    params.push(filter.status);
  }
  if (filter.q?.trim()) {
    where.push("(o.company LIKE ? OR o.title LIKE ? OR a.next_action LIKE ?)");
    const like = `%${filter.q.trim()}%`;
    params.push(like, like, like);
  }
  return db
    .all(`SELECT a.* FROM applications a JOIN offers o ON o.id = a.offer_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.updated_at DESC`, ...params)
    .map((r) => rowToApplication(db, r));
}

export const rowToEvidence = (r: Record<string, unknown>): Evidence => ({
  id: String(r.id),
  applicationId: String(r.application_id),
  kind: r.kind as Evidence["kind"],
  messageId: (r.message_id as string | null) ?? null,
  mailDate: (r.mail_date as string | null) ?? null,
  mailFrom: (r.mail_from as string | null) ?? null,
  mailSubject: (r.mail_subject as string | null) ?? null,
  excerpt: (r.excerpt as string | null) ?? null,
  suggests: (r.suggests as Status | null) ?? null,
  dueAt: (r.due_at as string | null) ?? null,
  confirmed: Number(r.confirmed) === 1,
  createdAt: String(r.created_at),
});

const rowToDeadline = (r: Record<string, unknown>): Deadline => ({
  id: String(r.id),
  applicationId: String(r.application_id),
  kind: r.kind as Deadline["kind"],
  title: String(r.title),
  dueAt: (r.due_at as string | null) ?? null,
  status: r.status as Deadline["status"],
  evidenceId: (r.evidence_id as string | null) ?? null,
  createdAt: String(r.created_at),
});

export const rowToPending = (r: Record<string, unknown>): PendingAction => ({
  id: String(r.id),
  applicationId: (r.application_id as string | null) ?? null,
  kind: String(r.kind),
  description: String(r.description),
  details: r.details ? (JSON.parse(String(r.details)) as Record<string, unknown>) : null,
  status: r.status as PendingAction["status"],
  createdAt: String(r.created_at),
  decidedAt: (r.decided_at as string | null) ?? null,
});

export const rowToMail = (r: Record<string, unknown>): MailItem => ({
  id: String(r.id),
  date: String(r.date),
  from: [r.from_name, r.from_address ? `<${String(r.from_address)}>` : null].filter(Boolean).join(" "),
  subject: String(r.subject ?? ""),
  snippet: String(r.snippet ?? ""),
  category: r.category as MailItem["category"],
  applicationId: (r.application_id as string | null) ?? null,
  link: (r.link as string | null) ?? null,
});

export function getApplicationDetail(db: Database, id: string): ApplicationDetail {
  const app = getApplication(db, id);
  return {
    ...app,
    offerFull: getOffer(db, app.offerId),
    evidence: db.all("SELECT * FROM evidence WHERE application_id = ? AND dismissed = 0 ORDER BY created_at DESC", id).map(rowToEvidence),
    deadlines: db.all("SELECT * FROM deadlines WHERE application_id = ? ORDER BY COALESCE(due_at, '9999'), created_at", id).map(rowToDeadline),
    history: listEvents(db, { applicationId: id }),
    mails: db.all("SELECT * FROM mails WHERE application_id = ? ORDER BY date DESC", id).map(rowToMail),
    pendingActions: db.all("SELECT * FROM pending_actions WHERE application_id = ? ORDER BY created_at DESC", id).map(rowToPending),
  };
}

export function createApplication(
  db: Database,
  offerId: string,
  opts: {
    actor: Actor;
    mode?: Mode;
    status?: Status;
    sourceFolder?: string | null;
    cvPath?: string | null;
    letterPath?: string | null;
    sentAt?: string | null;
    nextAction?: string | null;
    createdAt?: string;
  },
): Application {
  const offer = getOffer(db, offerId);
  if (offer.applicationId) throw new AppError("conflict", "Cette offre a déjà une candidature.", { applicationId: offer.applicationId });
  const status = opts.status ?? "prepared";
  if (PROOF_STATUSES.includes(status) && opts.actor !== "user" && opts.actor !== "import")
    throw new AppError("forbidden", `Le statut « ${STATUS_LABELS[status]} » demande une preuve ou votre confirmation.`);
  const at = opts.createdAt ?? new Date().toISOString();
  const id = newId("ap");
  db.tx(() => {
    db.run(
      `INSERT INTO applications (id, offer_id, status, mode, source_folder, cv_path, letter_path, sent_at, next_action, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      offerId,
      status,
      opts.mode ?? "B",
      opts.sourceFolder ?? null,
      opts.cvPath ?? null,
      opts.letterPath ?? null,
      opts.sentAt ?? null,
      opts.nextAction ?? null,
      at,
      at,
    );
    db.run("UPDATE offers SET status = 'kept' WHERE id = ? AND status = 'new'", offerId);
    addEvent(db, { applicationId: id, offerId, actor: opts.actor, kind: "status", summary: `Candidature créée (${STATUS_LABELS[status]})` });
  });
  return getApplication(db, id);
}

/**
 * Change the status. A status that needs proof is only accepted from the user
 * (their statement is the confirmation) or with a confirmed piece of evidence.
 */
export function setStatus(db: Database, id: string, status: Status, opts: { actor: Actor; evidenceId?: string; note?: string }): Application {
  const app = getApplication(db, id);
  const needsProof = PROOF_STATUSES.includes(status) || status === "validated";
  if (needsProof && opts.actor !== "user") {
    const ev = opts.evidenceId ? db.get<{ confirmed: number }>("SELECT confirmed FROM evidence WHERE id = ? AND application_id = ?", opts.evidenceId, id) : undefined;
    if (!ev || Number(ev.confirmed) !== 1 || status === "validated") {
      throw new AppError("forbidden", `Le statut « ${STATUS_LABELS[status]} » demande une preuve confirmée ou votre décision : proposez-le plutôt.`);
    }
  }
  const at = new Date().toISOString();
  db.tx(() => {
    db.run("UPDATE applications SET status = ?, updated_at = ? WHERE id = ?", status, at, id);
    if (status === "sent" && !app.sentAt) db.run("UPDATE applications SET sent_at = ? WHERE id = ?", at, id);
    addEvent(db, {
      applicationId: id,
      offerId: app.offerId,
      actor: opts.actor,
      kind: status === "validated" ? "validation" : "status",
      summary: `${STATUS_LABELS[app.status]} → ${STATUS_LABELS[status]}${opts.actor === "user" ? " (déclaré par vous)" : ""}${opts.note ? ` : ${opts.note}` : ""}`,
      details: { from: app.status, to: status, evidenceId: opts.evidenceId ?? null },
    });
  });
  return getApplication(db, id);
}

export const zEvidenceInput = z.object({
  kind: z.enum(["email", "user", "import", "file", "agent"]),
  messageId: z.string().max(200).nullish(),
  mailDate: z.string().max(60).nullish(),
  mailFrom: z.string().max(300).nullish(),
  mailSubject: z.string().max(500).nullish(),
  excerpt: z.string().max(2000).nullish(),
  suggests: zStatus.nullish(),
  dueAt: z.string().max(40).nullish(),
});

/** Record a piece of evidence that suggests a status. It waits for the user's confirmation. */
export function proposeStatus(db: Database, applicationId: string, input: z.infer<typeof zEvidenceInput>, actor: Actor): Evidence {
  const app = getApplication(db, applicationId);
  const e = zEvidenceInput.parse(input);
  if (e.messageId) {
    const known = db.get<Record<string, unknown>>("SELECT * FROM evidence WHERE application_id = ? AND message_id = ?", applicationId, e.messageId);
    if (known) return rowToEvidence(known);
  }
  const id = newId("pv");
  db.run(
    "INSERT INTO evidence (id, application_id, kind, message_id, mail_date, mail_from, mail_subject, excerpt, suggests, due_at, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
    id,
    applicationId,
    e.kind,
    e.messageId ?? null,
    e.mailDate ?? null,
    e.mailFrom ?? null,
    e.mailSubject ?? null,
    e.excerpt ?? null,
    e.suggests ?? null,
    e.dueAt ?? null,
    new Date().toISOString(),
  );
  addEvent(db, {
    applicationId,
    offerId: app.offerId,
    actor,
    kind: "evidence",
    summary: `Preuve à confirmer${e.suggests ? ` (suggère « ${STATUS_LABELS[e.suggests]} »)` : ""}${e.mailSubject ? ` : ${e.mailSubject}` : ""}`,
  });
  return rowToEvidence(db.get("SELECT * FROM evidence WHERE id = ?", id)!);
}

/** The user confirms what the evidence says: it becomes proof and the status follows. */
export function confirmEvidence(db: Database, evidenceId: string, opts: { status?: Status; actor?: "user" | "import" } = {}): Application {
  const actor = opts.actor ?? "user";
  const r = db.get<Record<string, unknown>>("SELECT * FROM evidence WHERE id = ?", evidenceId);
  if (!r) throw new AppError("not_found", "Cette preuve n'existe plus.");
  const ev = rowToEvidence(r);
  const status = opts.status ?? ev.suggests;
  return db.tx(() => {
    db.run("UPDATE evidence SET confirmed = 1 WHERE id = ?", evidenceId);
    if (status) db.run("UPDATE evidence SET confirmed = 1 WHERE application_id = ? AND suggests = ? AND confirmed = 0 AND dismissed = 0", ev.applicationId, status);
    addEvent(db, {
      applicationId: ev.applicationId,
      actor,
      kind: "validation",
      summary: `${actor === "import" ? "Statut repris de votre fichier de suivi" : "Preuve confirmée"}${ev.mailSubject ? ` : ${ev.mailSubject}` : ""}`,
      details: { evidenceId },
    });
    // A confirmed acknowledgment proves the application was sent, on the day of the email.
    if ((status === "sent" || status === "received") && !getApplication(db, ev.applicationId).sentAt) {
      db.run("UPDATE applications SET sent_at = ? WHERE id = ?", ev.mailDate ?? new Date().toISOString(), ev.applicationId);
    }
    // A test or an interview found in an email becomes a dated item to follow.
    if ((status === "test_todo" || status === "interview_proposed") && ev.kind === "email") {
      addDeadline(
        db,
        ev.applicationId,
        { kind: status === "test_todo" ? "test" : "interview", title: ev.mailSubject ?? (status === "test_todo" ? "Test à passer" : "Entretien"), dueAt: ev.dueAt, evidenceId },
        actor,
      );
    }
    // The test is done: its open dates are too.
    if (status === "test_done") {
      const open = db.run("UPDATE deadlines SET status = 'done', updated_at = ? WHERE application_id = ? AND kind = 'test' AND status = 'todo'", new Date().toISOString(), ev.applicationId);
      if (Number(open.changes) > 0) addEvent(db, { applicationId: ev.applicationId, actor, kind: "deadline", summary: "Test marqué comme fait dans les échéances" });
    }
    if (status && status !== getApplication(db, ev.applicationId).status) return setStatus(db, ev.applicationId, status, { actor, evidenceId });
    return getApplication(db, ev.applicationId);
  });
}

export function dismissEvidence(db: Database, evidenceId: string) {
  const r = db.get<{ application_id: string; mail_subject: string | null }>("SELECT application_id, mail_subject FROM evidence WHERE id = ?", evidenceId);
  if (!r) throw new AppError("not_found", "Cette preuve n'existe plus.");
  db.run("UPDATE evidence SET dismissed = 1 WHERE id = ?", evidenceId);
  addEvent(db, { applicationId: r.application_id, actor: "user", kind: "validation", summary: `Preuve écartée${r.mail_subject ? ` : ${r.mail_subject}` : ""}` });
}

export function setMode(db: Database, id: string, mode: Mode, actor: Actor): Application {
  const app = getApplication(db, id);
  db.run("UPDATE applications SET mode = ?, updated_at = ? WHERE id = ?", mode, new Date().toISOString(), id);
  addEvent(db, { applicationId: id, offerId: app.offerId, actor, kind: "mode", summary: `Mode ${app.mode} → ${mode}` });
  return getApplication(db, id);
}

export const zAppPatch = z.object({
  nextAction: z.string().max(500).nullish(),
  nextActionDue: z.string().max(40).nullish(),
  cvPath: z.string().max(1000).nullish(),
  letterPath: z.string().max(1000).nullish(),
});

export function updateApplication(db: Database, id: string, patch: z.infer<typeof zAppPatch>, actor: Actor): Application {
  const p = zAppPatch.parse(patch);
  const app = getApplication(db, id);
  const cols: Record<string, string> = { nextAction: "next_action", nextActionDue: "next_action_due", cvPath: "cv_path", letterPath: "letter_path" };
  db.tx(() => {
    for (const [k, col] of Object.entries(cols)) {
      const v = (p as Record<string, unknown>)[k];
      if (v !== undefined) db.run(`UPDATE applications SET ${col} = ? WHERE id = ?`, (v as string | null) ?? null, id);
    }
    db.run("UPDATE applications SET updated_at = ? WHERE id = ?", new Date().toISOString(), id);
    if (p.cvPath !== undefined || p.letterPath !== undefined) {
      addEvent(db, {
        applicationId: id,
        offerId: app.offerId,
        actor,
        kind: "documents",
        summary: `Documents liés : ${[p.cvPath && `CV ${p.cvPath}`, p.letterPath && `lettre ${p.letterPath}`].filter(Boolean).join(", ") || "retirés"}`,
      });
    }
    if (p.nextAction !== undefined)
      addEvent(db, {
        applicationId: id,
        offerId: app.offerId,
        actor,
        kind: "next_action",
        summary: `Prochaine action : ${p.nextAction ?? "aucune"}${p.nextActionDue ? ` (avant le ${p.nextActionDue})` : ""}`,
      });
  });
  return getApplication(db, id);
}

export function addNote(db: Database, id: string, text: string, actor: Actor) {
  const app = getApplication(db, id);
  addEvent(db, { applicationId: id, offerId: app.offerId, actor, kind: "note", summary: text.slice(0, 500) });
}

export const zDeadlineInput = z.object({
  kind: z.enum(["test", "interview", "followup", "deadline"]),
  title: z.string().trim().min(1).max(300),
  dueAt: z.string().max(40).nullish(),
  evidenceId: z.string().max(60).nullish(),
});

export function addDeadline(db: Database, applicationId: string, input: z.infer<typeof zDeadlineInput>, actor: Actor): Deadline {
  const app = getApplication(db, applicationId);
  const d = zDeadlineInput.parse(input);
  const id = newId("dl");
  const at = new Date().toISOString();
  db.run(
    "INSERT INTO deadlines (id, application_id, kind, title, due_at, status, evidence_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?)",
    id,
    applicationId,
    d.kind,
    d.title,
    d.dueAt ?? null,
    d.evidenceId ?? null,
    at,
    at,
  );
  addEvent(db, { applicationId, offerId: app.offerId, actor, kind: "deadline", summary: `${d.title}${d.dueAt ? ` (échéance ${d.dueAt})` : ""}` });
  return rowToDeadline(db.get("SELECT * FROM deadlines WHERE id = ?", id)!);
}

/** Only the user says a test or an interview is done. */
export function setDeadlineStatus(db: Database, id: string, status: Deadline["status"], actor: Actor): Deadline {
  const r = db.get<Record<string, unknown>>("SELECT * FROM deadlines WHERE id = ?", id);
  if (!r) throw new AppError("not_found", "Cette échéance n'existe plus.");
  if (status === "done" && actor !== "user") throw new AppError("forbidden", "Seul vous pouvez confirmer qu'un test ou un entretien est fait.");
  db.run("UPDATE deadlines SET status = ?, updated_at = ? WHERE id = ?", status, new Date().toISOString(), id);
  addEvent(db, {
    applicationId: String(r.application_id),
    actor,
    kind: "validation",
    summary: `${String(r.title)} : ${status === "done" ? "fait (confirmé par vous)" : status === "cancelled" ? "annulé" : "à faire"}`,
  });
  return rowToDeadline(db.get("SELECT * FROM deadlines WHERE id = ?", id)!);
}

export const zPendingInput = z.object({
  kind: z.string().trim().min(1).max(60),
  /** Exactly what would be done, where, with which documents and data. */
  description: z.string().trim().min(10).max(4000),
  details: z.record(z.string(), z.unknown()).nullish(),
});

/** An external action (submitting, sending) waits here for the user's validation of this one action. */
export function requestExternalAction(db: Database, applicationId: string | null, input: z.infer<typeof zPendingInput>, actor: Actor): PendingAction {
  const p = zPendingInput.parse(input);
  if (applicationId) getApplication(db, applicationId);
  const id = newId("pa");
  db.run(
    "INSERT INTO pending_actions (id, application_id, kind, description, details, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    id,
    applicationId,
    p.kind,
    p.description,
    p.details ? JSON.stringify(p.details) : null,
    new Date().toISOString(),
  );
  addEvent(db, { applicationId, actor, kind: "prepared", summary: `Action externe en attente de votre validation : ${p.kind}` });
  return rowToPending(db.get("SELECT * FROM pending_actions WHERE id = ?", id)!);
}

/**
 * The user's decision on one external action. ORBIT does not perform
 * submissions itself yet: an approved action becomes a step for the user, who
 * then records the proof ("done" only by the user).
 */
export function decideExternalAction(db: Database, id: string, decision: "approved" | "rejected" | "done"): PendingAction {
  const r = db.get<Record<string, unknown>>("SELECT * FROM pending_actions WHERE id = ?", id);
  if (!r) throw new AppError("not_found", "Cette action n'existe plus.");
  const current = String(r.status);
  // An approval can still be withdrawn until the action is done.
  if (decision === "approved" && current !== "pending") throw new AppError("invalid_state", "Cette action a déjà été décidée.");
  if (decision === "rejected" && current !== "pending" && current !== "approved") throw new AppError("invalid_state", "Cette action a déjà été décidée.");
  if (decision === "done" && current !== "approved") throw new AppError("invalid_state", "Validez d'abord cette action.");
  db.run("UPDATE pending_actions SET status = ?, decided_at = ? WHERE id = ?", decision, new Date().toISOString(), id);
  addEvent(db, {
    applicationId: (r.application_id as string | null) ?? null,
    actor: "user",
    kind: decision === "done" ? "external" : "validation",
    summary: `${String(r.kind)} : ${decision === "approved" ? "validée par vous (pour cette action seulement)" : decision === "rejected" ? (current === "approved" ? "accord retiré par vous" : "refusée par vous") : "faite par vous"}`,
  });
  return rowToPending(db.get("SELECT * FROM pending_actions WHERE id = ?", id)!);
}
