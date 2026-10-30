// What the assistant read in the recruiting emails, waiting for the user.
//
// For each email the assistant says which application it belongs to (or which
// new offer it is about) and the status it suggests. Nothing changes until the
// user accepts a review, as it is or after editing it, or accepts them all.
// Accepting is the user's confirmation: the email becomes the proof of the status.

import { z } from "zod";
import type { MailReview, Status } from "../../shared/types";
import { STATUS_LABELS } from "../../shared/types";
import type { Database } from "../db/database";
import { AppError, newId } from "../errors";
import { confirmEvidence, createApplication, getApplication, proposeStatus, rowToMail, zStatus } from "./applications";
import { addEvent } from "./history";
import { createOffer } from "./offers";

/** Where a status sits on the way from sending to an offer. waiting and followup sit anywhere. */
const RANK: Partial<Record<Status, number>> = {
  prepared: 0,
  validated: 0,
  sent: 1,
  received: 2,
  test_todo: 3,
  test_done: 4,
  interview_proposed: 5,
  interview_confirmed: 6,
  offer: 8,
  refused: 9,
  closed: 9,
};

/** True when moving from one status to the other would undo progress (an old email read late). */
export function goesBack(from: Status, to: Status): boolean {
  const a = RANK[from];
  const b = RANK[to];
  return a !== undefined && b !== undefined && b < a;
}

/** The statuses an email can suggest: preparing and validating are the user's own steps. */
export const REVIEW_STATUSES = ["sent", "received", "interview_proposed", "interview_confirmed", "test_todo", "test_done", "waiting", "followup", "refused", "offer", "closed"] as const;

export const zReviewInput = z.object({
  mailId: z.string().min(1).max(200),
  action: z.enum(["attach", "new_offer", "nothing"]),
  applicationId: z.string().min(1).max(80).optional(),
  company: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  location: z.string().trim().max(200).optional(),
  url: z.string().trim().max(2000).optional(),
  status: z.enum(REVIEW_STATUSES).optional(),
  dueAt: z.string().max(40).optional(),
  note: z.string().trim().min(3).max(400),
});

export const zReviewPatch = z.object({
  applicationId: z.string().min(1).max(80).nullable().optional(),
  company: z.string().trim().max(200).nullable().optional(),
  title: z.string().trim().max(300).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  url: z.string().trim().max(2000).nullable().optional(),
  status: zStatus.nullable().optional(),
  dueAt: z.string().max(40).nullable().optional(),
});

function rowToReview(db: Database, r: Record<string, unknown>): MailReview {
  const mail = db.get<Record<string, unknown>>("SELECT * FROM mails WHERE id = ?", String(r.mail_id))!;
  const appId = (r.application_id as string | null) ?? null;
  const a = appId ? getApplication(db, appId) : null;
  const s = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  return {
    id: String(r.id),
    mail: rowToMail(mail),
    applicationId: appId,
    application: a ? { id: a.id, status: a.status, company: a.offer.company, title: a.offer.title } : null,
    company: s("company"),
    title: s("title"),
    location: s("location"),
    url: s("url"),
    status: (s("status") as Status | null) ?? null,
    back: Boolean(a && r.status && goesBack(a.status, r.status as Status)),
    dueAt: s("due_at"),
    note: String(r.note ?? ""),
    createdAt: String(r.created_at),
  };
}

/**
 * The emails the assistant has not looked at yet: those ORBIT could not place,
 * and those it placed without knowing what they say. Job alerts are read
 * elsewhere, and an email already behind a status proposal is not read twice.
 */
export function mailsToReview(db: Database, opts: { limit: number; offset: number }) {
  const where = `NOT EXISTS (SELECT 1 FROM mail_reviews r WHERE r.mail_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.message_id = m.id)
    AND m.category != 'alert'
    AND (m.application_id IS NULL OR m.category = 'other')`;
  const total = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM mails m WHERE ${where}`)?.n ?? 0);
  const mails = db
    .all<Record<string, unknown>>(
      `SELECT m.*, o.company AS app_company FROM mails m LEFT JOIN applications a ON a.id = m.application_id LEFT JOIN offers o ON o.id = a.offer_id
       WHERE ${where} ORDER BY m.date DESC LIMIT ? OFFSET ?`,
      opts.limit,
      opts.offset,
    )
    .map((r) => ({ ...rowToMail(r), placedWith: (r.app_company as string | null) ?? null, snippet: String(r.snippet ?? "").slice(0, 300) }));
  return { total, mails };
}

/** Record the assistant's reading of some emails. A review not yet decided is replaced, a decided one is kept. */
export function saveReviews(db: Database, items: z.input<typeof zReviewInput>[]) {
  const results: { mailId: string; ok: boolean; reviewId?: string; note?: string; error?: string }[] = [];
  for (const raw of items) {
    const parsed = zReviewInput.safeParse(raw);
    const mailId = String((raw as { mailId?: unknown }).mailId ?? "");
    if (!parsed.success) {
      results.push({ mailId, ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      continue;
    }
    const i = parsed.data;
    try {
      results.push({ mailId: i.mailId, ok: true, ...saveReview(db, i) });
    } catch (err) {
      results.push({ mailId: i.mailId, ok: false, error: err instanceof AppError ? err.message : "Erreur interne." });
    }
  }
  return results;
}

function saveReview(db: Database, i: z.infer<typeof zReviewInput>): { reviewId: string; note?: string } {
  if (!db.get("SELECT 1 AS x FROM mails WHERE id = ?", i.mailId)) throw new AppError("not_found", "E-mail inconnu : prends l'id donné par list_mails_to_review.");
  const known = db.get<{ id: string; state: string }>("SELECT id, state FROM mail_reviews WHERE mail_id = ?", i.mailId);
  if (known && known.state !== "pending") throw new AppError("conflict", "Cet e-mail a déjà été traité.");
  let note: string | undefined;
  if (i.action === "attach") {
    if (!i.applicationId) throw new AppError("validation", "attach demande applicationId.");
    const app = getApplication(db, i.applicationId);
    if (i.status && goesBack(app.status, i.status))
      note = `« ${STATUS_LABELS[i.status]} » ferait reculer la candidature (${STATUS_LABELS[app.status]}) : l'utilisateur décidera, Tout accepter ne l'appliquera pas.`;
  }
  if (i.action === "new_offer" && (!i.company || !i.title)) throw new AppError("validation", "new_offer demande company et title.");
  const nothing = i.action === "nothing";
  const values = [
    nothing ? "skipped" : "pending",
    i.action === "attach" ? i.applicationId! : null,
    i.action === "new_offer" ? i.company! : null,
    i.action === "new_offer" ? i.title! : null,
    i.action === "new_offer" ? (i.location ?? null) : null,
    i.action === "new_offer" ? (i.url ?? null) : null,
    nothing ? null : (i.status ?? null),
    nothing ? null : (i.dueAt ?? null),
    i.note,
  ];
  const at = new Date().toISOString();
  if (known) {
    db.run(
      "UPDATE mail_reviews SET state = ?, application_id = ?, company = ?, title = ?, location = ?, url = ?, status = ?, due_at = ?, note = ?, created_at = ?, resolved_at = ? WHERE id = ?",
      ...values,
      at,
      nothing ? at : null,
      known.id,
    );
    return { reviewId: known.id, ...(note ? { note } : {}) };
  }
  const id = newId("mr");
  db.run(
    "INSERT INTO mail_reviews (state, application_id, company, title, location, url, status, due_at, note, id, mail_id, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ...values,
    id,
    i.mailId,
    at,
    nothing ? at : null,
  );
  return { reviewId: id, ...(note ? { note } : {}) };
}

export function listReviews(db: Database): MailReview[] {
  return db.all<Record<string, unknown>>("SELECT r.* FROM mail_reviews r JOIN mails m ON m.id = r.mail_id WHERE r.state = 'pending' ORDER BY m.date DESC").map((r) => rowToReview(db, r));
}

function pending(db: Database, id: string): Record<string, unknown> {
  const r = db.get<Record<string, unknown>>("SELECT * FROM mail_reviews WHERE id = ?", id);
  if (!r) throw new AppError("not_found", "Cette proposition n'existe plus.");
  if (r.state !== "pending") throw new AppError("conflict", "Cette proposition a déjà été traitée.");
  return r;
}

/** The user edits a review before accepting it: another application, a new offer, another status or date. */
export function updateReview(db: Database, id: string, raw: unknown): MailReview {
  const r = pending(db, id);
  const p = zReviewPatch.parse(raw);
  const next = {
    application_id: p.applicationId !== undefined ? p.applicationId : (r.application_id as string | null),
    company: p.company !== undefined ? p.company || null : (r.company as string | null),
    title: p.title !== undefined ? p.title || null : (r.title as string | null),
    location: p.location !== undefined ? p.location || null : (r.location as string | null),
    url: p.url !== undefined ? p.url || null : (r.url as string | null),
    status: p.status !== undefined ? p.status : (r.status as Status | null),
    due_at: p.dueAt !== undefined ? p.dueAt || null : (r.due_at as string | null),
  };
  if (next.application_id) getApplication(db, next.application_id);
  db.run(
    "UPDATE mail_reviews SET application_id = ?, company = ?, title = ?, location = ?, url = ?, status = ?, due_at = ? WHERE id = ?",
    next.application_id,
    next.company,
    next.title,
    next.location,
    next.url,
    next.status,
    next.due_at,
    id,
  );
  return rowToReview(db, db.get("SELECT * FROM mail_reviews WHERE id = ?", id)!);
}

/**
 * Apply a review: create the offer (and its application when there is a status),
 * attach the email, and set the status with the email as proof.
 */
export function acceptReview(db: Database, id: string): { applicationId: string | null; offerId: string | null } {
  return db.tx(() => {
    const r = pending(db, id);
    const mail = rowToMail(db.get<Record<string, unknown>>("SELECT * FROM mails WHERE id = ?", String(r.mail_id))!);
    const status = (r.status as Status | null) ?? null;
    let appId = (r.application_id as string | null) ?? null;
    let offerId: string | null = null;
    if (appId) {
      offerId = getApplication(db, appId).offerId;
    } else {
      if (!r.company || !r.title) throw new AppError("validation", "Choisissez une candidature, ou donnez l'entreprise et le poste de la nouvelle offre.");
      const { offer } = createOffer(
        db,
        {
          company: String(r.company),
          title: String(r.title),
          location: (r.location as string | null) ?? null,
          url: (r.url as string | null) ?? null,
          source: "gmail",
          description: `Repérée dans un e-mail du ${mail.date.slice(0, 10)} (${mail.from}) : ${mail.subject}\n\n${mail.snippet}`,
        },
        "user",
      );
      offerId = offer.id;
      if (status) appId = offer.applicationId ?? createApplication(db, offer.id, { actor: "user" }).id;
    }
    if (appId) {
      db.run("UPDATE mails SET application_id = ? WHERE id = ?", appId, mail.id);
      // The email belongs here now: what it suggested elsewhere no longer stands.
      db.run("UPDATE evidence SET dismissed = 1 WHERE message_id = ? AND application_id != ? AND confirmed = 0", mail.id, appId);
    }
    addEvent(db, {
      applicationId: appId,
      offerId,
      actor: "user",
      kind: "mail",
      summary: `Proposition de l'assistant acceptée : ${mail.subject || "(sans objet)"}${r.note ? ` (${String(r.note)})` : ""}`,
    });
    if (appId && status) {
      const ev = proposeStatus(
        db,
        appId,
        {
          kind: "email",
          messageId: mail.id,
          mailDate: mail.date,
          mailFrom: mail.from,
          mailSubject: mail.subject,
          excerpt: mail.snippet.slice(0, 2000),
          suggests: status,
          dueAt: (r.due_at as string | null) ?? null,
        },
        "agent",
      );
      db.run("UPDATE evidence SET suggests = ?, due_at = COALESCE(?, due_at), dismissed = 0 WHERE id = ?", status, (r.due_at as string | null) ?? null, ev.id);
      confirmEvidence(db, ev.id, { status });
    }
    db.run("UPDATE mail_reviews SET state = 'accepted', resolved_at = ?, application_id = COALESCE(application_id, ?) WHERE id = ?", new Date().toISOString(), appId, id);
    return { applicationId: appId, offerId: offerId ?? (appId ? getApplication(db, appId).offerId : null) };
  });
}

export function dismissReview(db: Database, id: string) {
  pending(db, id);
  db.run("UPDATE mail_reviews SET state = 'dismissed', resolved_at = ? WHERE id = ?", new Date().toISOString(), id);
}

/**
 * Accept everything waiting from the emails: the assistant's reviews and the
 * statuses ORBIT's rules found, oldest email first so the latest one wins.
 * A status that would undo progress is left for the user to decide.
 */
export function acceptAll(db: Database) {
  const out = { accepted: 0, confirmed: 0, left: 0, errors: [] as string[] };
  const reviews = db.all<Record<string, unknown>>(
    "SELECT r.id, r.status, r.application_id, m.subject FROM mail_reviews r JOIN mails m ON m.id = r.mail_id WHERE r.state = 'pending' ORDER BY m.date ASC",
  );
  for (const r of reviews) {
    const appId = (r.application_id as string | null) ?? null;
    if (appId && r.status && goesBack(getApplication(db, appId).status, r.status as Status)) {
      out.left++;
      continue;
    }
    try {
      acceptReview(db, String(r.id));
      out.accepted++;
    } catch (err) {
      out.errors.push(`${String(r.subject ?? "(sans objet)")} : ${err instanceof AppError ? err.message : "erreur interne"}`);
    }
  }
  const evidence = db.all<{ id: string; application_id: string; suggests: Status }>(
    "SELECT id, application_id, suggests FROM evidence WHERE kind = 'email' AND confirmed = 0 AND dismissed = 0 AND suggests IS NOT NULL ORDER BY COALESCE(mail_date, created_at) ASC",
  );
  for (const e of evidence) {
    // Confirming one email also confirms the others that suggest the same status.
    if (Number(db.get<{ c: number }>("SELECT confirmed AS c FROM evidence WHERE id = ?", e.id)?.c) === 1) continue;
    const current = getApplication(db, e.application_id).status;
    if (e.suggests === current) continue;
    if (goesBack(current, e.suggests)) {
      out.left++;
      continue;
    }
    confirmEvidence(db, e.id, { status: e.suggests });
    out.confirmed++;
  }
  return out;
}
