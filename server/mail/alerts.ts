// Job-alert emails (LinkedIn, Indeed, HelloWork, Welcome to the Jungle, APEC, and in
// Morocco Rekrute and Emploi.ma, whose sites cannot be read automatically)
// read from Gmail: each listed job becomes an offer. Only the clean link of the
// job is kept, never the tracking or login tokens the email links carry.

import { normalize } from "../domain/offers";
import { mailText } from "./classify";
import type { RawMail } from "./imap";

export type AlertSource = "LinkedIn" | "Indeed" | "HelloWork" | "Welcome to the Jungle" | "APEC" | "Rekrute" | "Emploi.ma";

export interface AlertJob {
  source: AlertSource;
  title: string;
  company: string;
  location: string | null;
  url: string;
  snippet: string | null;
}

/** Senders of job alerts and recommended jobs. */
const SENDERS: [RegExp, AlertSource][] = [
  [/^(jobalerts-noreply|jobs-noreply)@linkedin\.com$/i, "LinkedIn"],
  [/@(jobalert\.)?indeed\.com$/i, "Indeed"],
  [/@([a-z0-9-]+\.)?hellowork\.(com|fr)$/i, "HelloWork"],
  [/@([a-z0-9-]+\.)?welcometothejungle\.(com|co)$/i, "Welcome to the Jungle"],
  [/@([a-z0-9-]+\.)?apec\.fr$/i, "APEC"],
  [/@([a-z0-9-]+\.)?rekrute\.com$/i, "Rekrute"],
  [/@([a-z0-9-]+\.)?emploi\.ma$/i, "Emploi.ma"],
];

export const ALERT_QUERY =
  "from:(jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com OR jobalert.indeed.com OR alert@indeed.com OR hellowork OR welcometothejungle OR apec.fr OR rekrute.com OR emploi.ma)";

export const alertSource = (address: string | null | undefined): AlertSource | null => {
  if (!address) return null;
  return SENDERS.find(([re]) => re.test(address))?.[1] ?? null;
};

/** The link of a job without any parameter: tokens in alert links can sign the user in. */
function canonical(source: AlertSource, raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (source === "LinkedIn") {
    const id = /\/jobs\/view\/(\d+)/.exec(u.pathname)?.[1];
    return id ? `https://www.linkedin.com/jobs/view/${id}/` : null;
  }
  if (source === "Indeed") {
    const jk = u.searchParams.get("jk") ?? u.searchParams.get("vjk");
    return jk && /^[0-9a-f]{8,24}$/i.test(jk) && host.endsWith("indeed.com") ? `https://${host}/viewjob?jk=${jk}` : null;
  }
  if (source === "HelloWork") return /\/emplois\/\d+\.html$/.test(u.pathname) ? `https://www.hellowork.com${u.pathname}` : null;
  if (source === "Welcome to the Jungle") return /\/jobs\/[^/]+$/.test(u.pathname) && host.includes("welcometothejungle") ? `https://www.welcometothejungle.com${u.pathname}` : null;
  if (source === "APEC") return /detail-offre\/[0-9A-Z]+/i.test(u.pathname) ? `https://www.apec.fr${u.pathname}` : null;
  if (source === "Rekrute") return host.endsWith("rekrute.com") && /^\/(fr\/)?offre-emploi-[a-z0-9-]+-\d+\.html$/i.test(u.pathname) ? `https://www.rekrute.com${u.pathname}` : null;
  if (source === "Emploi.ma") return host.endsWith("emploi.ma") && /^\/offre-emploi-maroc\/[a-z0-9-]+-\d+\/?$/i.test(u.pathname) ? `https://www.emploi.ma${u.pathname.replace(/\/$/, "")}` : null;
  return null;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const HAS_URL = /https?:\/\//;
const SEPARATOR = /^[-_=*]{5,}$/;
/** Lines of a job card that are not its title, company or place. */
const NOISE =
  /^(voir l.offre|view job|postulez|candidature simplifi|easy apply|apply|actively recruiting|recrute activement|promu|promoted|\d+ (ancien|anciens|relation|relations|connexion|alumni|former)|il y a|publi[ée]|posted|nouveau|new|\d+ (jour|day|heure|hour)s?|salaire|salary|be an early applicant|soyez parmi)/i;

/** The jobs listed in an alert email. */
export function parseAlert(m: RawMail): AlertJob[] {
  const source = alertSource(m.from?.address);
  if (!source) return [];
  const lines = mailText(m)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim());
  const jobs: AlertJob[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    for (const raw of lines[i]!.match(URL_RE) ?? []) {
      const url = canonical(source, raw);
      if (!url || seen.has(url)) continue;
      // The card is the text just before the link, back to a separator, another link, or a blank gap once its title is found.
      const card: string[] = [];
      for (let j = i - 1; j >= 0 && card.length < 8; j--) {
        const l = lines[j]!;
        if (SEPARATOR.test(l) || HAS_URL.test(l)) break;
        if (!l) {
          if (card.filter((x) => !NOISE.test(x)).length >= 2) break;
          continue;
        }
        card.unshift(l);
      }
      const text = card.filter((l) => !NOISE.test(l) && !/^https?:/.test(l));
      if (text.length < 2) continue;
      let title: string;
      let company: string;
      let location: string | null = null;
      let snippet: string | null = null;
      if (source === "Indeed") {
        // Title, "Company - Place", then a short summary.
        title = text[0]!;
        const at = text[1]!.lastIndexOf(" - ");
        company = at > 0 ? text[1]!.slice(0, at) : text[1]!;
        location = at > 0 ? text[1]!.slice(at + 3) : null;
        snippet = text.slice(2).join(" ").slice(0, 600) || null;
      } else {
        [title, company] = [text[0]!, text[1]!];
        location = text[2] ?? null;
      }
      if (title.length < 3 || title.length > 200 || company.length > 120) continue;
      seen.add(url);
      jobs.push({ source, title, company, location, url, snippet });
    }
  }
  return jobs;
}

/**
 * Whether a job is in the user's search: one of the keywords in its title, and
 * none of the excluded words (work-study...). Short keywords (IA, SOC, SI...)
 * must be whole words, longer ones may start a word (cyber → cybersécurité).
 */
export function inSearch(title: string, keywords: string[], exclude: string[]): boolean {
  const t = ` ${normalize(title)} `;
  const has = (k: string) => {
    const w = normalize(k);
    if (!w) return false;
    return w.length <= 3 ? t.includes(` ${w} `) : t.includes(` ${w}`) || t.includes(w);
  };
  if (exclude.some(has)) return false;
  // No keyword set: every job of the alerts is kept.
  return !keywords.some((k) => normalize(k)) || keywords.some(has);
}
