// The library of the user's documents, indexed read only.
//
// Files are never moved, renamed or modified: ORBIT only reads them to know
// their kind, family, language, content fingerprint and text. A status (master,
// adapted) is given from signals that are written down (the folder, an edit made
// after the PDF, a mark in the generator), never from the file name alone.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import type { DocKind, LibraryDocument } from "../../shared/types";
import type { Database } from "../db/database";
import { AppError, newId } from "../errors";
import { log } from "../logger";



const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "__pycache__", ".venv", "venv", ".cache"]);
const TEXT_EXT = new Set([".md", ".txt", ".csv", ".js"]);
const KEEP_EXT = new Set([".docx", ".pdf", ".md", ".txt", ".csv", ".js"]);
const MAX_SIZE = 15 * 1024 * 1024;
const MAX_TEXT = 200_000;

export interface IndexResult {
  indexed: number;
  unchanged: number;
  removed: number;
  errors: { path: string; error: string }[];
  roots: { root: string; files: number; missing: boolean }[];
}

function walk(dir: string, out: string[], depth = 0) {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith("~$")) continue; // Word lock files
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out, depth + 1);
    } else if (e.isFile() && KEEP_EXT.has(path.extname(e.name).toLowerCase())) {
      // Only the content files of the CV generator, not its other scripts.
      if (path.extname(e.name).toLowerCase() === ".js" && !/[\\/]offres[\\/]/.test(p)) continue;
      out.push(p);
    }
  }
}

async function docxText(file: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Reads a JSON list of PDF paths on stdin, writes {path: text} for the readable ones. */
// Bytes in and out: Python's isolated mode (-I) ignores PYTHONIOENCODING, and paths have accents ("Carrière").
const PDF_SCRIPT = `import sys, json
import pypdf
res = {}
for f in json.loads(sys.stdin.buffer.read().decode("utf-8")):
    try:
        r = pypdf.PdfReader(f)
        res[f] = "\\n".join((p.extract_text() or "") for p in r.pages[:6])
    except Exception:
        pass
sys.stdout.buffer.write(json.dumps(res).encode("ascii"))`;

/**
 * The text of several PDFs in one Python run, with the pypdf library when it is
 * installed (the PDFs usually have a .docx twin anyway). Unreadable ones are left out.
 */
async function pdfTexts(files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (files.length === 0) return out;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile("python", ["-I", "-c", PDF_SCRIPT], { timeout: 180_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }, (err, so) =>
        err ? reject(err) : resolve(so),
      );
      child.stdin?.end(JSON.stringify(files));
    });
    for (const [f, t] of Object.entries(JSON.parse(stdout || "{}") as Record<string, string>)) if (t.trim()) out.set(f, t.trim());
  } catch (err) {
    log.warn("pdf text unavailable", { error: (err as Error).message.slice(0, 120) });
  }
  return out;
}

async function extractText(file: string, ext: string, pdfs: Map<string, string>): Promise<string | null> {
  if (ext === ".docx") return docxText(file);
  if (ext === ".pdf") return pdfs.get(file) ?? null;
  if (TEXT_EXT.has(ext)) return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  return null;
}

function kindOf(name: string, file: string, text: string | null): DocKind {
  const n = name.toLowerCase();
  if (/[\\/]offres[\\/][^\\/]+\.js$/i.test(file)) return "generator";
  if (n === "offre.md") return "offer";
  if (/^(suivi|tracking|applications|candidatures)/.test(n) && n.endsWith(".csv")) return "tracking";
  if (/^(lm[_ ]|lettre|coverletter|cover_letter|lettre_motivation)/.test(n)) return "letter";
  if (/^cv[_ -]|curriculum|resume/.test(n)) return "cv";
  // A document named after a person: a CV if its text has the sections of one.
  if (text && /formation|education/i.test(text) && /exp[ée]rience/i.test(text) && /comp[ée]tences|skills/i.test(text)) return "cv";
  return "other";
}

const FAMILIES: [RegExp, string][] = [
  [/ai[_ -]?security|ia[_ -]?cyber|intelligence artificielle|augmented|assistant[_ ]ia/i, "ia_cyber"],
  [/detection|soc\b|soc_|analyste soc|cti\b|blue team/i, "soc_detection"],
  [/securite[_ ]?operationnelle|security engineer|devsecops|ingenieur[_ ]securite/i, "security_engineering"],
  [/grc|audit|gouvernance|conformit|risques?\b|risk/i, "grc_audit"],
  [/strat[ée]gie[_ ]?it|strategy|dsi|transformation|m&a|due[_ ]diligence|conduite[_ ]du[_ ]changement/i, "strategie_transformation"],
  [/consultant|conseil|consulting|confiance num/i, "conseil_cyber"],
  [/reseau|infra|automatisation|devops/i, "ingenierie_si"],
];

function familyOf(name: string, folder: string, kind: DocKind): string | null {
  if (kind !== "cv" && kind !== "letter" && kind !== "generator" && kind !== "offer") return null;
  const hay = `${folder} ${name}`.replace(/[_-]/g, " ");
  return FAMILIES.find(([re]) => re.test(hay) || re.test(`${folder}_${name}`))?.[1] ?? null;
}

function languageOf(name: string, text: string | null): string | null {
  if (/_FR\b|_FR\./i.test(name)) return "fr";
  if (/_EN\b|_EN\.|coverletter/i.test(name)) return "en";
  if (!text) return null;
  const sample = ` ${text.slice(0, 4000).toLowerCase()} `;
  const fr = (sample.match(/ (le|la|les|des|et|pour|avec|dans) /g) ?? []).length;
  const en = (sample.match(/ (the|and|with|for|of|in|to) /g) ?? []).length;
  return fr === 0 && en === 0 ? null : fr >= en ? "fr" : "en";
}

/** The company of an application folder, from its OFFRE.md heading ("# Company — Title"). */
function companyOfFolder(dir: string): string | null {
  const offre = path.join(dir, "OFFRE.md");
  try {
    const first = fs.readFileSync(offre, "utf8").replace(/^﻿/, "").split(/\r?\n/).find((l) => l.startsWith("# "));
    return first ? first.slice(2).split(/\s+[—–-]\s+/)[0]!.trim() : null;
  } catch {
    return null;
  }
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Index the documents of the configured folders. Unchanged files (same size and date) are skipped. */
export async function indexDocuments(db: Database, roots: string[], privatePatterns: string[], now: Date = new Date()): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, unchanged: 0, removed: 0, errors: [], roots: [] };
  const seen = new Set<string>();
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      result.roots.push({ root, files: 0, missing: true });
      continue;
    }
    const files: string[] = [];
    walk(root, files);
    result.roots.push({ root, files: files.length, missing: false });
    const changed = files.filter((file) => {
      seen.add(file);
      try {
        const stat = fs.statSync(file);
        const known = db.get<{ size: number; mtime: string }>("SELECT size, mtime FROM documents WHERE path = ?", file);
        const same = Boolean(known) && Number(known!.size) === stat.size && known!.mtime === stat.mtime.toISOString();
        if (same) result.unchanged++;
        return !same && stat.size <= MAX_SIZE;
      } catch {
        return false;
      }
    });
    const pdfs = await pdfTexts(changed.filter((f) => f.toLowerCase().endsWith(".pdf")));
    for (const file of changed) {
      try {
        const stat = fs.statSync(file);
        const mtime = stat.mtime.toISOString();
        const known = db.get<{ size: number }>("SELECT size FROM documents WHERE path = ?", file);
        const ext = path.extname(file).toLowerCase();
        const name = path.basename(file);
        const text = (await extractText(file, ext, pdfs))?.slice(0, MAX_TEXT) ?? null;
        const kind = kindOf(name, file, text);
        const folder = path.basename(path.dirname(file));
        const isPrivate = privatePatterns.some((p) => p && file.toLowerCase().includes(p.toLowerCase())) && kind !== "cv" && kind !== "letter";
        const row = {
          root,
          name,
          ext: ext.slice(1),
          kind,
          family: familyOf(name, folder, kind),
          language: languageOf(name, text),
          company: kind === "cv" || kind === "letter" || kind === "offer" ? companyOfFolder(path.dirname(file)) : null,
          size: stat.size,
          mtime,
          sha: sha256(file),
        };
        if (known) {
          db.run(
            "UPDATE documents SET root=?, name=?, ext=?, kind=?, family=?, language=?, company=?, size=?, mtime=?, sha256=?, text=?, private=?, indexed_at=? WHERE path=?",
            row.root, row.name, row.ext, row.kind, row.family, row.language, row.company, row.size, row.mtime, row.sha, text, isPrivate ? 1 : 0, now.toISOString(), file,
          );
        } else {
          db.run(
            "INSERT INTO documents (id, path, root, name, ext, kind, family, language, company, size, mtime, sha256, text, private, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            newId("doc"), file, row.root, row.name, row.ext, row.kind, row.family, row.language, row.company, row.size, row.mtime, row.sha, text, isPrivate ? 1 : 0, now.toISOString(),
          );
        }
        result.indexed++;
      } catch (err) {
        result.errors.push({ path: file, error: (err as Error).message.slice(0, 200) });
      }
    }
  }
  // Files that disappeared from the configured folders.
  for (const r of db.all<{ path: string; root: string }>("SELECT path, root FROM documents")) {
    if (!seen.has(r.path) && (roots.includes(r.root) || !fs.existsSync(r.path))) {
      db.run("DELETE FROM documents WHERE path = ?", r.path);
      result.removed++;
    }
  }
  computeStatuses(db, roots);
  log.info("documents indexed", { indexed: result.indexed, unchanged: result.unchanged, removed: result.removed, errors: result.errors.length });
  return result;
}

/** The name of a folder that holds reference CVs. */
const LIBRARY_FOLDER = /^(tous[_ -]?les[_ -]?cv|(cv[_ -]?)?(de[_ -]?)?r[ée]f[ée]rences?([_ -]?cv)?|biblioth[eè]que([_ -]?(des[_ -]?)?cv)?|(cv[_ -]?)?library|master[_ -]?cvs?)$/i;

/** Status and the written signals behind it, recomputed after each indexing. */
function computeStatuses(db: Database, roots: string[]) {
  const docs = db.all<{ id: string; path: string; name: string; kind: string; ext: string; mtime: string; text: string | null }>("SELECT id, path, name, kind, ext, mtime, text FROM documents");
  const generators = docs.filter((d) => d.kind === "generator");
  for (const d of docs) {
    if (d.kind !== "cv" && d.kind !== "letter") continue;
    const signals: string[] = [];
    let status: LibraryDocument["status"] = "unknown";
    const dir = path.dirname(d.path);
    // A folder of reference CVs, anywhere in the path: TOUS_LES_CV, CV_reference, Bibliotheque_CV, CV_library, Master_CV...
    const library = dir.split(/[\\/]/).find((seg) => LIBRARY_FOLDER.test(seg));
    const isLibrary = Boolean(library);
    const hasOffer = fs.existsSync(path.join(dir, "OFFRE.md"));
    if (isLibrary) {
      status = "master";
      signals.push(`Rangé dans la bibliothèque des CV de référence (${library})`);
    } else if (hasOffer) {
      status = "adapted";
      signals.push(`Dans le dossier de candidature « ${path.basename(dir)} », à côté de son OFFRE.md`);
    }
    const twinExt = d.ext === "docx" ? "pdf" : d.ext === "pdf" ? "docx" : null;
    const twin = twinExt ? docs.find((x) => x.path === d.path.replace(/\.(docx|pdf)$/i, `.${twinExt}`)) : undefined;
    if (twin && d.ext === "docx" && new Date(d.mtime).getTime() - new Date(twin.mtime).getTime() > 2 * 60_000) {
      signals.push("Le .docx a été modifié après la création du PDF : probablement retouché à la main");
    }
    if (d.kind === "letter" && hasOffer) {
      const gen = generators.find((g) => path.basename(g.path, ".js") === path.basename(dir));
      if (gen?.text && /lettreManuelle\s*:\s*true/.test(gen.text)) signals.push("Lettre marquée « manuelle » dans le générateur : votre version ne doit pas être réécrite");
    }
    if (!isLibrary && !hasOffer) signals.push("Aucun signal : à classer");
    db.run("UPDATE documents SET status = ?, signals = ? WHERE id = ?", status, JSON.stringify(signals), d.id);
  }
  void roots;
}

const rowToDoc = (db: Database, r: Record<string, unknown>): LibraryDocument => {
  const p = String(r.path);
  const ext = String(r.ext);
  const twinExt = ext === "docx" ? "pdf" : ext === "pdf" ? "docx" : null;
  const twin = twinExt ? db.get<{ path: string }>("SELECT path FROM documents WHERE path = ?", p.replace(/\.(docx|pdf)$/i, `.${twinExt}`)) : undefined;
  return {
    id: String(r.id),
    path: p,
    root: String(r.root),
    name: String(r.name),
    ext,
    kind: r.kind as DocKind,
    family: (r.family as string | null) ?? null,
    language: (r.language as string | null) ?? null,
    company: (r.company as string | null) ?? null,
    size: Number(r.size),
    mtime: String(r.mtime),
    sha256: String(r.sha256),
    status: r.status as LibraryDocument["status"],
    signals: JSON.parse(String(r.signals ?? "[]")) as string[],
    validated: Number(r.validated) === 1,
    private: Number(r.private) === 1,
    duplicates: db.all<{ path: string }>("SELECT path FROM documents WHERE sha256 = ? AND id <> ?", String(r.sha256), String(r.id)).map((x) => x.path),
    pairPath: twin?.path ?? null,
    hasText: Boolean(r.has_text),
    indexedAt: String(r.indexed_at),
  };
};

const COLUMNS = "id, path, root, name, ext, kind, family, language, company, size, mtime, sha256, status, signals, validated, private, indexed_at, (text IS NOT NULL AND length(text) > 0) AS has_text";

export function listDocuments(db: Database, filter: { kind?: DocKind; q?: string } = {}): LibraryDocument[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.kind) {
    where.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.q?.trim()) {
    where.push("(name LIKE ? OR path LIKE ? OR company LIKE ? OR text LIKE ?)");
    const like = `%${filter.q.trim()}%`;
    params.push(like, like, like, like);
  }
  return db.all(`SELECT ${COLUMNS} FROM documents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY kind, path`, ...params).map((r) => rowToDoc(db, r));
}

export function getDocument(db: Database, id: string): LibraryDocument {
  const r = db.get(`SELECT ${COLUMNS} FROM documents WHERE id = ?`, id);
  if (!r) throw new AppError("not_found", "Ce document n'est plus dans la bibliothèque.");
  return rowToDoc(db, r);
}

export function findDocumentByPath(db: Database, filePath: string): LibraryDocument | null {
  const r = db.get(`SELECT ${COLUMNS} FROM documents WHERE path = ? OR name = ?`, filePath, path.basename(filePath));
  return r ? rowToDoc(db, r) : null;
}

/** The text of a document, for reading or for the AI. Private documents never go to the AI. */
export function documentText(db: Database, id: string, forAi: boolean): string {
  const r = db.get<{ text: string | null; private: number; name: string }>("SELECT text, private, name FROM documents WHERE id = ?", id);
  if (!r) throw new AppError("not_found", "Ce document n'est plus dans la bibliothèque.");
  if (forAi && Number(r.private) === 1) throw new AppError("forbidden", `« ${r.name} » est marqué privé : il n'est jamais envoyé à Claude.`);
  return r.text ?? "";
}

export function setDocumentFlags(db: Database, id: string, flags: { validated?: boolean; private?: boolean }): LibraryDocument {
  getDocument(db, id);
  if (flags.validated !== undefined) db.run("UPDATE documents SET validated = ? WHERE id = ?", flags.validated ? 1 : 0, id);
  if (flags.private !== undefined) db.run("UPDATE documents SET private = ? WHERE id = ?", flags.private ? 1 : 0, id);
  return getDocument(db, id);
}
