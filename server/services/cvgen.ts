// Adapted CVs and cover letters, made in a separate process (server/cv/worker.cjs)
// with the user's own CV generator when one is set in the Settings, or else with
// ORBIT's built-in template (server/cv/template.cjs). A generator and the user's
// folders are only read. Files are written in the application's folder inside
// ORBIT's Applications directory, and an existing file is never replaced:
// a new version gets a _v2, _v3... suffix.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../config";
import type { Database } from "../db/database";
import { getApplication } from "../domain/applications";
import { addEvent } from "../domain/history";
import { AppError } from "../errors";
import { applicationFolder, folderName, inside } from "./folders";
import type { Settings } from "./settings";

const WORKER = path.join(ROOT_DIR, "server", "cv", "worker.cjs");

export interface CvBase {
  name: string;
  variant: "stage" | "cdi";
  lang: string | null;
  headline: string;
  track: Record<string, unknown>;
}

export interface LetterInput {
  destinataire: string[];
  lieuDate: string;
  objet: string;
  objetLabel?: string;
  salutation?: string;
  paragraphes: string[];
  formule: string;
}

/** A whole CV, for the built-in template. Words between ** ** are in bold. */
export interface CvContent {
  headline: string;
  profile: string;
  experiences: { role: string; org: string; date: string; bullets: string[] }[];
  education: { degree: string; school: string; date: string; details?: string }[];
  projects?: { title: string; text: string }[];
  skills: { label: string; value: string }[];
  certifications?: string[];
  languages?: string;
  links?: { label: string; url: string }[];
}

export interface GenerateInput {
  applicationId?: string;
  company: string;
  offerTitle: string;
  language: "fr" | "en";
  /** Short name for the files, e.g. Acme_Consultant_Cyber_Stage. */
  fileTag?: string;
  /** With a personal generator: base and overrides. With the built-in template: content. */
  cv?: { base?: string; variant?: "stage" | "cdi"; overrides?: Record<string, unknown>; content?: CvContent };
  letter?: LetterInput;
}

export interface GeneratedFile {
  name: string;
  path: string;
}

function runWorker<T>(input: object, timeoutMs = 240_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.stderr.on("data", () => undefined);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new AppError("unavailable", "Le générateur de CV n'a pas pu être lancé."));
    });
    child.on("close", () => {
      clearTimeout(timer);
      let r: { ok: boolean; error?: string } & T;
      try {
        r = JSON.parse(out);
      } catch {
        return reject(new AppError("unavailable", "Le générateur de CV n'a pas répondu (délai dépassé ou arrêt)."));
      }
      if (!r.ok) return reject(new AppError("unavailable", `Le générateur de CV a échoué : ${r.error}`));
      resolve(r);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** The user's own CV generator, or null for the built-in template. */
function generatorOf(settings: Settings): string | null {
  if (!settings.cvGenerator.trim()) return null;
  if (!fs.existsSync(settings.cvGenerator)) throw new AppError("unavailable", `Générateur de CV introuvable : ${settings.cvGenerator}. Vérifiez son chemin dans les Réglages, ou videz-le pour le modèle intégré.`);
  return settings.cvGenerator;
}

let cache: { key: string; bases: CvBase[] } | null = null;

/** The CV models of the generator, each with its full content. */
export async function cvBases(settings: Settings): Promise<CvBase[]> {
  const generator = generatorOf(settings);
  if (!generator) return [];
  const key = `${generator}:${fs.statSync(generator).mtimeMs}`;
  if (cache?.key === key) return cache.bases;
  const r = await runWorker<{ bases: CvBase[] }>({ cmd: "bases", generator });
  cache = { key, bases: r.bases };
  return r.bases;
}

/** A name that is not taken yet in the folder, in DOCX or in PDF. */
function freeName(folder: string, name: string): string {
  const taken = (n: string) => fs.existsSync(path.join(folder, `${n}.docx`)) || fs.existsSync(path.join(folder, `${n}.pdf`));
  if (!taken(name)) return name;
  for (let v = 2; ; v++) if (!taken(`${name}_v${v}`)) return `${name}_v${v}`;
}

const EM_DASH = /—/;

export async function generateDocuments(db: Database, applicationsDir: string, settings: Settings, input: GenerateInput): Promise<{ folder: string; files: GeneratedFile[]; note: string | null }> {
  if (!input.cv && !input.letter) throw new AppError("validation", "Demandez au moins un CV ou une lettre.");
  const generator = generatorOf(settings);

  if (input.letter) {
    const texts = [input.letter.objet, ...input.letter.paragraphes, input.letter.formule, ...input.letter.destinataire];
    if (texts.some((t) => EM_DASH.test(t))) throw new AppError("validation", "La lettre contient un tiret cadratin (—), contraire aux règles de rédaction : reformule sans.");
  }
  if (input.cv && !input.cv.content) {
    if (!generator) throw new AppError("validation", "Pas de générateur de CV personnel : décris le CV complet dans cv.content (modèle intégré).");
    if (!input.cv.base) throw new AppError("validation", "Donne cv.base (un modèle de list_cv_bases) et cv.overrides.");
    const base = (await cvBases(settings)).find((b) => b.name === input.cv!.base);
    if (!base) throw new AppError("validation", `Modèle de CV inconnu : ${input.cv.base}. Utilise list_cv_bases.`);
    const allowed = new Set([...Object.keys(base.track), "profileTail", "interests", "secInterests", "links", "resultLabel"]);
    const unknown = Object.keys(input.cv.overrides ?? {}).filter((k) => !allowed.has(k));
    if (unknown.length) throw new AppError("validation", `Champs inconnus dans overrides : ${unknown.join(", ")}. Champs du modèle : ${[...allowed].join(", ")}.`);
  }

  const app = input.applicationId ? getApplication(db, input.applicationId) : null;
  const folder = app ? applicationFolder(db, applicationsDir, app.id) : inside(applicationsDir, folderName(input.company, 40), folderName(input.offerTitle));
  fs.mkdirSync(folder, { recursive: true });
  if (app && !app.folder) db.run("UPDATE applications SET folder = ?, updated_at = ? WHERE id = ?", folder, new Date().toISOString(), app.id);

  const lang = input.language.toUpperCase();
  const tag = folderName(input.fileTag?.trim() || `${input.company}_${input.offerTitle}`, 50);
  const c = settings.contact;
  // The last name of the contact details names the files (CV_Martin_...).
  const last = c.name.trim().split(/\s+/).pop() || "Candidat";
  const who = folderName(last.charAt(0).toUpperCase() + last.slice(1).toLowerCase(), 30);
  const result = await runWorker<{ files: string[] }>({
    cmd: "build",
    generator,
    soffice: settings.soffice,
    outDir: folder,
    contact: {
      name: c.name,
      city: c.city,
      phoneMail: `${c.phone}  ·  ${c.email}`,
      signature: c.signature,
      cvLine: `${c.phone}  ·  ${c.email}  ·  ${c.city}`,
    },
    cv: input.cv
      ? { base: input.cv.base, variant: input.cv.variant, overrides: input.cv.overrides ?? {}, content: input.cv.content, lang: input.language, file: freeName(folder, `CV_${who}_${tag}_${lang}`) }
      : null,
    letter: input.letter ? { ...input.letter, file: freeName(folder, `${input.language === "en" ? "CoverLetter" : "LM"}_${who}_${tag}_${lang}`) } : null,
  });
  const files = result.files.map((p) => ({ name: path.basename(p), path: p }));
  const pdf = files.some((f) => f.name.endsWith(".pdf"));
  if (app) addEvent(db, { applicationId: app.id, offerId: app.offerId, actor: "agent", kind: "documents", summary: `Documents préparés : ${files.map((f) => f.name).join(", ")}` });
  return { folder, files, note: pdf ? null : "PDF non créé : LibreOffice est introuvable (chemin dans les Réglages). Le DOCX est prêt." };
}

/** The documents in an application's ORBIT folder, newest first. */
export function folderFiles(folder: string | null): { name: string; path: string; size: number; mtime: string }[] {
  if (!folder || !fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(docx|pdf)$/i.test(e.name))
    .map((e) => {
      const p = path.join(folder, e.name);
      const st = fs.statSync(p);
      return { name: e.name, path: p, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}
