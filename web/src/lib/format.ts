import type { Analysis, DocKind, HistoryEvent, LibraryDocument, MailCategory } from "@shared/types";

const LOCALE = "fr-FR";

/** "2026-11-05" or a full ISO date, shown as "5 nov. 2026". */
export function fmtDate(value: string | null | undefined, withYear = true): string {
  if (!value) return "";
  const d = parse(value);
  if (!d) return value;
  return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = parse(value);
  if (!d) return value;
  return d.toLocaleString(LOCALE, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function parse(value: string): Date | null {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days from today to the date: negative when it is past. */
export function daysFrom(value: string | null | undefined): number | null {
  if (!value) return null;
  const d = parse(value);
  if (!d) return null;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  d.setHours(12, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

export function dueLabel(value: string | null | undefined): { text: string; tone: "danger" | "warning" | "neutral" } | null {
  const n = daysFrom(value);
  if (n === null) return null;
  if (n < 0) return { text: n === -1 ? "hier" : `il y a ${-n} j`, tone: "danger" };
  if (n === 0) return { text: "aujourd'hui", tone: "danger" };
  if (n === 1) return { text: "demain", tone: "warning" };
  if (n <= 7) return { text: `dans ${n} j`, tone: "warning" };
  return { text: fmtDate(value), tone: "neutral" };
}

export function relative(value: string | null | undefined): string {
  if (!value) return "";
  const n = daysFrom(value);
  if (n === null) return "";
  if (n === 0) return "aujourd'hui";
  if (n === -1) return "hier";
  if (n < 0 && n > -31) return `il y a ${-n} j`;
  return fmtDate(value);
}

export const VERDICT_LABELS: Record<Analysis["verdict"], string> = {
  priority: "Postuler en priorité",
  apply: "Postuler",
  check: "Vérifier un point",
  skip: "Ne pas prioriser",
};

export const verdictTone = (v: Analysis["verdict"]) => (v === "priority" ? "success" : v === "apply" ? "accent" : v === "check" ? "warning" : "neutral");

export const scoreTone = (score: number | null | undefined) =>
  score === null || score === undefined ? "outline" : score >= 75 ? "success" : score >= 55 ? "accent" : score >= 40 ? "warning" : "neutral";

export const DOC_KIND_LABELS: Record<DocKind, string> = {
  cv: "CV",
  letter: "Lettre",
  offer: "Offre",
  generator: "Générateur",
  tracking: "Suivi",
  other: "Autre",
};

export const DOC_STATUS_LABELS: Record<LibraryDocument["status"], string> = {
  master: "Version de référence",
  adapted: "Adaptée à une offre",
  draft: "Brouillon",
  unknown: "À qualifier",
};

export const MAIL_LABELS: Record<MailCategory, string> = {
  ack: "Accusé de réception",
  refusal: "Refus",
  interview: "Entretien",
  test: "Test",
  test_done: "Test effectué",
  alert: "Alerte d'offres",
  offer: "Offre",
  followup: "Relance",
  other: "Autre",
};

export const ACTOR_LABELS: Record<HistoryEvent["actor"], string> = {
  user: "Vous",
  agent: "Assistant IA",
  system: "ORBIT",
  gmail: "Gmail",
  import: "Import",
};

export const DEADLINE_LABELS = { test: "Test", interview: "Entretien", followup: "Relance", deadline: "Échéance" } as const;

export const fileName = (p: string | null | undefined) => (p ? (p.split(/[\\/]/).pop() ?? p) : "");

export const sizeLabel = (bytes: number) => (bytes < 1024 ? `${bytes} o` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} Ko` : `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} Mo`);
