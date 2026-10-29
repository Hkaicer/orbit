// Export of the tracking table, in CSV (";" and UTF-8 with BOM, opens in Excel)
// and in Excel (.xlsx written directly, with links to the offers and folders).

import JSZip from "jszip";
import { STATUS_LABELS } from "../../shared/types";
import type { Database } from "../db/database";
import { listApplications } from "../domain/applications";

const COLUMNS = [
  "Entreprise",
  "Poste",
  "Statut",
  "Score",
  "Mode",
  "Lieu",
  "Type",
  "Source",
  "Lien",
  "Référence",
  "Découverte le",
  "Envoyée le",
  "Preuve d'envoi",
  "CV utilisé",
  "Lettre utilisée",
  "Prochaine action",
  "Échéance",
  "Dossier ORBIT",
  "Dossier d'origine",
] as const;

type Row = Record<(typeof COLUMNS)[number], string | number | null>;

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }) : "");

export function trackingRows(db: Database): Row[] {
  return listApplications(db).map((a) => {
    const offer = db.get<{ source: string; discovered_at: string }>("SELECT source, discovered_at FROM offers WHERE id = ?", a.offerId);
    const proof = db.get<{ kind: string; mail_subject: string | null; mail_date: string | null; excerpt: string | null }>(
      "SELECT kind, mail_subject, mail_date, excerpt FROM evidence WHERE application_id = ? AND confirmed = 1 AND suggests IN ('sent','received') ORDER BY created_at LIMIT 1",
      a.id,
    );
    return {
      Entreprise: a.offer.company,
      Poste: a.offer.title,
      Statut: STATUS_LABELS[a.status],
      Score: a.offer.score,
      Mode: a.mode,
      Lieu: a.offer.location,
      Type: a.offer.contract,
      Source: offer?.source ?? null,
      Lien: a.offer.url,
      Référence: a.offer.reference,
      "Découverte le": day(offer?.discovered_at ?? null),
      "Envoyée le": day(a.sentAt),
      "Preuve d'envoi": proof ? (proof.kind === "email" ? `Mail du ${day(proof.mail_date)} : ${proof.mail_subject ?? ""}` : (proof.excerpt ?? proof.kind)) : null,
      "CV utilisé": a.cvPath,
      "Lettre utilisée": a.letterPath,
      "Prochaine action": a.nextAction,
      Échéance: a.nextActionDue,
      "Dossier ORBIT": a.folder,
      "Dossier d'origine": a.sourceFolder,
    };
  });
}

const csvCell = (v: string | number | null) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportCsv(db: Database): string {
  const rows = trackingRows(db);
  return "﻿" + [COLUMNS.join(";"), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(";"))].join("\r\n") + "\r\n";
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const fileUrl = (p: string) => `file:///${p.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:")}`;

/** A minimal Excel workbook: one sheet, bold header, frozen first row, clickable links. */
export async function exportXlsx(db: Database): Promise<Buffer> {
  const rows = trackingRows(db);
  const links: { ref: string; target: string }[] = [];
  const cell = (r: number, c: number, v: string | number | null, style = 0) => {
    const ref = `${colName(c)}${r}`;
    if (v === null || v === undefined || v === "") return `<c r="${ref}"${style ? ` s="${style}"` : ""}/>`;
    if (typeof v === "number") return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  };
  const sheetRows = [`<row r="1">${COLUMNS.map((h, c) => cell(1, c, h, 1)).join("")}</row>`];
  rows.forEach((row, i) => {
    const r = i + 2;
    sheetRows.push(
      `<row r="${r}">${COLUMNS.map((h, c) => {
        const v = row[h];
        if (typeof v === "string" && v) {
          if (h === "Lien" && /^https?:\/\//.test(v)) links.push({ ref: `${colName(c)}${r}`, target: v });
          if ((h === "Dossier ORBIT" || h === "Dossier d'origine" || h === "CV utilisé" || h === "Lettre utilisée") && /^[A-Za-z]:\\/.test(v)) links.push({ ref: `${colName(c)}${r}`, target: fileUrl(v) });
        }
        return cell(r, c, v, links.at(-1)?.ref === `${colName(c)}${r}` ? 2 : 0);
      }).join("")}</row>`,
    );
  });
  const widths = [22, 44, 20, 7, 6, 18, 14, 22, 30, 14, 12, 12, 34, 40, 40, 40, 12, 40, 40];
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${sheetRows.join("")}</sheetData>
<autoFilter ref="A1:${colName(COLUMNS.length - 1)}${rows.length + 1}"/>
${links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join("")}</hyperlinks>` : ""}
</worksheet>`;
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
  );
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Candidatures" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Candidatures!$A$1:$${colName(COLUMNS.length - 1)}$${rows.length + 1}</definedName></definedNames></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf fontId="2" applyFont="1"/></cellXfs></styleSheet>`,
  );
  zip.file("xl/worksheets/sheet1.xml", sheet);
  if (links.length) {
    zip.file(
      "xl/worksheets/_rels/sheet1.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links
        .map((l, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(l.target)}" TargetMode="External"/>`)
        .join("")}</Relationships>`,
    );
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
