// Offers: creation, duplicate detection, updates and analysis.
//
// The same offer can come from several places (a link, a pasted text, an
// import, a search). It is recognized by its address, or by the company and
// the title (and its reference when there is one). A new source is added to the
// existing offer instead of creating another, and changed dates or conditions
// are recorded as a new version.

import { z } from "zod";
import type { Analysis, Offer, OfferSource, OfferStatus, Status } from "../../shared/types";
import type { Database } from "../db/database";
import { AppError, newId } from "../errors";
import { addEvent } from "./history";

/** Lower case, no accents, no gender marks, words separated by single spaces. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[·•]e\b/g, "")
    .replace(/\(?\b(h|f|m)\s*\/\s*(h|f|m)\b\)?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const LEGAL = /\b(sa|sas|sasu|sarl|se|inc|ltd|llc|gmbh|plc|group|groupe)\b/g;
export const companyKey = (company: string) => normalize(company).replace(LEGAL, "").replace(/\s+/g, " ").trim();

const STOP = new Set(["stage", "stagiaire", "intern", "internship", "de", "du", "des", "la", "le", "les", "et", "en", "and", "the", "of", "pour", "un", "une", "a", "mois", "months"]);
const titleTokens = (title: string) => new Set(normalize(title).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));

export function dedupKey(company: string, title: string, reference?: string | null): string {
  const ref = reference ? normalize(reference) : "";
  return `${companyKey(company)}|${[...titleTokens(title)].sort().join(" ")}${ref ? `|${ref}` : ""}`;
}

/** Advertising and tracking parameters only: others (ref=R-9223, jobId=...) identify the offer. */
const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|trk|trkinfo|trackingid|mc_[a-z]+|_hs[a-z]+|yclid)$/i;

/** The address without protocol, "www.", tracking parameters, fragment or trailing slash. */
export function urlKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    const q = u.searchParams.toString();
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}${q ? `?${q}` : ""}`;
  } catch {
    return null;
  }
}

/** How close two titles are, from 0 to 1 (shared words over all words). */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export const zOfferInput = z.object({
  company: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  location: z.string().trim().max(200).nullish(),
  contract: z.string().trim().max(60).nullish(),
  duration: z.string().trim().max(60).nullish(),
  startDate: z.string().trim().max(60).nullish(),
  reference: z.string().trim().max(120).nullish(),
  url: z.string().trim().max(2000).nullish(),
  source: z.string().trim().min(1).max(80),
  language: z.string().trim().max(10).nullish(),
  description: z.string().max(60000).default(""),
  discoveredAt: z.string().nullish(),
});
export type OfferInput = z.infer<typeof zOfferInput>;

const MISSING_FIELDS: [keyof OfferInput, string][] = [
  ["location", "lieu"],
  ["contract", "type de contrat"],
  ["startDate", "date de début"],
  ["duration", "durée"],
  ["url", "lien de l'annonce"],
];

function missingOf(o: OfferInput): string[] {
  const out = MISSING_FIELDS.filter(([k]) => !o[k]).map(([, label]) => label);
  if ((o.description ?? "").trim().length < 200) out.push("description complète");
  return out;
}

function sourcesOf(db: Database, offerId: string): OfferSource[] {
  return db
    .all<Record<string, string | null>>("SELECT * FROM offer_sources WHERE offer_id = ? ORDER BY seen_at", offerId)
    .map((r) => ({ id: String(r.id), source: String(r.source), url: r.url ?? null, seenAt: String(r.seen_at), note: r.note ?? null }));
}

function rowToOffer(db: Database, r: Record<string, unknown>): Offer {
  const similar = r.similar_to ? db.get<{ id: string; company: string; title: string }>("SELECT id, company, title FROM offers WHERE id = ?", String(r.similar_to)) : undefined;
  const app = db.get<{ id: string; status: Status }>("SELECT id, status FROM applications WHERE offer_id = ?", String(r.id));
  const s = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  return {
    id: String(r.id),
    company: String(r.company),
    title: String(r.title),
    location: s("location"),
    contract: s("contract"),
    duration: s("duration"),
    startDate: s("start_date"),
    reference: s("reference"),
    url: s("url"),
    source: String(r.source),
    language: s("language"),
    description: String(r.description ?? ""),
    status: r.status as OfferStatus,
    score: r.score === null || r.score === undefined ? null : Number(r.score),
    analysis: r.analysis ? (JSON.parse(String(r.analysis)) as Analysis) : null,
    analysisMd: s("analysis_md"),
    missing: JSON.parse(String(r.missing ?? "[]")) as string[],
    discoveredAt: String(r.discovered_at),
    lastCheckedAt: s("last_checked_at"),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    sources: sourcesOf(db, String(r.id)),
    applicationId: app?.id ?? null,
    applicationStatus: app?.status ?? null,
    similarTo: similar ? { id: similar.id, company: similar.company, title: similar.title } : null,
  };
}

export function getOffer(db: Database, id: string): Offer {
  const r = db.get("SELECT * FROM offers WHERE id = ?", id);
  if (!r) throw new AppError("not_found", "Cette offre n'existe plus.");
  return rowToOffer(db, r);
}

export function listOffers(db: Database, filter: { status?: OfferStatus | "all"; q?: string; minScore?: number } = {}): Offer[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.status && filter.status !== "all") {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.minScore !== undefined) {
    where.push("score >= ?");
    params.push(filter.minScore);
  }
  if (filter.q?.trim()) {
    where.push("(company LIKE ? OR title LIKE ? OR location LIKE ? OR description LIKE ?)");
    const like = `%${filter.q.trim()}%`;
    params.push(like, like, like, like);
  }
  return db
    .all(`SELECT * FROM offers ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(score, -1) DESC, discovered_at DESC LIMIT 500`, ...params)
    .map((r) => rowToOffer(db, r));
}

/** Fields that changed between the known offer and a new sighting of it. */
const TRACKED: [keyof OfferInput, string, string][] = [
  ["startDate", "start_date", "date de début"],
  ["duration", "duration", "durée"],
  ["location", "location", "lieu"],
  ["contract", "contract", "type de contrat"],
];

export interface CreateResult {
  offer: Offer;
  created: boolean;
  /** Set when the offer was already known: what changed in this new version. */
  changes: string[];
}

/** Add an offer, or a new source to the offer it duplicates. */
export function createOffer(db: Database, raw: OfferInput, actor: "user" | "agent" | "import" | "system", now: Date = new Date()): CreateResult {
  const o = zOfferInput.parse(raw);
  const at = now.toISOString();
  const uKey = urlKey(o.url);
  const dKey = dedupKey(o.company, o.title, o.reference);
  return db.tx(() => {
    // The same link is the same offer only for the same company and a close title:
    // a search page or a careers home page can be shared by many offers.
    const byUrl = uKey
      ? db
          .all<Record<string, unknown>>("SELECT * FROM offers WHERE url_key = ?", uKey)
          .find((x) => companyKey(String(x.company)) === companyKey(o.company) && titleSimilarity(String(x.title), o.title) >= 0.4)
      : undefined;
    const existing = byUrl ?? db.get<Record<string, unknown>>("SELECT * FROM offers WHERE dedup_key = ?", dKey);
    if (existing) {
      const id = String(existing.id);
      const known = sourcesOf(db, id);
      if (!known.some((s) => s.source === o.source && (s.url ?? null) === (o.url ?? null))) {
        db.run("INSERT INTO offer_sources (id, offer_id, source, url, seen_at) VALUES (?, ?, ?, ?, ?)", newId("src"), id, o.source, o.url ?? null, at);
      }
      const changes: string[] = [];
      for (const [k, col, label] of TRACKED) {
        const next = o[k] as string | null | undefined;
        const prev = existing[col] as string | null;
        if (next && prev && normalize(next) !== normalize(prev)) {
          changes.push(`${label} : « ${prev} » → « ${next} »`);
          db.run(`UPDATE offers SET ${col} = ? WHERE id = ?`, next, id);
        } else if (next && !prev) db.run(`UPDATE offers SET ${col} = ? WHERE id = ?`, next, id);
      }
      // A longer description fills in a partial one.
      if ((o.description ?? "").length > String(existing.description ?? "").length + 200) {
        db.run("UPDATE offers SET description = ? WHERE id = ?", o.description, id);
        changes.push("description plus complète");
      }
      if (!existing.url && o.url) db.run("UPDATE offers SET url = ?, url_key = ? WHERE id = ?", o.url, uKey, id);
      db.run("UPDATE offers SET last_checked_at = ?, updated_at = ? WHERE id = ?", at, at, id);
      const offer = getOffer(db, id);
      db.run("UPDATE offers SET missing = ? WHERE id = ?", JSON.stringify(missingOf({ ...o, ...offerAsInput(offer) })), id);
      addEvent(
        db,
        { offerId: id, actor, kind: "offer", summary: changes.length ? `Nouvelle version de l'offre (${o.source}) : ${changes.join(", ")}` : `Offre déjà connue, vue aussi sur ${o.source}`, details: { changes } },
        now,
      );
      return { offer: getOffer(db, id), created: false, changes };
    }

    // Same company and a close title: kept as a new offer, marked for the user to decide.
    const ck = companyKey(o.company);
    const similar = db
      .all<{ id: string; company: string; title: string }>("SELECT id, company, title FROM offers")
      .find((x) => companyKey(x.company) === ck && titleSimilarity(x.title, o.title) >= 0.6);

    const id = newId("of");
    db.run(
      `INSERT INTO offers (id, company, title, location, contract, duration, start_date, reference, url, source, language, description, missing, dedup_key, url_key, similar_to, discovered_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      o.company,
      o.title,
      o.location ?? null,
      o.contract ?? null,
      o.duration ?? null,
      o.startDate ?? null,
      o.reference ?? null,
      o.url ?? null,
      o.source,
      o.language ?? null,
      o.description ?? "",
      JSON.stringify(missingOf(o)),
      dKey,
      uKey,
      similar?.id ?? null,
      o.discoveredAt ?? at,
      at,
      at,
    );
    db.run("INSERT INTO offer_sources (id, offer_id, source, url, seen_at) VALUES (?, ?, ?, ?, ?)", newId("src"), id, o.source, o.url ?? null, o.discoveredAt ?? at);
    addEvent(db, { offerId: id, actor, kind: "offer", summary: `Offre ajoutée : ${o.company}, ${o.title} (${o.source})${similar ? `, proche de « ${similar.title} »` : ""}` }, now);
    return { offer: getOffer(db, id), created: true, changes: [] };
  });
}

function offerAsInput(o: Offer): Partial<OfferInput> {
  return { location: o.location, contract: o.contract, duration: o.duration, startDate: o.startDate, url: o.url, description: o.description };
}

export const zOfferPatch = zOfferInput.omit({ source: true, discoveredAt: true }).partial();

export function updateOffer(db: Database, id: string, patch: z.infer<typeof zOfferPatch>, actor: "user" | "agent"): Offer {
  const p = zOfferPatch.parse(patch);
  const cols: Record<string, string> = { company: "company", title: "title", location: "location", contract: "contract", duration: "duration", startDate: "start_date", reference: "reference", url: "url", language: "language", description: "description" };
  return db.tx(() => {
    const before = getOffer(db, id);
    const changed: string[] = [];
    for (const [k, col] of Object.entries(cols)) {
      const v = (p as Record<string, unknown>)[k];
      if (v === undefined) continue;
      db.run(`UPDATE offers SET ${col} = ? WHERE id = ?`, (v as string | null) ?? null, id);
      changed.push(k);
    }
    const after = getOffer(db, id);
    db.run(
      "UPDATE offers SET dedup_key = ?, url_key = ?, missing = ?, updated_at = ? WHERE id = ?",
      dedupKey(after.company, after.title, after.reference),
      urlKey(after.url),
      JSON.stringify(missingOf({ ...offerAsInput(after), company: after.company, title: after.title, source: after.source } as OfferInput)),
      new Date().toISOString(),
      id,
    );
    if (changed.length) addEvent(db, { offerId: id, actor, kind: "offer", summary: `Fiche modifiée (${changed.join(", ")})`, details: { before: Object.fromEntries(changed.map((k) => [k, (before as unknown as Record<string, unknown>)[k]])) } });
    return getOffer(db, id);
  });
}

export function setOfferStatus(db: Database, id: string, status: OfferStatus, actor: "user" | "agent"): Offer {
  getOffer(db, id);
  db.run("UPDATE offers SET status = ?, updated_at = ? WHERE id = ?", status, new Date().toISOString(), id);
  addEvent(db, { offerId: id, actor, kind: "offer", summary: status === "kept" ? "Offre retenue" : status === "ignored" ? "Offre écartée" : "Offre remise dans les nouvelles" });
  return getOffer(db, id);
}

export function saveAnalysis(db: Database, id: string, analysis: Analysis, actor: "agent" | "system" | "import" | "user"): Offer {
  getOffer(db, id);
  const score = Math.max(0, Math.min(100, Math.round(analysis.score)));
  db.run("UPDATE offers SET analysis = ?, score = ?, updated_at = ? WHERE id = ?", JSON.stringify({ ...analysis, score }), score, new Date().toISOString(), id);
  addEvent(db, { offerId: id, actor, kind: "analysis", summary: `Analyse ${analysis.by === "local" ? "locale (sans IA)" : analysis.by === "import" ? "importée" : "par Claude"} : ${score}/100` });
  return getOffer(db, id);
}

/** The user decides that a probable duplicate is a different offer, or merges it into the other one. */
export function resolveSimilar(db: Database, id: string, decision: "distinct" | "merge"): Offer | null {
  const o = getOffer(db, id);
  if (!o.similarTo) return o;
  if (decision === "distinct") {
    db.run("UPDATE offers SET similar_to = NULL WHERE id = ?", id);
    addEvent(db, { offerId: id, actor: "user", kind: "offer", summary: `Confirmée distincte de « ${o.similarTo.title} »` });
    return getOffer(db, id);
  }
  if (o.applicationId) throw new AppError("invalid_state", "Cette offre a déjà une candidature : fusionnez plutôt l'autre dans celle-ci.");
  const target = o.similarTo.id;
  db.tx(() => {
    for (const s of o.sources) db.run("INSERT INTO offer_sources (id, offer_id, source, url, seen_at, note) VALUES (?, ?, ?, ?, ?, ?)", newId("src"), target, s.source, s.url, s.seenAt, "fusionnée");
    db.run("DELETE FROM offers WHERE id = ?", id);
    addEvent(db, { offerId: target, actor: "user", kind: "offer", summary: `Doublon fusionné : ${o.company}, ${o.title}` });
  });
  return null;
}
