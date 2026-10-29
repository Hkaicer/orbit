// User settings, kept as one JSON row in the database. The defaults below are
// neutral: each person fills in the profile (or lets the Discovery by Claude do
// it), and their own values then live only in their local database.

import { z } from "zod";
import type { Database } from "../db/database";

export const DEFAULT_PROFILE = `Profil de référence (à remplir, ou à confier à la Découverte par l'IA dans Réglages, partie Profil). Les CV font foi.
- Formation : à compléter (diplômes, écoles, années).
- Expériences : à compléter (entreprise, poste, dates, missions clés).
- Compétences et outils : à compléter.
- Langues : à compléter.
- Orientations : à compléter (métiers et domaines visés).
- Préférences : à compléter (secteurs, taille d'entreprise, ville ou région).
- Recherche : à compléter (stage, CDI, CDD, alternance, durée).
- Dates : à compléter (date de début possible, disponibilité à écrire sur le CV).
- Critère éliminatoire : à compléter (ce qui écarte vraiment une offre pour vous).
- Coordonnées sur les candidatures : à compléter (téléphone, e-mail, ville, jamais l'adresse complète).`;

export const DEFAULT_SCORING = `Grille (ajustable) :
- Le score sur 100 juge l'adéquation du profil au poste : compétences techniques /45, formation et niveau /20, expérience et missions /35.
- Verdict : postuler en priorité, postuler, vérifier un point, ne pas prioriser.
- Les points pratiques (date de début, durée, lieu, langue exigée) sont listés à part avec leur gravité, sans baisser le score.
- Points bloquants : seulement ceux de la ligne « Critère éliminatoire » du profil, et un type de contrat absent de la ligne « Recherche ».
- Ne jamais inventer une compétence ou une expérience : un mot-clé absent du parcours est une lacune.`;

export const DEFAULT_WRITING_RULES = `Règles pour le CV et la lettre (à ajuster) :

CV
- Langue du CV = langue de l'offre. Une page.
- ATS : une colonne, titres de sections standards, reprendre les intitulés exacts de l'offre (titre du poste en haut, outils, normes).
- Ne jamais inventer une compétence, une expérience, une date ou un chiffre. Un mot-clé absent du parcours reste une lacune et ne va pas dans le CV.
- Coordonnées : téléphone, e-mail et ville. Jamais l'adresse complète.
- Disponibilité : celle de la ligne « Dates » du profil.

Lettre
- Courte (150 à 200 mots), une page aérée, dans la langue de l'offre. Pas de récit de l'expérience, le CV le fait déjà.
- Trois idées : ce qui amène vers l'entreprise, ce que l'entreprise y gagne, ce que le candidat y gagne. Puis la demande d'entretien et la formule de politesse.
- Phrases fluides, pas de tiret cadratin, pas de cliché (« passionné », « environnement stimulant », « relever des défis »).
- Une rencontre avec l'entreprise n'est citée que si elle est réelle et écrite dans le profil.
- Une lettre déjà validée n'est jamais remplacée : une nouvelle version est un nouveau fichier.`;

export const zContact = z.object({
  name: z.string().max(100),
  phone: z.string().max(40),
  email: z.string().max(200),
  city: z.string().max(100),
  signature: z.string().max(100),
});

export const zSettings = z.object({
  profile: z.string().max(20000).default(DEFAULT_PROFILE),
  scoring: z.string().max(10000).default(DEFAULT_SCORING),
  /** The AI service: the Claude plan (Claude Code), the ChatGPT plan, or an API key. */
  provider: z.enum(["claude", "chatgpt", "api"]).default("claude"),
  /** The model used with ChatGPT or an OpenAI key. Empty: the first one the account offers. */
  chatgptModel: z.string().max(120).default(""),
  openaiModel: z.string().max(120).default(""),
  /** When the user agreed that an API key is billed separately. Set by ORBIT when the key is saved. */
  apiConsentAt: z.string().nullable().default(null),
  model: z.enum(["haiku", "sonnet", "opus"]).default("sonnet"),
  effort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
  defaultMode: z.enum(["auto", "A", "B", "C"]).default("auto"),
  claudePath: z.string().max(500).default(""),
  timeoutSec: z.number().int().min(60).max(1800).default(600),
  /** Read only: indexed, never modified. */
  documentRoots: z.array(z.string().max(500)).max(10).default([]),
  /** Tracking files imported read only. */
  trackingFiles: z.array(z.string().max(500)).max(10).default([]),
  /** Files whose path matches one of these words are never sent to Claude. */
  privatePatterns: z.array(z.string().max(100)).max(30).default(["confidentiel", "confidential", "interne", "internal", "export", "logs"]),
  /** Let the assistant search Indeed with the account's official claude.ai connector (read only: search and job details). */
  indeedConnector: z.boolean().default(true),
  /** An offer the user gives the assistant (link or text) gets its CV and cover letter at once. */
  autoDocuments: z.boolean().default(true),
  /** A personal CV generator, only read: its CV models and its layout are reused. Empty: ORBIT's built-in template. */
  cvGenerator: z.string().max(500).default(""),
  /** LibreOffice, to turn the DOCX into PDF. Without it, only the DOCX is made. */
  soffice: z.string().max(500).default("C:\\Program Files\\LibreOffice\\program\\soffice.exe"),
  contact: zContact.default({ name: "", phone: "", email: "", city: "", signature: "" }),
  writingRules: z.string().max(20000).default(DEFAULT_WRITING_RULES),
  /** A job from an alert becomes an offer when its title holds one of these words (none: every job)... */
  alertKeywords: z.array(z.string().max(60)).max(200).default([]),
  /** ...and none of these. */
  alertExclude: z.array(z.string().max(60)).max(100).default([]),
  mailLookbackDays: z.number().int().min(7).max(400).default(120),
  followupAfterDays: z.number().int().min(3).max(60).default(14),
  /** Light, dark, or the theme of the system. */
  theme: z.enum(["system", "light", "dark"]).default("system"),
  /** The first start is over (welcome screen done or skipped). */
  setupDone: z.boolean().default(false),
  /** Set by ORBIT after each Gmail reading. */
  mailLastSyncAt: z.string().nullable().default(null),
});

export type Settings = z.infer<typeof zSettings>;
export const zSettingsPatch = zSettings.partial();

export function loadSettings(db: Database): Settings {
  const row = db.get<{ data: string }>("SELECT data FROM settings WHERE id = 1");
  const parsed = zSettings.safeParse(row ? JSON.parse(row.data) : {});
  return parsed.success ? parsed.data : zSettings.parse({});
}

export function saveSettings(db: Database, patch: Partial<Settings>): Settings {
  const next = zSettings.parse({ ...loadSettings(db), ...patch });
  db.run("INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", JSON.stringify(next));
  return next;
}
