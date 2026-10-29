/* ORBIT's own CV layout, used when no personal CV generator is set in the
   Settings. One page, one column and standard section titles, so that the
   applicant tracking systems of recruiters read it well. Claude writes the
   whole content (cv.content), drawn from the CVs of the library and the profile. */

const NAVY = "1E3A8A";
const GREY = "595959";
const BODY = 19; // 9.5 pt
const SMALL = 17; // 8.5 pt

const LABELS = {
  fr: { profile: "PROFIL", experience: "EXPÉRIENCE PROFESSIONNELLE", education: "FORMATION", projects: "PROJETS", skills: "COMPÉTENCES", extra: "CERTIFICATIONS ET LANGUES" },
  en: { profile: "SUMMARY", experience: "PROFESSIONAL EXPERIENCE", education: "EDUCATION", projects: "PROJECTS", skills: "SKILLS", extra: "CERTIFICATIONS AND LANGUAGES" },
};

function cvDoc(docx, c, contact, lang) {
  const { Document, Paragraph, TextRun, AlignmentType, BorderStyle, LevelFormat, ExternalHyperlink, convertInchesToTwip } = docx;
  const L = LABELS[lang] || LABELS.fr;
  const run = (text, o) => new TextRun(Object.assign({ text, size: BODY, font: "Calibri" }, o || {}));
  // Words between ** ** are in bold, to bring out the keywords of the offer.
  const rich = (text, size) => String(text).split("**").filter((t, i) => t || i % 2).map((t, i) => run(t, { size: size || BODY, bold: i % 2 === 1 }));
  const kids = [];
  const title = (text) =>
    kids.push(
      new Paragraph({
        children: [run(text, { bold: true, size: 20, color: NAVY, characterSpacing: 20 })],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: NAVY, space: 1 } },
        spacing: { before: 140, after: 60 },
      }),
    );
  const line = (children, o) => kids.push(new Paragraph(Object.assign({ children, spacing: { after: 30, line: 220 } }, o || {})));

  kids.push(new Paragraph({ children: [run(contact.name, { bold: true, size: 32, color: NAVY, characterSpacing: 30 })], alignment: AlignmentType.CENTER, spacing: { after: 40 } }));
  if (c.headline) kids.push(new Paragraph({ children: [run(c.headline, { color: NAVY })], alignment: AlignmentType.CENTER, spacing: { after: 40 } }));
  kids.push(new Paragraph({ children: [run(contact.cvLine, { size: SMALL, color: GREY })], alignment: AlignmentType.CENTER, spacing: { after: c.links && c.links.length ? 15 : 60 } }));
  if (c.links && c.links.length) {
    kids.push(
      new Paragraph({
        children: c.links.flatMap((l, i) =>
          (i ? [run("  ·  ", { size: SMALL, color: GREY })] : []).concat(new ExternalHyperlink({ link: l.url, children: [run(l.label || l.url, { size: SMALL, color: NAVY })] })),
        ),
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 },
      }),
    );
  }

  if (c.profile) {
    title(L.profile);
    line(rich(c.profile), { alignment: AlignmentType.JUSTIFIED });
  }
  const roleLine = (left, right) =>
    line([run(left, { bold: true }), run("\t" + (right || ""), { size: SMALL, color: GREY })], { tabStops: [{ type: "right", position: 10200 }], spacing: { before: 80, after: 0 } });
  const subLine = (text) => text && line([run(text, { italics: true, size: SMALL, color: GREY })], { spacing: { after: 30 } });
  const bullets = (list) =>
    (list || []).forEach((b) => kids.push(new Paragraph({ numbering: { reference: "dots", level: 0 }, children: rich(b), alignment: AlignmentType.JUSTIFIED, spacing: { after: 20, line: 215 } })));

  if (c.experiences && c.experiences.length) {
    title(L.experience);
    c.experiences.forEach((e) => {
      roleLine(e.role, e.date);
      subLine(e.org);
      bullets(e.bullets);
    });
  }
  if (c.education && c.education.length) {
    title(L.education);
    c.education.forEach((e) => {
      roleLine(e.degree, e.date);
      subLine(e.school);
      if (e.details) line(rich(e.details, SMALL));
    });
  }
  if (c.projects && c.projects.length) {
    title(L.projects);
    c.projects.forEach((p) => line([run(p.title + " : ", { bold: true })].concat(rich(p.text)), { alignment: AlignmentType.JUSTIFIED }));
  }
  if (c.skills && c.skills.length) {
    title(L.skills);
    c.skills.forEach((s) => line([run(s.label + " : ", { bold: true })].concat(rich(s.value))));
  }
  if ((c.certifications && c.certifications.length) || c.languages) {
    title(L.extra);
    if (c.certifications && c.certifications.length) line(rich(c.certifications.join("  ·  ")));
    if (c.languages) line(rich(c.languages));
  }

  return new Document({
    numbering: {
      config: [
        {
          reference: "dots",
          levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 300, hanging: 180 } } } }],
        },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: convertInchesToTwip(0.5), bottom: convertInchesToTwip(0.5), left: convertInchesToTwip(0.6), right: convertInchesToTwip(0.6) } } },
        children: kids,
      },
    ],
  });
}

module.exports = { cvDoc };
