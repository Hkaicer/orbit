// The folder of each application, written by ORBIT in its own Applications
// directory (never in the user's original folders). OFFRE.md, SUIVI.md and
// SOURCES.md are rewritten from the database at each update. ANALYSE.md is only
// written when there is an analysis. PREPARATION_ENTRETIEN.md and NOTES.md are
// only written on request and never overwritten by an update.

import fs from "node:fs";
import path from "node:path";
import type { Analysis } from "../../shared/types";
import { STATUS_LABELS } from "../../shared/types";
import type { Database } from "../db/database";
import { getApplicationDetail } from "../domain/applications";
import { addEvent } from "../domain/history";
import { AppError } from "../errors";

/** A folder name without accents or spaces, short but recognizable. */
export function folderName(s: string, max = 60): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9-]+/g, "_")
      .replace(/_*-_*/g, "-")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, max)
      .replace(/_$/, "") || "Sans_titre"
  );
}

/** A path inside the Applications directory, or an error. */
export function inside(base: string, ...parts: string[]): string {
  const target = path.resolve(base, ...parts);
  const root = path.resolve(base);
  if (target !== root && !target.startsWith(root + path.sep)) throw new AppError("forbidden", "Chemin en dehors du dossier des candidatures.");
  return target;
}

const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Paris" }) : "");
const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (rien)");

function analysisMd(a: Analysis | null, imported: string | null): string | null {
  if (!a && !imported) return null;
  const out: string[] = [];
  if (a && a.by !== "import") {
    const verdict = { priority: "postuler en priorité", apply: "postuler", check: "vérifier un point d'abord", skip: "ne pas prioriser" }[a.verdict];
    out.push(
      `# Analyse`,
      ``,
      `Score de compatibilité du profil : **${a.score} / 100** → ${verdict}`,
      `(compétences techniques ${a.breakdown.skills} / 45, formation et niveau ${a.breakdown.education} / 20, expérience et missions ${a.breakdown.experience} / 35)`,
      ``,
      `Analyse ${a.by === "local" ? "locale par mots-clés, sans IA" : `par Claude${a.model ? ` (${a.model})` : ""}`}, le ${date(a.at)}. Le score aide à décider, il ne garantit rien.`,
      ``,
      `## Points pratiques`,
      a.practical.length ? a.practical.map((p) => `- ${p.severity === "blocking" ? "**BLOQUANT** : " : p.severity === "warning" ? "Attention : " : ""}${p.label}`).join("\n") : "- (aucun)",
      ``,
      `## Arguments favorables`,
      list(a.pros),
      ``,
      `## Lacunes et risques`,
      list(a.gaps),
      ``,
      `## Critères obligatoires à vérifier`,
      list(a.toVerify),
      ``,
      `## Compétences à mettre en avant`,
      list(a.highlight),
      ``,
      `## Ajustements du CV`,
      list(a.cvAdjustments),
      ``,
      `## Faits`,
      `Vérifiés :`,
      list(a.facts.verified),
      `Déduits :`,
      list(a.facts.inferred),
      `Manquants :`,
      list(a.facts.missing),
      ``,
      `## Prochaines actions`,
      list(a.nextActions),
    );
  }
  if (imported) out.push(``, `## Analyse d'origine (OFFRE.md du dossier source)`, ``, imported.replace(/^# .*\n/, ""));
  return out.join("\n").trim() + "\n";
}

export interface FolderResult {
  folder: string;
  written: string[];
}

/** Create or update the folder of an application. */
/** The application's folder in ORBIT's Applications directory (made or not yet). */
export function applicationFolder(db: Database, applicationsDir: string, applicationId: string): string {
  const app = getApplicationDetail(db, applicationId);
  const o = app.offerFull;
  return app.folder && fs.existsSync(app.folder) ? app.folder : inside(applicationsDir, folderName(o.company, 40), folderName(`${o.title}${o.reference ? `_${o.reference}` : ""}`));
}

export function writeApplicationFolder(db: Database, applicationsDir: string, applicationId: string, actor: "user" | "agent" | "system"): FolderResult {
  const app = getApplicationDetail(db, applicationId);
  const o = app.offerFull;
  const folder = applicationFolder(db, applicationsDir, applicationId);
  fs.mkdirSync(folder, { recursive: true });
  const files: Record<string, string> = {};

  files["OFFRE.md"] = [
    `# ${o.company} — ${o.title}`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Entreprise | ${o.company} |`,
    `| Poste | ${o.title} |`,
    `| Type | ${o.contract ?? "non précisé"} |`,
    `| Lieu | ${o.location ?? "non précisé"} |`,
    `| Durée | ${o.duration ?? "non précisée"} |`,
    `| Début | ${o.startDate ?? "non précisé"} |`,
    `| Référence | ${o.reference ?? ""} |`,
    `| Lien | ${o.url ?? ""} |`,
    `| Découverte le | ${date(o.discoveredAt)} |`,
    ``,
    o.missing.length ? `Informations manquantes : ${o.missing.join(", ")}.\n` : "",
    `## Texte de l'offre`,
    ``,
    o.description.trim() || "(pas de texte : collez la description de l'offre dans ORBIT)",
    ``,
  ].join("\n");

  const analysis = analysisMd(o.analysis, o.analysisMd);
  if (analysis) files["ANALYSE.md"] = analysis;

  files["SUIVI.md"] = [
    `# Suivi : ${o.company}, ${o.title}`,
    ``,
    `Fichier généré par ORBIT, réécrit à chaque mise à jour.`,
    ``,
    `- Statut : **${STATUS_LABELS[app.status]}**`,
    `- Mode d'automatisation : ${app.mode}`,
    `- Envoyée le : ${app.sentAt ? date(app.sentAt) : "non"}`,
    `- CV utilisé : ${app.cvPath ?? "non renseigné"}`,
    `- Lettre utilisée : ${app.letterPath ?? "non renseignée"}`,
    `- Prochaine action : ${app.nextAction ?? "aucune"}${app.nextActionDue ? ` (avant le ${app.nextActionDue})` : ""}`,
    ``,
    `## Preuves`,
    app.evidence.length
      ? app.evidence
          .map(
            (e) =>
              `- ${e.confirmed ? "[confirmée]" : "[à confirmer]"} ${e.kind === "email" ? `mail du ${date(e.mailDate)} de ${e.mailFrom ?? "?"} : « ${e.mailSubject ?? ""} »` : (e.excerpt ?? e.kind)}${e.suggests ? ` → ${STATUS_LABELS[e.suggests]}` : ""}`,
          )
          .join("\n")
      : "- (aucune)",
    ``,
    `## Tests, entretiens et échéances`,
    app.deadlines.length
      ? app.deadlines
          .map((d) => `- ${d.title}${d.dueAt ? ` (échéance ${d.dueAt})` : ""} : ${d.status === "done" ? "fait, confirmé par vous" : d.status === "cancelled" ? "annulé" : "à faire"}`)
          .join("\n")
      : "- (aucun)",
    ``,
    `## Historique`,
    app.history.map((h) => `- ${date(h.at)} · ${h.actor} · ${h.summary}`).join("\n"),
    ``,
  ].join("\n");

  files["SOURCES.md"] = [
    `# Sources`,
    ``,
    ...o.sources.map((s) => `- ${s.source}${s.url ? ` : ${s.url}` : ""} (vue le ${date(s.seenAt)})`),
    ``,
    `Dernière vérification de l'offre : ${o.lastCheckedAt ? date(o.lastCheckedAt) : date(o.discoveredAt)}`,
    app.sourceFolder ? `\nDossier d'origine (lecture seule, jamais modifié) : ${app.sourceFolder}` : "",
    ``,
  ].join("\n");

  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), content, "utf8");
  db.run("UPDATE applications SET folder = ?, updated_at = ? WHERE id = ?", folder, new Date().toISOString(), applicationId);
  addEvent(db, { applicationId, offerId: app.offerId, actor, kind: "folder", summary: `Dossier ${app.folder ? "mis à jour" : "créé"} : ${Object.keys(files).join(", ")}`, details: { folder } });
  return { folder, written: Object.keys(files) };
}

export const EXTRA_FILES = ["PREPARATION_ENTRETIEN.md", "NOTES.md"] as const;

/** A file written on request (interview preparation, notes). An existing file is kept as a dated copy. */
export function writeExtraFile(db: Database, applicationsDir: string, applicationId: string, name: (typeof EXTRA_FILES)[number], content: string, actor: "user" | "agent"): string {
  if (!EXTRA_FILES.includes(name)) throw new AppError("validation", "Fichier non autorisé.");
  const { folder } = writeApplicationFolder(db, applicationsDir, applicationId, actor === "agent" ? "agent" : "user");
  const file = inside(folder, name);
  if (fs.existsSync(file)) fs.copyFileSync(file, inside(folder, `${name.replace(/\.md$/, "")}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`));
  fs.writeFileSync(file, content.trim() + "\n", "utf8");
  addEvent(db, { applicationId, actor, kind: "local", summary: `${name} écrit dans le dossier`, details: { file } });
  return file;
}
