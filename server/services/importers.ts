// Import of the existing tracking files, read only.
//
// Two formats, told apart by their columns: a tracking file with one folder per
// application next to it (each with its OFFRE.md), and a tracking table with one
// row per offer. A second import changes nothing that the user
// updated since: known offers only get a new source, existing applications are
// left as they are.

import fs from "node:fs";
import path from "node:path";
import type { Analysis, Status } from "../../shared/types";
import type { Database } from "../db/database";
import { createApplication, proposeStatus, confirmEvidence } from "../domain/applications";
import { addEvent } from "../domain/history";
import { createOffer, saveAnalysis, setOfferStatus } from "../domain/offers";
import { log } from "../logger";

/** Parse a CSV separated by ";" with quoted fields (Excel's French format). */
export function parseCsv(text: string, sep = ";"): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((f) => f.trim())) rows.push(row);
  }
  const [head, ...data] = rows;
  if (!head) return [];
  return data.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/** "17/10/2026" to an ISO date (noon UTC, so the day stays the same in Paris). */
export function frDate(s: string | undefined): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((s ?? "").trim());
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12)).toISOString() : null;
}

/** The sections of an OFFRE.md, by heading. */
export function offerSections(md: string): { title: string | null; company: string | null; sections: Record<string, string> } {
  const lines = md.replace(/^﻿/, "").split(/\r?\n/);
  const h1 = lines.find((l) => l.startsWith("# "));
  const [company, ...rest] = (h1?.slice(2) ?? "").split(/\s+[—–]\s+/);
  const sections: Record<string, string> = {};
  let current = "_intro";
  for (const l of lines) {
    if (l.startsWith("## ")) {
      current = l.slice(3).trim();
      sections[current] = "";
    } else if (!l.startsWith("# ")) sections[current] = (sections[current] ?? "") + l + "\n";
  }
  return { title: rest.join(" — ").trim() || null, company: company?.trim() || null, sections };
}

/** The imported score line: "Score de compatibilité : 86 / 100 → postuler en priorité". */
function importedAnalysis(sections: Record<string, string>, at: string): Analysis | null {
  const key = Object.keys(sections).find((k) => k.startsWith("Score de compatibilité"));
  const m = key ? /(\d+)\s*\/\s*100\s*(?:→\s*(.+))?/.exec(key) : null;
  if (!m) return null;
  const verdictText = (m[2] ?? "").toLowerCase();
  const pick = (re: RegExp) => Number(re.exec(sections[key!] ?? "")?.[1] ?? 0);
  return {
    score: Number(m[1]),
    breakdown: { skills: pick(/comp[ée]tences[^\d]{0,40}(\d+)\s*\/\s*45/i), education: pick(/formation[^\d]{0,40}(\d+)\s*\/\s*20/i), experience: pick(/exp[ée]rience[^\d]{0,40}(\d+)\s*\/\s*35/i) },
    verdict: verdictText.includes("priorit") ? "priority" : verdictText.includes("pas la peine") ? "skip" : "apply",
    pros: [],
    gaps: [],
    toVerify: [],
    highlight: [],
    cvAdjustments: [],
    nextActions: [],
    practical: [],
    facts: { verified: [], inferred: [], missing: [] },
    by: "import",
    at,
  };
}

const FOLDER_STATUS: Record<string, Status> = { "à envoyer": "prepared", envoyé: "sent", entretien: "interview_proposed", refus: "refused", offre: "offer" };

export interface ImportReport {
  file: string;
  missing: boolean;
  offersCreated: number;
  offersKnown: number;
  applicationsCreated: number;
  skipped: string[];
}

/** A tracking file (Date ajout, Entreprise, Poste, Dossier, Statut...) and the application folders next to it. */
export function importFolderTracking(db: Database, csvPath: string): ImportReport {
  const report: ImportReport = { file: csvPath, missing: false, offersCreated: 0, offersKnown: 0, applicationsCreated: 0, skipped: [] };
  if (!fs.existsSync(csvPath)) return { ...report, missing: true };
  const base = path.dirname(csvPath);
  for (const row of parseCsv(fs.readFileSync(csvPath, "utf8"))) {
    const company = row["Entreprise"];
    const title = row["Poste"];
    if (!company || !title) {
      report.skipped.push(JSON.stringify(row).slice(0, 80));
      continue;
    }
    const folder = row["Dossier"] ? path.join(base, row["Dossier"]) : null;
    const md = folder && fs.existsSync(path.join(folder, "OFFRE.md")) ? fs.readFileSync(path.join(folder, "OFFRE.md"), "utf8") : null;
    const parsed = md ? offerSections(md) : null;
    const description = parsed?.sections["Texte de l'offre"]?.trim() ?? "";
    const added = frDate(row["Date ajout"]) ?? new Date().toISOString();
    const result = createOffer(
      db,
      {
        company,
        title,
        contract: row["Type"] || null,
        location: row["Lieu"] || null,
        url: row["Lien"] || null,
        source: `${path.basename(base)} (${path.basename(csvPath)})`,
        description,
        discoveredAt: added,
      },
      "import",
    );
    if (!result.created) {
      report.offersKnown++;
      continue;
    }
    report.offersCreated++;
    const offerId = result.offer.id;
    if (md) {
      // The analysis written at the time stays as it was, the score is kept for sorting.
      const analysisMd = md.split(/\r?\n## Texte de l'offre/)[0]!.trim();
      db.run("UPDATE offers SET analysis_md = ? WHERE id = ?", analysisMd, offerId);
      const analysis = parsed ? importedAnalysis(parsed.sections, added) : null;
      if (analysis) saveAnalysis(db, offerId, analysis, "import");
    } else if (row["Score"]) {
      db.run("UPDATE offers SET score = ? WHERE id = ?", Number(row["Score"]) || null, offerId);
    }
    const files = folder && fs.existsSync(folder) ? fs.readdirSync(folder) : [];
    const pick = (re: RegExp) => {
      const f = files.find((n) => re.test(n) && n.endsWith(".docx")) ?? files.find((n) => re.test(n));
      return f && folder ? path.join(folder, f) : null;
    };
    const status = FOLDER_STATUS[(row["Statut"] ?? "").toLowerCase()] ?? "prepared";
    const app = createApplication(db, offerId, {
      actor: "import",
      status: "prepared",
      sourceFolder: folder && fs.existsSync(folder) ? folder : null,
      cvPath: pick(/^CV_/i),
      letterPath: pick(/^(LM_|CoverLetter)/i),
      nextAction: row["Prochaine action"] || null,
      createdAt: added,
    });
    report.applicationsCreated++;
    // A status written in the tracking file is the user's own statement: kept as confirmed proof.
    if (status !== "prepared") {
      const ev = proposeStatus(
        db,
        app.id,
        { kind: "import", excerpt: `Statut « ${row["Statut"]} » dans SUIVI_CANDIDATURES.csv${row["Date envoi"] ? `, envoi le ${row["Date envoi"]}` : ""}`, suggests: status },
        "import",
      );
      confirmEvidence(db, ev.id, { actor: "import" });
      if (status === "sent" && frDate(row["Date envoi"])) db.run("UPDATE applications SET sent_at = ? WHERE id = ?", frDate(row["Date envoi"]), app.id);
    }
    addEvent(db, { applicationId: app.id, offerId, actor: "import", kind: "import", summary: `Importée de SUIVI_CANDIDATURES.csv${folder ? ` (dossier ${path.basename(folder)})` : ""}` });
  }
  log.info("import tracking folders", { created: report.offersCreated, known: report.offersKnown });
  return report;
}

const MASTER_STATUS: Record<string, "offer" | "prepared" | "ignored" | "sent" | "refused"> = {
  found: "offer",
  analyzed: "offer",
  tailored: "prepared",
  failed: "ignored",
  sent: "sent",
  applied: "sent",
  submitted: "sent",
  refused: "refused",
  rejected: "refused",
};

/** A tracking table, one row per offer (Entreprise, Poste, Date decouverte, Source, URL, Statut...). */
export function importTrackingTable(db: Database, csvPath: string, findCv: (name: string) => string | null): ImportReport {
  const report: ImportReport = { file: csvPath, missing: false, offersCreated: 0, offersKnown: 0, applicationsCreated: 0, skipped: [] };
  if (!fs.existsSync(csvPath)) return { ...report, missing: true };
  for (const row of parseCsv(fs.readFileSync(csvPath, "utf8"))) {
    const company = row["Entreprise"];
    const title = row["Poste"];
    if (!company || !title) {
      report.skipped.push(JSON.stringify(row).slice(0, 80));
      continue;
    }
    const discovered = frDate(row["Date decouverte"]) ?? new Date().toISOString();
    const description = [
      row["Technologies"] && `Technologies citées : ${row["Technologies"]}`,
      row["Competences"] && `Compétences : ${row["Competences"]}`,
      row["Notes"] && `Notes de l'époque : ${row["Notes"]}`,
    ]
      .filter(Boolean)
      .join("\n");
    const result = createOffer(
      db,
      {
        company,
        title,
        location: row["Localisation"] || null,
        contract: row["Type"] || null,
        duration: row["Duree"] && !/non pr/i.test(row["Duree"]) ? row["Duree"] : null,
        startDate: row["Date debut"] && !/non pr/i.test(row["Date debut"]) ? row["Date debut"] : null,
        reference: row["ID candidature"] || null,
        url: row["URL"] || null,
        source: `${path.basename(csvPath)} (${row["Source"] || "source inconnue"})`,
        description,
        discoveredAt: discovered,
      },
      "import",
    );
    if (!result.created) {
      report.offersKnown++;
      continue;
    }
    report.offersCreated++;
    const offerId = result.offer.id;
    if (row["Score"]) db.run("UPDATE offers SET score = ? WHERE id = ?", Number(row["Score"]) || null, offerId);
    const kind = MASTER_STATUS[(row["Statut"] ?? "").toLowerCase()] ?? "offer";
    if (kind === "ignored") {
      setOfferStatus(db, offerId, "ignored", "agent");
      addEvent(db, { offerId, actor: "import", kind: "import", summary: `Écartée à l'époque (${row["Statut"]}) : ${row["Action suivante"] || row["Notes"] || ""}`.slice(0, 400) });
      continue;
    }
    if (kind === "offer") continue;
    const cvName = row["CV utilise"] && row["CV utilise"] !== "—" ? row["CV utilise"] : null;
    const app = createApplication(db, offerId, {
      actor: "import",
      cvPath: cvName ? (findCv(cvName) ?? cvName) : null,
      nextAction: row["Action suivante"] || null,
      createdAt: discovered,
    });
    report.applicationsCreated++;
    if (kind === "sent" || kind === "refused") {
      const ev = proposeStatus(db, app.id, { kind: "import", excerpt: `Statut « ${row["Statut"]} » dans ${path.basename(csvPath)}`, suggests: kind }, "import");
      confirmEvidence(db, ev.id, { actor: "import" });
    }
    addEvent(db, { applicationId: app.id, offerId, actor: "import", kind: "import", summary: `Importée de ${path.basename(csvPath)} (${row["Statut"]})` });
  }
  log.info("import master", { created: report.offersCreated, known: report.offersKnown });
  return report;
}

/** Imports one tracking file, in the format its columns show. */
export function importTrackingFile(db: Database, csvPath: string, findCv: (name: string) => string | null): ImportReport {
  if (!fs.existsSync(csvPath)) return { file: csvPath, missing: true, offersCreated: 0, offersKnown: 0, applicationsCreated: 0, skipped: [] };
  const header =
    fs
      .readFileSync(csvPath, "utf8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/, 1)[0] ?? "";
  return /Date decouverte|ID candidature/i.test(header) ? importTrackingTable(db, csvPath, findCv) : importFolderTracking(db, csvPath);
}
