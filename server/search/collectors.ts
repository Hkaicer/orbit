// Where offers come from when the assistant searches: company career pages
// (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Yello), job boards with an open
// or official API (France Travail, Adzuna, Remotive, Arbeitnow, RemoteOK), and
// the public searches of LinkedIn, Welcome to the Jungle and HelloWork, read
// without any account and slowly. APEC is left out: its anti-bot protection
// (DataDome) refuses requests that do not come from a browser.
//
// Each collector returns offers in one shape. A collector that fails never stops
// the others: its error is reported with the results.

import { htmlToText } from "../services/fetchOffer";

export type Fetch = typeof fetch;

/** One offer found by a search, before it becomes an offer in ORBIT. */
export interface FoundJob {
  /** The site it was found on, kept on the offer: "LinkedIn", "France Travail", "Site carrières (Greenhouse)"... */
  site: string;
  company: string;
  title: string;
  location: string;
  /** YYYY-MM-DD when known. */
  posted: string | null;
  url: string;
  description: string;
  /** As the site writes it (Intern, CDI, Full-time...), when it says. */
  contract: string | null;
  remote: boolean;
  /** The site already searched in the place asked for (LinkedIn, France Travail, Adzuna): no place filter again. */
  located?: boolean;
  /** Reads the full description later, for offers listed without it (only the best ones are read). */
  detail?: () => Promise<string>;
}

export interface CollectQuery {
  keywords: string[];
  /** Free text for the sites that take a place (LinkedIn, Adzuna). Never used in the score. */
  location: string;
  since: "24h" | "week" | "month" | null;
  internship: boolean;
  remoteOnly: boolean;
}

export interface CollectDeps {
  fetch: Fetch;
  /** Waits between two LinkedIn requests (replaced in tests). */
  sleep: (ms: number) => Promise<void>;
}

export const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
};

const ENTITY_ESCAPED = /&(lt|gt|amp|quot|#39);/g;
const ESCAPES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'" };
/** Text of HTML that a site sends escaped (&lt;p&gt;...), like Greenhouse. */
const escapedHtml = (s: string) => htmlToText(s.replace(ENTITY_ESCAPED, (_, e: string) => ESCAPES[e] ?? _));
const day = (v: unknown) => (typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : typeof v === "number" && v > 0 ? new Date(v).toISOString().slice(0, 10) : null);
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function json<T>(f: Fetch, url: string, init: RequestInit = {}): Promise<T> {
  const res = await f(url, { ...init, headers: { ...BROWSER_HEADERS, accept: "application/json", ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

type J = Record<string, unknown>;

// ---- company career pages ---------------------------------------------------------

export interface CompanySource {
  type: "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workday" | "yello";
  company: string;
  slug?: string;
  /** Workday: <tenant>.wd<n>.myworkdayjobs.com, its tenant and its site. Yello: <company>.yello.co, with the board in slug. */
  host?: string;
  tenant?: string;
  site?: string;
  /** Lever's European service. */
  eu?: boolean;
  active: boolean;
}

const ATS_LABEL: Record<CompanySource["type"], string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", smartrecruiters: "SmartRecruiters", workday: "Workday", yello: "Yello" };
export const careerSite = (type: CompanySource["type"]) => `Site carrières (${ATS_LABEL[type]})`;

export async function collectCompany(src: CompanySource, q: CollectQuery, d: CollectDeps): Promise<FoundJob[]> {
  const site = careerSite(src.type);
  switch (src.type) {
    case "greenhouse": {
      const data = await json<{ jobs?: J[] }>(d.fetch, `https://boards-api.greenhouse.io/v1/boards/${src.slug}/jobs?content=true`);
      return (data.jobs ?? []).map((j) => ({
        site,
        company: src.company,
        title: s(j.title),
        location: s((j.location as J | undefined)?.name),
        posted: day(j.updated_at),
        url: s(j.absolute_url),
        description: escapedHtml(s(j.content)),
        contract: null,
        remote: /remote/i.test(s((j.location as J | undefined)?.name)),
      }));
    }
    case "lever": {
      const host = src.eu ? "api.eu.lever.co" : "api.lever.co";
      const data = await json<J[]>(d.fetch, `https://${host}/v0/postings/${src.slug}?mode=json`);
      return data.map((j) => {
        const cat = (j.categories as J | undefined) ?? {};
        const lists = ((j.lists as J[] | undefined) ?? []).map((l) => `${s(l.text)}\n${htmlToText(s(l.content))}`).join("\n");
        return {
          site,
          company: src.company,
          title: s(j.text),
          location: s(cat.location),
          posted: day(j.createdAt),
          url: s(j.hostedUrl),
          description: [s(j.descriptionPlain), lists, s(j.additionalPlain)].filter(Boolean).join("\n"),
          contract: s(cat.commitment) || null,
          remote: s(j.workplaceType) === "remote",
        };
      });
    }
    case "ashby": {
      const data = await json<{ jobs?: J[] }>(d.fetch, `https://api.ashbyhq.com/posting-api/job-board/${src.slug}`);
      return (data.jobs ?? []).map((j) => ({
        site,
        company: src.company,
        title: s(j.title),
        location: s(j.location),
        posted: day(j.publishedAt),
        url: s(j.jobUrl),
        description: s(j.descriptionPlain),
        contract: s(j.employmentType) || null,
        remote: j.isRemote === true,
      }));
    }
    case "smartrecruiters": {
      const out: FoundJob[] = [];
      for (const kw of q.keywords) {
        const data = await json<{ content?: J[] }>(d.fetch, `https://api.smartrecruiters.com/v1/companies/${src.slug}/postings?${new URLSearchParams({ q: kw, limit: "100" })}`);
        for (const j of data.content ?? []) {
          const loc = (j.location as J | undefined) ?? {};
          const id = s(j.id);
          out.push({
            site,
            company: src.company,
            title: s(j.name),
            location: [s(loc.city), s(loc.country)].filter(Boolean).join(", "),
            posted: day(j.releasedDate),
            url: `https://jobs.smartrecruiters.com/${src.slug}/${id}`,
            description: "",
            contract: s((j.typeOfEmployment as J | undefined)?.label) || null,
            remote: loc.remote === true,
            detail: async () => {
              const p = await json<J>(d.fetch, `https://api.smartrecruiters.com/v1/companies/${src.slug}/postings/${id}`);
              const sections = (((p.jobAd as J | undefined)?.sections as Record<string, J> | undefined) ?? {}) as Record<string, J>;
              return Object.values(sections)
                .map((x) => htmlToText(s(x.text)))
                .join("\n");
            },
          });
        }
      }
      return out;
    }
    case "workday": {
      const out: FoundJob[] = [];
      const base = `https://${src.host}/wday/cxs/${src.tenant}/${src.site}`;
      for (const kw of q.keywords) {
        for (let offset = 0; offset < 100; offset += 20) {
          const data = await json<{ jobPostings?: J[]; total?: number }>(d.fetch, `${base}/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: kw }),
          });
          const posts = data.jobPostings ?? [];
          for (const j of posts) {
            const path = s(j.externalPath);
            out.push({
              site,
              company: src.company,
              title: s(j.title),
              location: s(j.locationsText),
              posted: null,
              url: `https://${src.host}/${src.site}${path}`,
              description: "",
              contract: null,
              remote: /remote|télétravail/i.test(s(j.locationsText)),
              detail: async () => {
                const p = await json<{ jobPostingInfo?: J }>(d.fetch, `${base}${path}`);
                return htmlToText(s(p.jobPostingInfo?.jobDescription));
              },
            });
          }
          if (posts.length < 20) break;
        }
      }
      return out;
    }
    case "yello":
      return yello(src, q, d);
  }
}

/** Yello: a few keywords and pages, so that a search stays a visit. */
export const YELLO_LIMITS = { keywords: 6, pages: 3, minPauseMs: 1500, maxPauseMs: 3000 };

/** A country as career sites name it in their filters, in English first (Yello boards are mostly in English). */
const PLACE_NAMES: Record<string, string[]> = { maroc: ["Morocco", "Maroc"], morocco: ["Morocco", "Maroc"], france: ["France"] };

const fold = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Yello (EY's student and junior offers) has no open API: ORBIT reads the
 * board's own search, as a visitor would, with a pause before each page. The
 * place asked for becomes the board's own filter (country or city) when it has one.
 */
async function yello(src: CompanySource, q: CollectQuery, d: CollectDeps): Promise<FoundJob[]> {
  const site = careerSite("yello");
  const base = `https://${src.host}/job_boards/${src.slug}`;
  const pause = () => d.sleep(YELLO_LIMITS.minPauseMs + Math.random() * (YELLO_LIMITS.maxPauseMs - YELLO_LIMITS.minPauseMs));
  const get = (url: string) => json<J>(d.fetch, url, { headers: { "x-requested-with": "XMLHttpRequest" } });

  let filters: number[] = [];
  let place = "";
  if (q.location.trim()) {
    const res = await d.fetch(base, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const page = await res.text();
    // The board's filters (Country/Region, City...): each one says whether it knows the place.
    const fields = [...new Set([...page.matchAll(/data-filter-search-url="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&")))].filter((u) => u.startsWith(`${base}/`)).slice(0, 6);
    const names = PLACE_NAMES[fold(q.location)] ?? [q.location.trim()];
    search: for (const name of names) {
      for (const url of fields) {
        await pause();
        const data = await get(`${url}${url.includes("?") ? "&" : "?"}${new URLSearchParams({ query: name, page: "1" })}`);
        const hit = ((data.filter_answers as J[] | undefined) ?? []).find((a) => fold(s(a.label)) === fold(name));
        if (hit) {
          filters = [Number(hit.id)];
          place = s(hit.label);
          break search;
        }
      }
    }
  }

  const out: FoundJob[] = [];
  const seen = new Set<string>();
  for (const kw of q.keywords.slice(0, YELLO_LIMITS.keywords)) {
    for (let p = 1; p <= YELLO_LIMITS.pages; p++) {
      await pause();
      const data = await get(`${base}/search?${new URLSearchParams({ query: kw, filters: filters.join(","), page_number: String(p) })}`);
      for (const m of s(data.html).matchAll(/<a[^>]*class="search-results__req_title"[^>]*href="\/jobs\/([A-Za-z0-9_-]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
        const id = m[1]!;
        if (seen.has(id)) continue;
        seen.add(id);
        const url = `https://${src.host}/jobs/${id}?job_board_id=${src.slug}`;
        out.push({
          site,
          company: src.company,
          title: decode(m[2]!),
          location: place,
          posted: null,
          url,
          description: "",
          contract: null,
          remote: false,
          ...(place ? { located: true } : {}),
          detail: async () => {
            await d.sleep(500 + Math.random() * 1000);
            return yelloDetail(d, url);
          },
        });
      }
      if (data.more_requisitions !== true) break;
    }
  }
  return out;
}

/** The text of a Yello offer page and its details (Country/Region, City, Service Line). */
async function yelloDetail(d: CollectDeps, url: string): Promise<string> {
  const res = await d.fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const page = await res.text();
  const start = page.indexOf("job-details__description");
  const end = page.indexOf("job-details__sidebar", start);
  const body = start < 0 ? "" : page.slice(page.indexOf(">", start) + 1, end > start ? page.lastIndexOf("<", end) : undefined);
  const facts = [...page.matchAll(/secondary-details__title">([^<]*)<\/span><span class="secondary-details__content">([^<]*)</g)].map((m) => `${decode(m[1]!)} : ${decode(m[2]!)}`);
  return [htmlToText(body), ...new Set(facts)].filter(Boolean).join("\n");
}

// ---- job boards with an official or open API ------------------------------------------

export interface SearchKeys {
  franceTravail?: { id: string; secret: string };
  adzuna?: { id: string; key: string };
}

export type BoardId = "linkedin" | "wttj" | "hellowork" | "france_travail" | "adzuna" | "remotive" | "arbeitnow" | "remoteok";

export const BOARD_LABELS: Record<BoardId, string> = {
  linkedin: "LinkedIn",
  wttj: "Welcome to the Jungle",
  hellowork: "HelloWork",
  france_travail: "France Travail",
  adzuna: "Adzuna",
  remotive: "Remotive",
  arbeitnow: "Arbeitnow",
  remoteok: "RemoteOK",
};

export class MissingKey extends Error {}

export async function collectBoard(board: BoardId, q: CollectQuery, d: CollectDeps, keys: SearchKeys, opts: { adzunaCountry: string }): Promise<FoundJob[]> {
  const site = BOARD_LABELS[board];
  switch (board) {
    case "linkedin":
      return linkedin(q, d);
    case "wttj":
      return wttj(q, d);
    case "hellowork":
      return hellowork(q, d);
    case "remotive": {
      const out: FoundJob[] = [];
      for (const kw of q.keywords) {
        const data = await json<{ jobs?: J[] }>(d.fetch, `https://remotive.com/api/remote-jobs?${new URLSearchParams({ search: kw })}`);
        for (const j of data.jobs ?? []) {
          out.push({
            site,
            company: s(j.company_name),
            title: s(j.title),
            location: s(j.candidate_required_location),
            posted: day(j.publication_date),
            url: s(j.url),
            description: htmlToText(s(j.description)),
            contract: s(j.job_type) || null,
            remote: true,
          });
        }
      }
      return out;
    }
    case "arbeitnow": {
      const out: FoundJob[] = [];
      for (let page = 1; page <= 3; page++) {
        const data = await json<{ data?: J[]; links?: { next?: string | null } }>(d.fetch, `https://www.arbeitnow.com/api/job-board-api?page=${page}`);
        for (const j of data.data ?? []) {
          out.push({
            site,
            company: s(j.company_name),
            title: s(j.title),
            location: s(j.location),
            posted: typeof j.created_at === "number" ? day(j.created_at * 1000) : null,
            url: s(j.url),
            description: htmlToText(s(j.description)),
            contract: ((j.job_types as string[] | undefined) ?? []).join(", ") || null,
            remote: j.remote === true,
          });
        }
        if (!data.links?.next) break;
      }
      return out;
    }
    case "remoteok": {
      const data = await json<J[]>(d.fetch, "https://remoteok.com/api");
      // The first item is a legal notice.
      return data.slice(1).map((j) => ({
        site,
        company: s(j.company),
        title: s(j.position),
        location: s(j.location),
        posted: day(j.date),
        url: s(j.url),
        description: htmlToText(s(j.description)),
        contract: null,
        remote: true,
      }));
    }
    case "france_travail": {
      const k = keys.franceTravail;
      if (!k) throw new MissingKey("clé France Travail à ajouter dans Réglages, partie Sources de recherche");
      const token = await franceTravailToken(d.fetch, k);
      const out: FoundJob[] = [];
      for (const kw of q.keywords) {
        const res = await d.fetch(`https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search?${new URLSearchParams({ motsCles: kw, range: "0-149" })}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 204) continue;
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { resultats?: J[] };
        for (const j of data.resultats ?? []) {
          const id = s(j.id);
          out.push({
            site,
            company: s((j.entreprise as J | undefined)?.nom) || "Entreprise non indiquée",
            title: s(j.intitule),
            location: s((j.lieuTravail as J | undefined)?.libelle),
            posted: day(j.dateCreation),
            url: s((j.origineOffre as J | undefined)?.urlOrigine) || `https://candidat.francetravail.fr/offres/recherche/detail/${id}`,
            description: s(j.description),
            contract: s(j.typeContratLibelle) || s(j.typeContrat) || null,
            remote: /télétravail/i.test(s(j.description)),
            located: true,
          });
        }
      }
      return out;
    }
    case "adzuna": {
      const k = keys.adzuna;
      if (!k) throw new MissingKey("clé Adzuna à ajouter dans Réglages, partie Sources de recherche");
      const out: FoundJob[] = [];
      for (const kw of q.keywords) {
        for (let page = 1; page <= 2; page++) {
          const params = new URLSearchParams({ app_id: k.id, app_key: k.key, what: kw, results_per_page: "50", "content-type": "application/json" });
          if (q.location) params.set("where", q.location);
          const data = await json<{ results?: J[] }>(d.fetch, `https://api.adzuna.com/v1/api/jobs/${opts.adzunaCountry}/search/${page}?${params}`);
          for (const j of data.results ?? []) {
            out.push({
              site,
              company: s((j.company as J | undefined)?.display_name) || "Entreprise non indiquée",
              title: s(j.title),
              location: s((j.location as J | undefined)?.display_name),
              posted: day(j.created),
              url: s(j.redirect_url),
              description: htmlToText(s(j.description)),
              contract: [s(j.contract_type), s(j.contract_time)].filter(Boolean).join(", ") || null,
              remote: false,
              located: Boolean(q.location),
            });
          }
          if ((data.results ?? []).length < 50) break;
        }
      }
      return out;
    }
  }
}

async function franceTravailToken(f: Fetch, k: { id: string; secret: string }): Promise<string> {
  const res = await f("https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: k.id, client_secret: k.secret, scope: "api_offresdemploiv2 o2dsoffre" }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || !body.access_token) throw new Error(`France Travail a refusé la clé (HTTP ${res.status})`);
  return body.access_token;
}

/** Checks a key with one small request. */
export async function verifySearchKey(f: Fetch, service: "france_travail" | "adzuna", id: string, secret: string, adzunaCountry: string): Promise<boolean> {
  if (service === "france_travail") {
    try {
      await franceTravailToken(f, { id, secret });
      return true;
    } catch {
      return false;
    }
  }
  const res = await f(`https://api.adzuna.com/v1/api/jobs/${adzunaCountry}/search/1?${new URLSearchParams({ app_id: id, app_key: secret, results_per_page: "1" })}`, {
    signal: AbortSignal.timeout(20_000),
  });
  return res.ok;
}

// ---- LinkedIn, public search without an account ---------------------------------------
//
// The same page LinkedIn shows to visitors who are not signed in. To stay light:
// two keywords at most, three pages each, a pause of 2 to 4 seconds between two
// requests, and the search stops at the first "too many requests".

const LINKEDIN = "https://www.linkedin.com/jobs-guest/jobs/api";
export const LINKEDIN_LIMITS = { keywords: 2, pages: 3, details: 12, minPauseMs: 2000, maxPauseMs: 4000 };
const pause = (d: CollectDeps) => d.sleep(LINKEDIN_LIMITS.minPauseMs + Math.random() * (LINKEDIN_LIMITS.maxPauseMs - LINKEDIN_LIMITS.minPauseMs));

export class SlowedDown extends Error {}

async function linkedinGet(d: CollectDeps, url: string): Promise<string> {
  const res = await d.fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(30_000) });
  if (res.status === 429) throw new SlowedDown("LinkedIn a ralenti les demandes : la recherche LinkedIn s'arrête là pour cette fois.");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const decode = (t: string) => htmlToText(t).replace(/\s+/g, " ").trim();

export function parseLinkedinCards(html: string): Omit<FoundJob, "detail">[] {
  // Each offer carries its id once: the page is cut there (its class names also appear inside the offer).
  const cards = html.split(/data-entity-urn="urn:li:jobPosting:/).slice(1);
  const out: Omit<FoundJob, "detail">[] = [];
  for (const card of cards) {
    const id = /^(\d+)/.exec(card)?.[1];
    const title = /<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/.exec(card)?.[1];
    const company = /<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/.exec(card)?.[1];
    const location = /<span[^>]*job-search-card__location[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[1];
    const posted = /<time[^>]*datetime="([^"]+)"/.exec(card)?.[1] ?? null;
    if (!id || !title) continue;
    out.push({
      site: "LinkedIn",
      located: true,
      company: decode(company ?? "") || "Entreprise non indiquée",
      title: decode(title),
      location: decode(location ?? ""),
      posted,
      // A clean link, without the tracking parameters of the search page.
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      description: "",
      contract: null,
      remote: /remote|télétravail|à distance/i.test(location ?? ""),
    });
  }
  return out;
}

async function linkedin(q: CollectQuery, d: CollectDeps): Promise<FoundJob[]> {
  const out: FoundJob[] = [];
  const seen = new Set<string>();
  let first = true;
  for (const kw of q.keywords.slice(0, LINKEDIN_LIMITS.keywords)) {
    for (let page = 0; page < LINKEDIN_LIMITS.pages; page++) {
      if (!first) await pause(d);
      first = false;
      const params = new URLSearchParams({ keywords: kw, location: q.location || "France", start: String(page * 10) });
      if (q.since) params.set("f_TPR", { "24h": "r86400", week: "r604800", month: "r2592000" }[q.since]);
      if (q.internship) params.set("f_E", "1,2");
      if (q.remoteOnly) params.set("f_WT", "2");
      const cards = parseLinkedinCards(await linkedinGet(d, `${LINKEDIN}/seeMoreJobPostings/search?${params}`));
      if (!cards.length) break;
      for (const c of cards) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        const id = /view\/(\d+)/.exec(c.url)![1];
        out.push({
          ...c,
          detail: async () => {
            await pause(d);
            const html = await linkedinGet(d, `${LINKEDIN}/jobPosting/${id}`);
            const body = /<div[^>]+class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
            return htmlToText(body);
          },
        });
      }
      if (cards.length < 10) break;
    }
  }
  return out;
}

// ---- Welcome to the Jungle, through the search service of its site --------------------
//
// The site searches its offers with Algolia, using a public key that is in the
// page itself. If the key changes, it is read again from the page.

const WTTJ_PAGE = "https://www.welcometothejungle.com/fr/jobs";
const WTTJ_INDEX = "wttj_jobs_production_fr";
let wttjKeys = { app: "CSEKHVMS53", key: "4bd8f6215d0cc52b26430765769e65a0" };

const WTTJ_CONTRACTS: Record<string, string> = {
  internship: "Stage",
  full_time: "CDI",
  apprenticeship: "Alternance",
  temporary: "CDD",
  freelance: "Freelance",
  vie: "VIE",
  part_time: "Temps partiel",
};

const France = /^(france|fr|paris|ile de france|idf)$/i;
const plain = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

async function wttjQuery(d: CollectDeps, body: object): Promise<{ hits?: J[]; nbPages?: number }> {
  const send = () =>
    d.fetch(`https://${wttjKeys.app}-dsn.algolia.net/1/indexes/${WTTJ_INDEX}/query`, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "content-type": "application/json",
        "x-algolia-application-id": wttjKeys.app,
        "x-algolia-api-key": wttjKeys.key,
        origin: "https://www.welcometothejungle.com",
        referer: `${WTTJ_PAGE}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  let res = await send();
  if (res.status === 401 || res.status === 403) {
    // The public key of the page has changed: read it again.
    const page = await (await d.fetch(WTTJ_PAGE, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(30_000) })).text();
    const key = /PUBLIC_ALGOLIA_API_KEY_CLIENT["']?\s*[:=]\s*["']([a-f0-9]{20,})/.exec(page)?.[1];
    const app = /PUBLIC_ALGOLIA_APPLICATION_ID["']?\s*[:=]\s*["']([A-Z0-9]{6,})/.exec(page)?.[1];
    if (!key || !app) throw new Error(`HTTP ${res.status}`);
    wttjKeys = { app, key };
    res = await send();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { hits?: J[]; nbPages?: number };
}

const text = (v: unknown): string => (typeof v === "string" ? htmlToText(v) : Array.isArray(v) ? v.map(text).join("\n") : "");

async function wttj(q: CollectQuery, d: CollectDeps): Promise<FoundJob[]> {
  const out: FoundJob[] = [];
  const inFrance = France.test(plain(q.location));
  const filters = [...(q.internship ? ["contract_type:internship"] : []), ...(inFrance ? ["offices.country_code:FR"] : [])].join(" AND ");
  let first = true;
  for (const kw of q.keywords.slice(0, 3)) {
    for (let page = 0; page < 2; page++) {
      if (!first) await d.sleep(1000 + Math.random() * 1000);
      first = false;
      const data = await wttjQuery(d, { query: kw, hitsPerPage: 50, page, ...(filters ? { filters } : {}) });
      for (const h of data.hits ?? []) {
        const org = (h.organization as J | undefined) ?? {};
        const office = ((h.offices as J[] | undefined) ?? [])[0] ?? {};
        out.push({
          site: "Welcome to the Jungle",
          company: s(org.name) || "Entreprise non indiquée",
          title: s(h.name),
          location: [s(office.city), s(office.country)].filter(Boolean).join(", "),
          posted: day(h.published_at),
          url: `https://www.welcometothejungle.com/fr/companies/${s(org.slug)}/jobs/${s(h.slug)}`,
          description: [text(h.summary), text(h.key_missions), text(h.profile)].filter(Boolean).join("\n"),
          contract: WTTJ_CONTRACTS[s(h.contract_type)] ?? (s(h.contract_type) || null),
          remote: ["fulltime", "full", "partial"].includes(s(h.remote)),
          located: inFrance,
        });
      }
      if (page + 1 >= (data.nbPages ?? 0)) break;
    }
  }
  return out;
}

// ---- HelloWork, from its public result pages ----------------------------------------

const HW = "https://www.hellowork.com";

const ENTITY = (t: string) => decode(t);

/** The offers of a HelloWork result page, read from the label of each offer link. */
export function parseHelloworkPage(html: string): Omit<FoundJob, "detail">[] {
  const out: Omit<FoundJob, "detail">[] = [];
  for (const tag of html.match(/<a\b[^>]*data-cy="offerTitle"[^>]*>/g) ?? []) {
    const href = /href="([^"]+)"/.exec(tag)?.[1];
    const label = ENTITY(/aria-label="([^"]+)"/.exec(tag)?.[1] ?? "");
    const id = /\/emplois\/(\d+)\.html/.exec(href ?? "")?.[1];
    // "Voir offre de <titre> à <lieu>, chez <entreprise>, pour un <contrat>, avec un salaire de ..."
    const m = /^Voir offre de (.+?) à ([^,]+), chez (.+?), pour une? ([^,]+)/.exec(label);
    if (!id || !m) continue;
    out.push({
      site: "HelloWork",
      company: m[3]!.trim(),
      title: m[1]!.trim(),
      location: m[2]!.trim(),
      posted: null,
      url: `${HW}/fr-fr/emplois/${id}.html`,
      description: "",
      contract: m[4]!.trim(),
      remote: /télétravail/i.test(label),
    });
  }
  return out;
}

/** The structured job posting of a HelloWork offer page (its type is written escaped: ld&#x2B;json). */
export function helloworkDescription(html: string): string {
  for (const m of html.matchAll(/<script[^>]*application\/ld(?:\+|&#x2B;)json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]!) as J;
      if (j["@type"] === "JobPosting") return htmlToText(s(j.description));
    } catch {
      // another block
    }
  }
  return "";
}

async function hellowork(q: CollectQuery, d: CollectDeps): Promise<FoundJob[]> {
  const out: FoundJob[] = [];
  const seen = new Set<string>();
  let first = true;
  for (const kw of q.keywords.slice(0, 2)) {
    for (let page = 1; page <= 2; page++) {
      if (!first) await d.sleep(1500 + Math.random() * 1500);
      first = false;
      const params = new URLSearchParams({ k: kw, p: String(page) });
      if (q.location) params.set("l", q.location);
      const res = await d.fetch(`${HW}/fr-fr/emploi/recherche.html?${params}`, { headers: { ...BROWSER_HEADERS, accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429) throw new SlowedDown("HelloWork a ralenti les demandes : la recherche HelloWork s'arrête là pour cette fois.");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cards = parseHelloworkPage(await res.text());
      for (const c of cards) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        out.push({
          ...c,
          located: Boolean(q.location),
          detail: async () => {
            await d.sleep(1500 + Math.random() * 1500);
            const r = await d.fetch(c.url, { headers: { ...BROWSER_HEADERS, accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return helloworkDescription(await r.text());
          },
        });
      }
      if (cards.length < 20) break;
    }
  }
  return out;
}
