/* Builds CVs and cover letters in a separate process: with the user's own CV
   generator when one is set, or else with ORBIT's built-in template
   (template.cjs). A personal generator and its folder are only read: it is
   loaded with OUTDIR pointing to a temporary folder, and every file is written
   in the output folder ORBIT gives (inside its Applications directory).

   Input on stdin (JSON):
     { cmd: "bases", generator }
     { cmd: "build", generator (or null), soffice, outDir, contact, cv?, letter? }
   Output on stdout (JSON): { ok: true, ... } or { ok: false, error }. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function load(generator) {
  if (!generator) return { base: null, docx: require("docx") };
  // Requiring the generator writes nothing, but its file output goes to a temporary folder anyway.
  process.env.OUTDIR = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-cv-"));
  const base = require(generator);
  const docx = require(require.resolve("docx", { paths: [path.dirname(generator)] }));
  return { base, docx };
}

function bases(generator) {
  const { base } = load(generator);
  return base.JOBS.map(function (j) {
    return { name: j[0].replace(/\.docx$/, ""), variant: j[2], lang: j[1].lang || null, headline: j[1].headline || "", track: j[1] };
  });
}

/* A sober one-page letter: sender, recipient, place and date, subject, body, signature. */
function letterDoc(docx, l, contact) {
  const { Document, Paragraph, TextRun, AlignmentType, convertInchesToTwip } = docx;
  const p = function (text, opts) {
    opts = opts || {};
    return new Paragraph({
      children: [new TextRun({ text: text, size: 22, font: "Calibri", bold: !!opts.bold })],
      alignment: opts.align || AlignmentType.JUSTIFIED,
      spacing: { after: opts.after === undefined ? 160 : opts.after, line: 276 }
    });
  };
  const kids = [
    p(contact.name, { bold: true, after: 0, align: AlignmentType.LEFT }),
    p(contact.city, { after: 0, align: AlignmentType.LEFT }),
    p(contact.phoneMail, { after: 240, align: AlignmentType.LEFT })
  ];
  l.destinataire.forEach(function (d, i) {
    kids.push(p(d, { after: i === l.destinataire.length - 1 ? 240 : 0, align: AlignmentType.RIGHT }));
  });
  kids.push(p(l.lieuDate, { after: 240, align: AlignmentType.RIGHT }));
  kids.push(p((l.objetLabel || "Objet : ") + l.objet, { bold: true, after: 240, align: AlignmentType.LEFT }));
  kids.push(p(l.salutation || "Madame, Monsieur,"));
  l.paragraphes.forEach(function (t) { kids.push(p(t)); });
  kids.push(p(l.formule, { after: 360 }));
  kids.push(p(contact.signature, { align: AlignmentType.RIGHT }));
  return new Document({
    sections: [{
      properties: { page: { margin: {
        top: convertInchesToTwip(0.8), bottom: convertInchesToTwip(0.8),
        left: convertInchesToTwip(0.9), right: convertInchesToTwip(0.9)
      } } },
      children: kids
    }]
  });
}

function toPdf(soffice, docxPath, outDir) {
  if (!soffice || !fs.existsSync(soffice)) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-pdf-"));
  try {
    execFileSync(soffice, ["--headless", "--convert-to", "pdf", "--outdir", tmp, docxPath], { stdio: "ignore", timeout: 120000 });
    const name = path.basename(docxPath, ".docx") + ".pdf";
    fs.copyFileSync(path.join(tmp, name), path.join(outDir, name));
    return path.join(outDir, name);
  } catch (e) {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function build(input) {
  const { base, docx } = load(input.generator);
  const files = [];
  const write = async function (name, doc) {
    const docxPath = path.join(input.outDir, name + ".docx");
    fs.writeFileSync(docxPath, await docx.Packer.toBuffer(doc));
    files.push(docxPath);
    const pdf = toPdf(input.soffice, docxPath, input.outDir);
    if (pdf) files.push(pdf);
  };
  if (input.cv && input.cv.content) {
    await write(input.cv.file, require("./template.cjs").cvDoc(docx, input.cv.content, input.contact, input.cv.lang));
  } else if (input.cv) {
    if (!base) throw new Error("Aucun générateur de CV personnel : le CV se décrit dans cv.content.");
    const job = base.JOBS.find(function (j) { return j[0].replace(/\.docx$/, "") === input.cv.base; });
    if (!job) throw new Error("Modèle de CV introuvable : " + input.cv.base);
    // On application CVs only the city, never the full address.
    base.ME.line1 = input.contact.cvLine;
    const track = Object.assign({}, job[1], input.cv.overrides || {});
    await write(input.cv.file, base.buildCV(track, input.cv.variant || job[2]));
  }
  if (input.letter) await write(input.letter.file, letterDoc(docx, input.letter, input.contact));
  return { files: files };
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (c) { raw += c; });
process.stdin.on("end", async function () {
  try {
    const input = JSON.parse(raw);
    const result = input.cmd === "bases" ? { bases: bases(input.generator) } : await build(input);
    process.stdout.write(JSON.stringify(Object.assign({ ok: true }, result)));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
});
