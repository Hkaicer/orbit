// A job search asked through the assistant: every active source is read, the
// offers outside the search are left out, and the rest are ranked by how well
// they fit the user's profile and CVs. Where the offer is never counts in the
// score: a place the user asked for is only a filter.

import { randomBytes } from "node:crypto";
import type { Analysis } from "../../shared/types";
import type { Database } from "../db/database";
import { dedupKey, normalize, urlKey } from "../domain/offers";
import { KEYWORDS } from "../services/localScore";
import type { Settings } from "../services/settings";
import {
  BOARD_LABELS,
  collectBoard,
  collectCompany,
  LINKEDIN_LIMITS,
  MissingKey,
  SlowedDown,
  type BoardId,
  type CollectDeps,
  type CollectQuery,
  type CompanySource,
  type FoundJob,
  type SearchKeys,
} from "./collectors";

export type ContractKind = "stage" | "alternance" | "cdi" | "cdd" | "freelance";

export interface SearchCriteria {
  /** Words searched for, in French and in English (cybersécurité, cybersecurity, SOC...). */
  keywords: string[];
  /** Empty: every kind of contract. */
  contracts: ContractKind[];
  /** Places to keep, as a filter only (Paris, Île-de-France, France). Empty: everywhere. */
  locations: string[];
  /** With places: also keep remote offers. Without places: only remote offers. */
  remote: boolean;
  since: "24h" | "week" | "month" | null;
  /** Words that leave an offer out, on top of the excluded words of the Settings. */
  exclude: string[];
  limit: number;
  /** Only these sources (board ids or company names). Empty: all active ones. */
  only: string[];
}

export interface ScoredJob extends FoundJob {
  id: string;
  score: number;
  reasons: string[];
  skills: { have: string[]; missing: string[] };
  contractKind: ContractKind | null;
}

export interface SearchOutcome {
  searchId: string;
  sources: { source: string; found: number; error?: string }[];
  /** Offers read, then left out, before ranking. */
  counts: { read: number; outsideSearch: number; excluded: number; otherContract: number; otherPlace: number; alreadyInOrbit: number; duplicates: number; kept: number };
  results: ScoredJob[];
}

// ---- matching and scoring ----------------------------------------------------------

/** Words of 3 letters or less must be whole words (SOC, not "associate"), longer ones the start of a word (cyber, cybersécurité). */
export function hasWord(text: string, word: string): boolean {
  const t = ` ${normalize(text)} `;
  const w = normalize(word);
  if (!w) return false;
  const one = (x: string) => (x.length <= 3 ? t.includes(` ${x} `) : t.includes(` ${x}`));
  if (one(w)) return true;
  // A phrase matches when all its words are there, in any order ("cloud security" finds "Security Engineer - Cloud").
  const words = w.split(" ").filter((x) => !LINK_WORDS.has(x));
  return words.length > 1 && words.every(one);
}

/** Cities and areas of Île-de-France, as job sites write them (often without the country). */
const IDF = [
  "paris",
  "ile de france",
  "idf",
  "la defense",
  "puteaux",
  "courbevoie",
  "nanterre",
  "boulogne",
  "issy",
  "levallois",
  "neuilly",
  "montrouge",
  "saint denis",
  "saint ouen",
  "clichy",
  "montreuil",
  "vincennes",
  "ivry",
  "rueil",
  "suresnes",
  "versailles",
  "velizy",
  "guyancourt",
  "elancourt",
  "massy",
  "palaiseau",
  "saclay",
  "orsay",
  "les ulis",
  "evry",
  "cergy",
  "creteil",
  "noisy",
  "marne la vallee",
  "roissy",
  "saint quentin en yvelines",
  "meudon",
  "chatillon",
  "bagneux",
  "antony",
  "gennevilliers",
];
/** Other French cities often seen in offers. */
const FRANCE = [
  ...IDF,
  "france",
  "lyon",
  "marseille",
  "toulouse",
  "nice",
  "nantes",
  "strasbourg",
  "montpellier",
  "bordeaux",
  "lille",
  "rennes",
  "reims",
  "toulon",
  "grenoble",
  "dijon",
  "angers",
  "nimes",
  "aix en provence",
  "brest",
  "tours",
  "amiens",
  "limoges",
  "clermont ferrand",
  "metz",
  "besancon",
  "orleans",
  "rouen",
  "caen",
  "nancy",
  "sophia antipolis",
  "valbonne",
  "mulhouse",
  "pau",
  "la rochelle",
  "poitiers",
  "le mans",
  "perpignan",
  "annecy",
  "lannion",
  "niort",
  "villeurbanne",
  "blagnac",
  "colomiers",
  "merignac",
];
const IDF_DEPT = /\((75|77|78|91|92|93|94|95)\)|\b(75|77|78|91|92|93|94|95)\d{3}\b/;
const FR_DEPT = /\((0[1-9]|[1-8]\d|9[0-5]|2a|2b)\)|\b(0[1-9]|[1-8]\d|9[0-5])\d{3}\b/;

/** Whether an offer's place fits a place asked for: "France" and "Île-de-France" also know their cities. */
export function placeFits(location: string, place: string): boolean {
  const where = ` ${normalize(location)} `;
  const p = normalize(place);
  const any = (names: string[]) => names.some((n) => where.includes(` ${n} `) || where.includes(` ${n}`));
  if (p === "france" || p === "fr") return any(FRANCE) || FR_DEPT.test(location.toLowerCase());
  if (p === "ile de france" || p === "idf" || p === "paris region" || p === "region parisienne") return any(IDF) || IDF_DEPT.test(location);
  return where.includes(` ${p}`);
}

const LINK_WORDS = new Set(["et", "de", "du", "des", "la", "le", "les", "en", "a", "au", "aux", "pour", "and", "of", "the", "in", "for", "to"]);

export function contractOf(job: Pick<FoundJob, "contract" | "title">): ContractKind | null {
  const t = ` ${normalize(`${job.contract ?? ""} ${job.title}`)} `;
  if (/ (stage|stagiaire|intern|interns|internship|trainee|pfe) /.test(t)) return "stage";
  if (/ (alternance|alternant|alternante|apprenti|apprentie|apprentissage|apprenticeship|work study) /.test(t)) return "alternance";
  if (/ (cdd|temporary|fixed term|temporaire|interim|mis) /.test(t)) return "cdd";
  if (/ (freelance|independant|contractor) /.test(t)) return "freelance";
  if (/ (cdi|permanent|full time|fulltime|temps plein) /.test(t)) return "cdi";
  return null;
}

const SENIOR = / (senior|sr|confirme|confirmee|expert|experte|lead|principal|head|directeur|directrice|director|vp) /;

/** What the score compares an offer with: the user's search, orientations and skills (from the CVs). */
export interface FitBasis {
  keywords: string[];
  orientations: string[];
  skills: Set<string>;
  contracts: ContractKind[];
}

export function fitBasis(db: Database, settings: Settings, criteria: SearchCriteria): FitBasis {
  const line = (name: RegExp) =>
    settings.profile
      .split("\n")
      .filter((l) => name.test(l))
      .flatMap((l) => l.replace(/^[-•]\s*[^:]+:\s*/, "").split(/[,;/]| et | and /i))
      .map((x) => x.replace(/\(.*?\)/g, "").trim())
      .filter((x) => x.length >= 2 && x.length <= 60 && !/à compléter/i.test(x));
  const cvs = ` ${db
    .all<{ text: string | null }>("SELECT text FROM documents WHERE kind = 'cv' AND private = 0")
    .map((r) => normalize(r.text ?? ""))
    .join(" ")} `;
  const skills = new Set(KEYWORDS.filter((k) => cvs.includes(` ${normalize(k)}`)));
  return { keywords: criteria.keywords, orientations: line(/^- (Orientations|Compétences)/i), skills, contracts: criteria.contracts };
}

/** Skills almost every offer cites: they count, but much less than a specific one (SIEM, EBIOS, Splunk...). */
const GENERIC = new Set([
  "data",
  "excel",
  "risk",
  "risque",
  "compliance",
  "conformit",
  "anglais",
  "english",
  "finance",
  "banque",
  "transformation",
  "conseil",
  "consulting",
  "strategie",
  "ia ",
  "windows",
  "linux",
  "cloud",
]);
const JUNIOR = / (stage|stagiaire|intern|internship|junior|jr|graduate|early career|entry level|debutant|debutante|apprentice) /;
const MANAGER = / (manager|managing) /;

export function scoreJob(job: FoundJob, basis: FitBasis, now: Date = new Date()): Omit<ScoredJob, "id" | keyof FoundJob> {
  const reasons: string[] = [];
  const title = ` ${normalize(job.title)} `;
  // The search: a keyword in the title weighs much more than in the description.
  const inTitle = basis.keywords.filter((k) => hasWord(job.title, k));
  const inText = basis.keywords.filter((k) => !inTitle.includes(k) && hasWord(job.description, k));
  let score = inTitle.length ? 30 : inText.length ? 12 : 0;
  if (inTitle.length + inText.length >= 2) score += 5;
  if (inTitle.length) reasons.push(`« ${inTitle[0]} » dans le titre`);
  else if (inText.length) reasons.push(`« ${inText[0]} » dans la description`);

  const orientation = basis.orientations.find((o) => hasWord(job.title, o) || (o.length > 3 && hasWord(job.description, o)));
  if (orientation) {
    score += 15;
    reasons.push(`dans vos orientations : ${orientation}`);
  }

  // The skills of the CVs that the offer asks for: the specific ones make the difference.
  const text = ` ${normalize(`${job.title} ${job.description}`)} `;
  const asked = KEYWORDS.filter((k) => text.includes(` ${normalize(k)}`));
  const have = asked.filter((k) => basis.skills.has(k));
  const missing = asked.filter((k) => !basis.skills.has(k));
  const specific = have.filter((k) => !GENERIC.has(k));
  score += Math.min(30, specific.length * 5) + (asked.length ? Math.round((5 * have.length) / asked.length) : 0);
  if (have.length) reasons.push(`compétences de vos CV : ${[...specific, ...have.filter((k) => GENERIC.has(k))].slice(0, 6).join(", ")} (${have.length} sur ${asked.length})`);

  const kind = contractOf(job);
  if (kind && basis.contracts.includes(kind)) {
    score += 10;
    reasons.push(`contrat : ${kind}`);
  }
  if (JUNIOR.test(title)) {
    score += 8;
    reasons.push("poste ouvert aux débutants");
  } else if (MANAGER.test(title)) {
    score -= 10;
    reasons.push("poste de manager");
  }
  if (job.posted) {
    const days = (now.getTime() - Date.parse(job.posted)) / 86_400_000;
    if (days >= 0 && days <= 14) {
      score += 5;
      reasons.push(days < 1 ? "publiée aujourd'hui" : `publiée il y a ${Math.round(days)} jour${Math.round(days) > 1 ? "s" : ""}`);
    }
  }
  if (SENIOR.test(title)) {
    score -= 30;
    reasons.push("poste de niveau senior ou expert");
  }
  return { score: Math.max(0, Math.min(100, score)), reasons, skills: { have, missing }, contractKind: kind };
}

/** The search's score, saved on the offer as an estimate until the AI analyzes it. */
export function fitAnalysis(job: ScoredJob, now: Date = new Date()): Analysis {
  const asked = job.skills.have.length + job.skills.missing.length;
  return {
    score: job.score,
    breakdown: { skills: asked ? Math.round((45 * job.skills.have.length) / asked) : 0, education: 0, experience: 0 },
    verdict: job.score >= 75 ? "apply" : job.score >= 55 ? "check" : "skip",
    pros: job.reasons,
    gaps: job.skills.missing.length ? [`Mots-clés de l'offre absents de vos CV : ${job.skills.missing.join(", ")}`] : [],
    toVerify: ["Score estimé par ORBIT pendant la recherche (mots-clés, compétences de vos CV, contrat), sans tenir compte du lieu. L'analyse par l'IA donne un avis complet."],
    highlight: job.skills.have,
    cvAdjustments: [],
    nextActions: ["Analyser l'offre avec l'IA"],
    practical: [],
    facts: { verified: [], inferred: [], missing: job.description ? [] : ["Description non lue : seule la liste du site a été lue"] },
    by: "local",
    at: now.toISOString(),
  };
}

// ---- the search ----------------------------------------------------------------------

const cache = new Map<string, { at: number; jobs: Map<string, ScoredJob> }>();
const CACHE_MS = 12 * 3600_000;

/** A job of a recent search, to add it to the offers. */
export function cachedJob(searchId: string, id: string): ScoredJob | null {
  const c = cache.get(searchId);
  if (!c || Date.now() - c.at > CACHE_MS) return null;
  return c.jobs.get(id) ?? null;
}

export interface SearchDeps {
  db: Database;
  settings: Settings;
  keys: SearchKeys;
  collect: CollectDeps;
  now?: Date;
}

export async function runSearch(d: SearchDeps, criteria: SearchCriteria): Promise<SearchOutcome> {
  const s = d.settings;
  const only = criteria.only.map((x) => normalize(x));
  const wanted = (name: string) => !only.length || only.includes(normalize(name));
  const q: CollectQuery = {
    keywords: criteria.keywords,
    location: criteria.locations[0] ?? "",
    since: criteria.since,
    internship: criteria.contracts.length > 0 && criteria.contracts.every((c) => c === "stage"),
    remoteOnly: criteria.remote && !criteria.locations.length,
  };

  const tasks: { source: string; run: () => Promise<FoundJob[]> }[] = [];
  for (const [board, on] of Object.entries(s.searchBoards) as [BoardId, boolean][]) {
    if (on && (wanted(board) || wanted(BOARD_LABELS[board]))) tasks.push({ source: BOARD_LABELS[board], run: () => collectBoard(board, q, d.collect, d.keys, { adzunaCountry: s.adzunaCountry }) });
  }
  for (const c of s.searchCompanies as CompanySource[]) {
    if (c.active && (wanted(c.company) || wanted(c.type))) tasks.push({ source: c.company, run: () => collectCompany(c, q, d.collect) });
  }

  const settled = await Promise.all(
    tasks.map(async (t) => {
      try {
        return { source: t.source, jobs: await t.run() };
      } catch (err) {
        const known = err instanceof MissingKey || err instanceof SlowedDown;
        return { source: t.source, jobs: [] as FoundJob[], error: known ? (err as Error).message : `inaccessible pour le moment (${(err as Error).message.slice(0, 80)})` };
      }
    }),
  );

  const counts = { read: 0, outsideSearch: 0, excluded: 0, otherContract: 0, otherPlace: 0, alreadyInOrbit: 0, duplicates: 0, kept: 0 };
  const exclude = [...s.alertExclude, ...criteria.exclude];
  const places = criteria.locations.map((l) => normalize(l)).filter(Boolean);
  const known = {
    urls: new Set(d.db.all<{ k: string }>("SELECT url_key AS k FROM offers WHERE url_key IS NOT NULL").map((r) => r.k)),
    keys: new Set(d.db.all<{ k: string }>("SELECT dedup_key AS k FROM offers").map((r) => r.k)),
  };
  const seen = new Set<string>();
  const basis = fitBasis(d.db, s, criteria);
  const kept: ScoredJob[] = [];

  for (const r of settled) {
    for (const job of r.jobs) {
      counts.read++;
      if (!job.title || !job.url) continue;
      if (!criteria.keywords.some((k) => hasWord(job.title, k) || hasWord(job.description, k))) {
        counts.outsideSearch++;
        continue;
      }
      if (exclude.some((w) => hasWord(job.title, w))) {
        counts.excluded++;
        continue;
      }
      const kind = contractOf(job);
      if (criteria.contracts.length && kind && !criteria.contracts.includes(kind)) {
        counts.otherContract++;
        continue;
      }
      if (places.length) {
        const where = normalize(job.location);
        // Remote counts when it is not tied to another country ("US - Remote" is not for someone in France).
        const remoteOk = criteria.remote && (!where || /^(remote|full remote|100 remote|teletravail|a distance|anywhere|worldwide|europe|emea)\b/.test(where));
        if (where && !job.located && !remoteOk && !criteria.locations.some((p) => placeFits(job.location, p))) {
          counts.otherPlace++;
          continue;
        }
      } else if (criteria.remote && !job.remote) {
        counts.otherPlace++;
        continue;
      }
      const u = urlKey(job.url);
      const k = dedupKey(job.company, job.title);
      if ((u && known.urls.has(u)) || known.keys.has(k)) {
        counts.alreadyInOrbit++;
        continue;
      }
      if ((u && seen.has(u)) || seen.has(k)) {
        counts.duplicates++;
        continue;
      }
      if (u) seen.add(u);
      seen.add(k);
      kept.push({ ...job, id: "", ...scoreJob(job, basis, d.now) });
    }
  }
  counts.kept = kept.length;

  // Offers listed with their title only (LinkedIn, Workday, SmartRecruiters) cannot show their skills
  // yet: those whose title holds a searched word are read in full first, then everything is ranked again.
  kept.sort((a, b) => b.score - a.score);
  const limit = Math.max(1, Math.min(50, criteria.limit));
  const toRead = kept.filter((j) => !j.description && j.detail && criteria.keywords.some((k) => hasWord(j.title, k)));
  const linkedin = toRead.filter((j) => j.site === "LinkedIn").slice(0, LINKEDIN_LIMITS.details);
  const others = toRead.filter((j) => j.site !== "LinkedIn").slice(0, 40);
  const read = async (j: ScoredJob) => {
    try {
      j.description = (await j.detail!()).slice(0, 20_000);
      Object.assign(j, scoreJob(j, basis, d.now));
    } catch {
      // Kept with its title only.
    }
  };
  for (let i = 0; i < others.length; i += 6) await Promise.all(others.slice(i, i + 6).map(read));
  // LinkedIn, one page at a time with its pauses.
  for (const j of linkedin) await read(j);

  kept.sort((a, b) => b.score - a.score || (b.posted ?? "").localeCompare(a.posted ?? ""));
  const results = kept.slice(0, limit).map((j, i) => ({ ...j, id: `r${i + 1}`, detail: undefined }));
  const searchId = `srch_${randomBytes(6).toString("hex")}`;
  cache.set(searchId, { at: Date.now(), jobs: new Map(results.map((j) => [j.id, j])) });
  for (const [id, c] of cache) if (Date.now() - c.at > CACHE_MS || cache.size > 10) cache.delete(id);

  return {
    searchId,
    sources: settled.map((r) => ({ source: r.source, found: r.jobs.length, ...(r.error ? { error: r.error } : {}) })),
    counts,
    results,
  };
}

// ---- a company from the link of one of its offers -------------------------------------

const cap = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Recognizes the career site behind a link: Greenhouse, Lever, Ashby, SmartRecruiters, Workday or Yello. */
export function companyFromUrl(raw: string, name?: string): CompanySource | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  const company = (slug: string) => name?.trim() || cap(slug);
  if (/(^|\.)greenhouse\.io$/.test(host) && parts[0]) {
    const slug = parts[0] === "embed" ? (u.searchParams.get("for") ?? "") : parts[0];
    return slug ? { type: "greenhouse", company: company(slug), slug, active: true } : null;
  }
  if (/^jobs\.(eu\.)?lever\.co$/.test(host) && parts[0]) return { type: "lever", company: company(parts[0]), slug: parts[0], eu: host.includes(".eu."), active: true };
  if (host === "jobs.ashbyhq.com" && parts[0]) return { type: "ashby", company: company(parts[0]), slug: parts[0], active: true };
  if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host) && parts[0]) return { type: "smartrecruiters", company: company(parts[0]), slug: parts[0], active: true };
  const wd = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host);
  if (wd) {
    // A language part may come first: /fr-FR/Airbus/job/...
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? "") ? parts[1] : parts[0];
    if (site) return { type: "workday", company: company(site), host, tenant: wd[1]!, site, active: true };
  }
  // Yello: the board (/job_boards/<board>), or one of its offers (/jobs/<id>?job_board_id=<board>).
  const yl = /^([a-z0-9-]+)\.yello\.co$/.exec(host);
  if (yl) {
    const board = parts[0] === "job_boards" ? parts[1] : u.searchParams.get("job_board_id");
    if (board && /^[A-Za-z0-9_-]+$/.test(board)) return { type: "yello", company: company(yl[1]!.replace(/global$/, "")), host, slug: board, active: true };
  }
  return null;
}
