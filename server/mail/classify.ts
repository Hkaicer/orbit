// Sorting recruiting emails on this computer, without the AI: what kind of
// message it is, which application it belongs to, and a deadline if it gives
// one. A rule that is not sure says so, and the user decides.

import type { MailCategory, Status } from "../../shared/types";
import { companyKey, normalize } from "../domain/offers";
import { htmlToText } from "../services/fetchOffer";
import type { RawMail } from "./imap";

const RULES: [MailCategory, RegExp][] = [
  [
    "refusal",
    /malheureusement|ne (pouvons|pourrons) pas donner (une )?suite|pas (été )?retenue?|ne pas donner suite|d[ée]cid[ée] de ne pas|autres? candidat|unfortunately|regret to inform|not (to )?(move|moving) forward|will not be (progressing|moving)|decided not to proceed|other candidates|not been successful|pursue other/i,
  ],
  ["offer", /proposition d'embauche|promesse d'embauche|offre de (stage|contrat|poste) |convention de stage|we are (pleased|delighted|happy) to offer|job offer|offer letter/i],
  // The platform confirms the test was handed in, or sends its results: proof the test is done.
  [
    "test_done",
    /assessment (has been )?(successfully )?(received|submitted|completed)|(successfully|bien) (submitted|completed|envoy[ée]e?s?|soumise?s?|termin[ée]e?)|your (assessment|test) results|results are (now )?(ready|available)|r[ée]sultats? de (votre|ton) ([ée]valuation|test)|thank you for completing|you have (successfully )?completed|merci d'avoir (compl[ée]t[ée]|termin[ée]|r[ée]alis[ée]|pass[ée]|r[ée]pondu)|vous avez (bien )?(termin[ée]|compl[ée]t[ée]|finalis[ée])|nous avons bien re[çc]u vos r[ée]ponses|(test|[ée]valuation) (termin[ée]e?|compl[ée]t[ée]e?|re[çc]ue?)\b/i,
  ],
  [
    "test",
    /makipeople|\bmaki\b|assessfirst|hackerrank|codility|codingame|coderbyte|testgorilla|shl\b|pymetrics|hirevue|cut-e|aon assessment|test (en ligne|technique|de personnalit|psychom|d'aptitude|de logique)|online (assessment|test)|[ée]valuation en ligne|coding (challenge|test|exercise)|game-based assessment|questionnaire (en ligne|de personnalit)|\bassessment\b|votre [ée]valuation(?! de (votre|la) candidature)/i,
  ],
  [
    "interview",
    /entretien|interview|rendez-vous|[ée]change (t[ée]l[ée]phonique|en visio)|visioconf|vos disponibilit|your availability|schedule a (call|meeting)|book a (slot|time)|calendly|rencontrer/i,
  ],
  [
    "ack",
    /(bien|avons) re[çc]u votre candidature|accus[ée] de r[ée]ception|confirmation de (votre )?candidature|candidature a bien [ée]t[ée]|merci (pour|de) votre candidature|merci d'avoir postul|thank you for (applying|your application|your interest)|we have received your application|application (has been )?received|application submitted|your application (to|for)/i,
  ],
];

export const SUGGESTS: Partial<Record<MailCategory, Status>> = { ack: "received", refusal: "refused", test: "test_todo", test_done: "test_done", interview: "interview_proposed", offer: "offer" };

/** Senders of recruiting platforms: an email from them is about an application. */
export const ATS_SENDERS = [
  "smartrecruiters",
  "myworkday",
  "workday",
  "greenhouse",
  "lever.co",
  "ashbyhq",
  "teamtailor",
  "welcometothejungle",
  "jobteaser",
  "taleo",
  "successfactors",
  "icims",
  "jobvite",
  "recruitee",
  "assessfirst",
  "makipeople",
  "testgorilla",
  "pymetrics",
  "hackerrank",
  "codility",
  "hirevue",
  "oraclecloud",
  "breezy",
  "workable",
  "personio",
  "talent-soft",
  "beetween",
  "flatchr",
  "indeed",
  "linkedin",
];

export function mailText(m: RawMail): string {
  return (m.text ?? (m.html ? htmlToText(m.html) : "")).replace(/\r\n?/g, "\n");
}

export function categorize(m: RawMail): MailCategory {
  const hay = `${m.subject}\n${mailText(m).slice(0, 4000)}`;
  for (const [cat, re] of RULES) if (re.test(hay)) return cat;
  return "other";
}

const MONTHS: Record<string, number> = {
  janvier: 1,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** A deadline written in the message ("avant le 5 novembre", "d'ici le 05/11/2026", "within 7 days"), or null. */
export function findDeadline(m: RawMail): string | null {
  const text = normalize(`${m.subject} ${mailText(m).slice(0, 6000)}`);
  const year = m.date.getUTCFullYear();
  const near = /(avant|d ici|jusqu|au plus tard|date limite|deadline|by|before|until|expire)/;
  const numeric = /(avant|d ici le|jusqu au|au plus tard le|date limite|deadline|by|before|until)[^0-9]{0,20}(\d{1,2}) (\d{1,2})(?: (\d{2,4}))?/.exec(text.replace(/\//g, " "));
  if (numeric) {
    const y = numeric[4] ? (numeric[4].length === 2 ? 2000 + Number(numeric[4]) : Number(numeric[4])) : year;
    return iso(y, Number(numeric[3]), Number(numeric[2]));
  }
  const words = new RegExp(`${near.source}[^a-z0-9]{0,20}(?:le |the )?(\\d{1,2})(?:er|st|nd|rd|th)? (${Object.keys(MONTHS).join("|")})(?: (\\d{4}))?`).exec(text);
  if (words) return iso(words[4] ? Number(words[4]) : year, MONTHS[words[3]!]!, Number(words[2]));
  const within = /(sous|dans les|d ici|within|in the next) (\d{1,2}) (jours|days)/.exec(text);
  if (within) return new Date(m.date.getTime() + Number(within[2]) * 86_400_000).toISOString().slice(0, 10);
  return null;
}

export interface Candidate {
  id: string;
  company: string;
  title: string;
  since: string;
}

/** The main words of a company name ("BNP Paribas" → bnp paribas, "Procter & Gamble" → procter gamble). */
function companyWords(company: string): string[] {
  return companyKey(company)
    .split(" ")
    .filter((w) => w.length >= 3 && !["the", "les", "and", "management", "asset", "engines", "france"].includes(w));
}

/**
 * The application an email is about. The company must be named in the sender,
 * subject or text. Between several applications to the same company, the one
 * whose title matches best wins; a tie is left for the user to decide.
 */
export function matchApplication(m: RawMail, candidates: Candidate[]): { applicationId: string | null; ambiguous: string[] } {
  const hay = normalize(`${m.from?.name ?? ""} ${m.from?.address ?? ""} ${m.subject} ${mailText(m).slice(0, 3000)}`);
  const scored = candidates
    .filter((c) => m.date.getTime() >= new Date(c.since).getTime() - 3 * 86_400_000)
    .map((c) => {
      const words = companyWords(c.company);
      const companyHit = words.length > 0 && words.every((w) => hay.includes(w));
      if (!companyHit) return null;
      const titleWords = normalize(c.title)
        .split(" ")
        .filter((w) => w.length > 3 && !["stage", "stagiaire", "intern", "internship"].includes(w));
      const titleHits = titleWords.filter((w) => hay.includes(w)).length;
      return { id: c.id, score: titleWords.length ? titleHits / titleWords.length : 0 };
    })
    .filter((x): x is { id: string; score: number } => x !== null)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { applicationId: null, ambiguous: [] };
  if (scored.length === 1 || scored[0]!.score > scored[1]!.score + 0.15) return { applicationId: scored[0]!.id, ambiguous: [] };
  return { applicationId: null, ambiguous: scored.filter((s) => s.score >= scored[0]!.score - 0.15).map((s) => s.id) };
}
