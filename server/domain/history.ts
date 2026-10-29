// What happened to each offer and application, and who did it: the user, the
// agent, Gmail, an import or the system. Prepared, local and external actions
// are recorded as different kinds so they are never confused.

import type { HistoryEvent } from "../../shared/types";
import type { Database } from "../db/database";
import { newId } from "../errors";

export type EventKind =
  | "import"
  | "offer"
  | "analysis"
  | "status"
  | "validation"
  | "evidence"
  | "note"
  | "mode"
  | "next_action"
  | "deadline"
  | "folder"
  | "documents"
  | "prepared"
  | "local"
  | "external"
  | "mail";

export function addEvent(
  db: Database,
  e: { applicationId?: string | null; offerId?: string | null; actor: HistoryEvent["actor"]; kind: EventKind; summary: string; details?: Record<string, unknown> | null },
  at: Date = new Date(),
): string {
  const id = newId("ev");
  db.run(
    "INSERT INTO events (id, application_id, offer_id, at, actor, kind, summary, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    e.applicationId ?? null,
    e.offerId ?? null,
    at.toISOString(),
    e.actor,
    e.kind,
    e.summary.slice(0, 500),
    e.details ? JSON.stringify(e.details) : null,
  );
  return id;
}

const toEvent = (r: Record<string, unknown>): HistoryEvent => ({
  id: String(r.id),
  applicationId: r.application_id ? String(r.application_id) : null,
  offerId: r.offer_id ? String(r.offer_id) : null,
  at: String(r.at),
  actor: r.actor as HistoryEvent["actor"],
  kind: String(r.kind),
  summary: String(r.summary),
  details: r.details ? (JSON.parse(String(r.details)) as Record<string, unknown>) : null,
});

export function listEvents(db: Database, filter: { applicationId?: string; offerId?: string; limit?: number } = {}): HistoryEvent[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.applicationId) {
    where.push("application_id = ?");
    params.push(filter.applicationId);
  }
  if (filter.offerId) {
    where.push("(offer_id = ? OR application_id IN (SELECT id FROM applications WHERE offer_id = ?))");
    params.push(filter.offerId, filter.offerId);
  }
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ${Math.min(filter.limit ?? 200, 1000)}`;
  return db.all(sql, ...params).map(toEvent);
}
