// Acceptance tests of the master spec, run on a complete ORBIT with a
// simulated Claude, a simulated Gmail and simulated web pages: nothing leaves the computer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { KPI_KEYS, type RunnerStatus, type ApplicationDetail, type Dashboard, type JobsPerformance, type KpiDetails, type Offer, type StreamEvent } from "../shared/types";
import { createApp, type AppHandle } from "../server/app";
import { ClaudeError, connectorPrefix, parseConnectorList, type ClaudeRunner, type RunRequest } from "../server/ai/claude";
import { buildPrompt, SYSTEM_PROMPT } from "../server/ai/prompt";
import { executeTool, type RunContext } from "../server/ai/tools";
import { loadConfig } from "../server/config";
import { noProtection } from "../server/mail/dpapi";
import { MailError, type MailReader, type RawMail } from "../server/mail/imap";
import { loadSettings, saveSettings } from "../server/services/settings";

const ROOT = path.resolve(__dirname, "..");

type Script = (call: (name: string, input: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>, req: RunRequest) => Promise<string>;

/** Stands in for Claude: drives the real tools of the run, like the MCP bridge does. */
class FakeClaude implements ClaudeRunner {
  script: Script = async () => "ok";
  getRun: (token: string) => RunContext | undefined = () => undefined;
  prompts: RunRequest[] = [];
  async status(): Promise<RunnerStatus> {
    return { state: "ready", message: "ok", plan: "pro", version: "test" };
  }
  async run(req: RunRequest) {
    this.prompts.push(req);
    const rc = this.getRun(req.token)!;
    const text = await this.script((name, input) => executeTool(rc, name, input), req);
    return { text, model: "claude-test" };
  }
}

const mail = (over: Partial<RawMail> & { id: string; subject: string; text: string }): RawMail => ({
  threadId: over.id.replace(/\D/g, "") || "1",
  date: new Date("2026-10-20T09:00:00Z"),
  from: { name: "Wavestone Recrutement", address: "noreply@smartrecruiters.com" },
  html: null,
  attachments: [],
  ...over,
});

class FakeGmail implements MailReader {
  static mails: RawMail[] = [];
  static down = false;
  constructor(private readonly password: string) {}
  async verify() {
    if (this.password !== "abcdefghijklmnop") throw new MailError("auth", "Gmail refuse ce mot de passe d'application.");
  }
  async search() {
    if (FakeGmail.down) throw new MailError("network", "Gmail est injoignable.");
    return FakeGmail.mails.map((m) => m.id);
  }
  async read(ids: string[]) {
    return FakeGmail.mails.filter((m) => ids.includes(m.id));
  }
}

const POSTING = `<html><head><title>Stage SOC</title><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Stage Analyste SOC et détection F/H",
  hiringOrganization: { "@type": "Organization", name: "Thales" },
  jobLocation: { "@type": "Place", address: { addressLocality: "Vélizy", postalCode: "78140", addressCountry: "FR" } },
  employmentType: "INTERN",
  identifier: { "@type": "PropertyValue", value: "R0251234" },
  description: `<p>${"Vous rejoignez le SOC. Analyse d'alertes SIEM, Splunk, détection, MITRE ATT&CK. ".repeat(8)}</p>`,
})}</script></head><body>...</body></html>`;

const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("thales")) return new Response(POSTING, { status: 200, headers: { "content-type": "text/html" } });
  if (url.includes("blocked")) return new Response("Access denied", { status: 403 });
  return new Response("<html><body><div id=app></div></body></html>", { status: 200 });
};

const handles: AppHandle[] = [];
const dirs: string[] = [];

/** A complete app on a temporary folder, with two document folders that must never change. */
async function boot(dataDir?: string) {
  const base = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "orbit-"));
  if (!dataDir) dirs.push(base);
  const docs = path.join(base, "docs");
  const folder = path.join(docs, "Stage_IA_Cybersecurite_Wavestone");
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(path.join(docs, "TOUS_LES_CV"), { recursive: true });
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      "<w:document><w:body><w:p><w:t>Camille MARTIN</w:t></w:p><w:p><w:t>FORMATION École d'ingénieurs</w:t></w:p><w:p><w:t>EXPÉRIENCE Acme Telecom SOC Wazuh Sysmon Python</w:t></w:p><w:p><w:t>COMPÉTENCES SIEM Splunk MITRE</w:t></w:p></w:body></w:document>",
    );
    fs.writeFileSync(path.join(docs, "TOUS_LES_CV", "CV_Martin_Detection_SOC_Stage_FR.docx"), await zip.generateAsync({ type: "nodebuffer" }));
    fs.writeFileSync(
      path.join(folder, "OFFRE.md"),
      "# Wavestone — Stage Intelligence artificielle & Cybersécurité\n\n## Score de compatibilité : 86 / 100 → postuler en priorité\n\n## Texte de l'offre\n\nUn stage en IA et cybersécurité, avec IA générative et sécurité des agents.\n",
    );
    fs.writeFileSync(path.join(folder, "LM_Martin_Wavestone_IA_Stage_FR.docx"), await zip.generateAsync({ type: "nodebuffer" }));
    fs.writeFileSync(
      path.join(docs, "SUIVI_CANDIDATURES.csv"),
      "﻿Date ajout;Entreprise;Poste;Type;Lieu;Lien;Score;Dossier;Date envoi;Statut;Prochaine action\n17/10/2026;Wavestone;Stage - Intelligence artificielle & Cybersécurité;Stage fin d'études;Paris;;86;Stage_IA_Cybersecurite_Wavestone;;À envoyer;Envoyer le .docx\n",
    );
  }
  const claude = new FakeClaude();
  const h = await createApp({
    config: { ...loadConfig(), dataDir: path.join(base, "data"), applicationsDir: path.join(base, "Applications"), webDir: path.join(base, "no-web") },
    claude,
    secretsFile: path.join(base, "data", "secrets.json"),
    protector: noProtection,
    mailReader: (a) => new FakeGmail(a.password),
    fetch: fakeFetch,
  });
  claude.getRun = (t) => h.agent.getRun(t);
  saveSettings(h.db, {
    documentRoots: [docs],
    trackingFiles: [path.join(docs, "SUIVI_CANDIDATURES.csv")],
    mailLookbackDays: 30,
    contact: { name: "Camille MARTIN", phone: "+33 6 00 00 00 00", email: "camille.martin@example.com", city: "Lyon, France", signature: "Camille Martin" },
  });
  handles.push(h);
  return { h, claude, base, docs };
}

const api = async (h: AppHandle, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const r = await h.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: r.statusCode, json: () => r.json(), body: r.body, raw: r.rawPayload };
};

const chat = (h: AppHandle, message: string, mode: "A" | "B" | "C") => chatWith(h, { message, mode });

const chatWith = async (h: AppHandle, body: { message: string; mode?: "auto" | "A" | "B" | "C"; model?: "haiku" | "sonnet" | "opus"; task?: "discovery" }) => {
  const r = await api(h, "POST", "/api/ai/chat", body);
  return r.body
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as StreamEvent);
};

afterEach(async () => {
  FakeGmail.mails = [];
  FakeGmail.down = false;
  for (const h of handles.splice(0)) {
    await h.app.close();
    h.db.close();
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("offers", () => {
  it("1. imports an offer from a simple link, and asks for the text when the site refuses", async () => {
    const { h } = await boot();
    const r = (await api(h, "POST", "/api/offers/from-url", { url: "https://careers.thales.com/fr/job/R0251234?utm_source=x" })).json();
    expect(r.status).toBe("created");
    expect(r.offer).toMatchObject({ company: "Thales", title: "Stage Analyste SOC et détection F/H", contract: "Stage", reference: "R0251234", location: "Vélizy (78140)" });
    expect(r.offer.missing).toContain("date de début");
    expect((await api(h, "POST", "/api/offers/from-url", { url: "https://www.linkedin.com/jobs/view/123" })).json()).toMatchObject({ status: "needs_text" });
    expect((await api(h, "POST", "/api/offers/from-url", { url: "https://blocked.example.com/job" })).json()).toMatchObject({ status: "needs_text" });
    expect((await api(h, "POST", "/api/offers/from-url", { url: "https://spa.example.com/job" })).json().message).toContain("JavaScript");
  });

  it("2. creates an offer and its analysis from a pasted description (mode B), separating facts", async () => {
    const { h, claude } = await boot();
    claude.script = async (call) => {
      const o = await call("create_offer", { company: "BNP Paribas", title: "Stage Augmented Cybersecurity Analyst", source: "texte collé", description: "Stage de 6 mois. ".repeat(30) });
      const offerId = (o.result as { id: string }).id;
      expect(
        (
          await call("save_analysis", {
            offerId,
            score: 82,
            breakdown: { skills: 38, education: 18, experience: 26 },
            verdict: "apply",
            practical: [{ label: "Nationalité française exigée (habilitation Défense)", severity: "blocking" }],
            facts: { verified: ["SOC chez Acme Telecom (CV)"], inferred: [], missing: ["Durée exacte"] },
          })
        ).ok,
      ).toBe(true);
      return "Offre créée et analysée.";
    };
    const events = await chat(h, "Voici la description copiée de l'offre : ...", "B");
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const offers = (await api(h, "GET", "/api/offers?status=all")).json() as Offer[];
    const bnp = offers.find((o) => o.company === "BNP Paribas")!;
    expect(bnp.analysis).toMatchObject({ score: 82, by: "claude", practical: [{ severity: "blocking" }], facts: { verified: ["SOC chez Acme Telecom (CV)"] } });
  });

  it("4. recognizes duplicates by link, and keeps the new source", async () => {
    const { h } = await boot();
    await api(h, "POST", "/api/offers/from-url", { url: "https://careers.thales.com/fr/job/R0251234" });
    const again = (await api(h, "POST", "/api/offers/from-url", { url: "https://careers.thales.com/fr/job/R0251234?utm_campaign=y" })).json();
    expect(again.status).toBe("known");
    expect((await api(h, "GET", "/api/offers?status=all")).json()).toHaveLength(1);
  });
});

describe("documents and folders", () => {
  it("5. indexes both folders read only and imports the tracking file", async () => {
    const { h, docs } = await boot();
    const before = fs.readdirSync(docs, { recursive: true }).map((f) => {
      const p = path.join(docs, String(f));
      return fs.statSync(p).isFile() ? `${f}:${fs.statSync(p).mtimeMs}:${fs.readFileSync(p).toString("base64").length}` : String(f);
    });
    const idx = (await api(h, "POST", "/api/documents/reindex")).json();
    expect(idx.indexed).toBe(4);
    const list = (await api(h, "GET", "/api/documents")).json() as { name: string; kind: string; status: string; signals: string[] }[];
    expect(list.find((d) => d.name.startsWith("CV_"))).toMatchObject({ kind: "cv", status: "master" });
    expect(list.find((d) => d.name.startsWith("LM_"))).toMatchObject({ kind: "letter", status: "adapted" });
    const imported = (await api(h, "POST", "/api/import")).json();
    expect(imported[0]).toMatchObject({ offersCreated: 1, applicationsCreated: 1 });
    const after = fs.readdirSync(docs, { recursive: true }).map((f) => {
      const p = path.join(docs, String(f));
      return fs.statSync(p).isFile() ? `${f}:${fs.statSync(p).mtimeMs}:${fs.readFileSync(p).toString("base64").length}` : String(f);
    });
    expect(after).toEqual(before);
  });

  it("8. writes a complete, coherent folder for an application, only in ORBIT's directory", async () => {
    const { h, base } = await boot();
    const offer = (await api(h, "POST", "/api/offers/from-url", { url: "https://careers.thales.com/fr/job/R0251234" })).json().offer as Offer;
    const app = (await api(h, "POST", `/api/offers/${offer.id}/application`, {})).json();
    const r = (await api(h, "POST", `/api/applications/${app.id}/folder`)).json();
    expect(r.folder.startsWith(path.join(base, "Applications"))).toBe(true);
    expect(r.written).toEqual(["OFFRE.md", "SUIVI.md", "SOURCES.md"]);
    expect(fs.readFileSync(path.join(r.folder, "OFFRE.md"), "utf8")).toContain("| Référence | R0251234 |");
    expect(fs.readFileSync(path.join(r.folder, "SUIVI.md"), "utf8")).toContain("Statut : **Préparée**");
  });
});

describe("tracking", () => {
  it("9 and 12. keeps statuses after a restart, and never takes a prepared application for a sent one", async () => {
    const { h, base, claude } = await boot();
    const offer = (await api(h, "POST", "/api/offers/from-url", { url: "https://careers.thales.com/fr/job/R0251234" })).json().offer as Offer;
    const app = (await api(h, "POST", `/api/offers/${offer.id}/application`, {})).json();
    claude.script = async (call) => {
      await call("write_folder", { applicationId: app.id });
      const r = await call("propose_status", { applicationId: app.id, status: "sent", reason: "Le dossier est prêt" });
      expect(r.ok).toBe(true);
      return "Dossier prêt, statut proposé.";
    };
    await chat(h, "Prépare le dossier", "C");
    let detail = (await api(h, "GET", `/api/applications/${app.id}`)).json() as ApplicationDetail;
    expect(detail.status).toBe("prepared");
    expect(detail.evidence[0]).toMatchObject({ kind: "agent", confirmed: false, suggests: "sent" });
    // The user declares it sent.
    await api(h, "POST", `/api/applications/${app.id}/status`, { status: "sent" });
    await h.app.close();
    h.db.close();
    handles.splice(handles.indexOf(h), 1);
    const again = await boot(base);
    detail = (await api(again.h, "GET", `/api/applications/${app.id}`)).json() as ApplicationDetail;
    expect(detail.status).toBe("sent");
    expect(detail.history.some((e) => e.summary.includes("déclaré par vous"))).toBe(true);
  });

  it("10. follows the mode chosen for each request: A prepares, B applies", async () => {
    const { h, claude } = await boot();
    claude.script = async (call) => {
      const o = await call("create_offer", { company: "Deloitte", title: "Stage Stratégie IT", source: "texte collé", description: "Mission. ".repeat(40) });
      const ref = (o.result as { ref?: string; id?: string }).ref ?? (o.result as { id: string }).id;
      await call("save_analysis", { offerId: ref, score: 70, breakdown: { skills: 30, education: 18, experience: 22 }, verdict: "apply", facts: { verified: [], inferred: [], missing: [] } });
      return "Préparé.";
    };
    const a = await chat(h, "Crée la fiche, mode A", "A");
    const done = a.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.proposal?.ops.map((o) => o.tool)).toEqual(["create_offer", "save_analysis"]);
    expect((await api(h, "GET", "/api/offers?status=all")).json()).toHaveLength(0);
    expect((await api(h, "POST", `/api/proposals/${done.proposal!.id}/apply`)).json().applied).toHaveLength(2);
    const offers = (await api(h, "GET", "/api/offers?status=all")).json() as Offer[];
    expect(offers[0]).toMatchObject({ company: "Deloitte", score: 70 });
    expect((await api(h, "POST", `/api/proposals/${done.proposal!.id}/apply`)).status).toBe(409);

    claude.script = async (call) => {
      await call("create_offer", { company: "EY", title: "Consultant GRC", source: "texte collé" });
      return "Fait.";
    };
    const b = await chat(h, "Pour celle-ci, mode B", "B");
    expect((b.at(-1) as Extract<StreamEvent, { type: "done" }>).proposal).toBeNull();
    expect((await api(h, "GET", "/api/offers?status=all")).json()).toHaveLength(2);
  });

  it("11. keeps an external action blocked until the user validates that one action", async () => {
    const { h, claude } = await boot();
    const offer = (await api(h, "POST", "/api/offers/from-url", { url: "https://careers.thales.com/fr/job/R0251234" })).json().offer as Offer;
    const app = (await api(h, "POST", `/api/offers/${offer.id}/application`, {})).json();
    claude.script = async (call) => {
      await call("request_external_action", {
        applicationId: app.id,
        kind: "Envoi de candidature",
        description: "Déposer CV_Martin_Thales.pdf sur careers.thales.com pour le poste R0251234, avec nom, téléphone et e-mail.",
        target: "careers.thales.com",
      });
      return "Action demandée.";
    };
    await chat(h, "Envoie la candidature", "C");
    const pending = ((await api(h, "GET", "/api/dashboard")).json() as Dashboard).pendingActions;
    expect(pending).toHaveLength(1);
    expect((await api(h, "POST", `/api/actions/${pending[0]!.id}`, { decision: "done" })).status).toBe(409);
    expect((await api(h, "POST", `/api/actions/${pending[0]!.id}`, { decision: "approved" })).json().status).toBe("approved");
    // There is no tool that sends, submits or deletes.
    const names = (await import("../server/ai/tools")).toolDefinitions().map((t) => t.name);
    expect(names.filter((n) => /send|submit|delete|remove|apply_to/.test(n))).toEqual([]);
  });
});

describe("Gmail", () => {
  it("13 and 14. reads Gmail without writing, ties tests and answers to evidence, and waits for confirmation", async () => {
    const { h, base } = await boot();
    await api(h, "POST", "/api/import");
    expect((await api(h, "POST", "/api/gmail/connect", { email: "camille.martin@gmail.com", password: "zzzz zzzz zzzz zzzz" })).status).toBe(400);
    expect((await api(h, "POST", "/api/gmail/connect", { email: "camille.martin@gmail.com", password: "abcd efgh ijkl mnop" })).status).toBe(200);
    FakeGmail.mails = [
      mail({ id: "1001", subject: "Wavestone : nous avons bien reçu votre candidature", text: "Merci, nous avons bien reçu votre candidature au stage Intelligence artificielle & Cybersécurité." }),
      mail({
        id: "1002",
        subject: "Wavestone - Test AssessFirst",
        text: "Merci de compléter le test AssessFirst avant le 05/11/2026 pour le stage Intelligence artificielle.",
        date: new Date("2026-10-22T09:00:00Z"),
      }),
      mail({ id: "1003", subject: "Newsletter cyber", text: "Les actus de la semaine", from: { name: "Blog", address: "news@blog.example" } }),
    ];
    const sync = (await api(h, "POST", "/api/gmail/sync")).json();
    expect(sync).toMatchObject({ newMails: 3, matched: 2, proposals: 2 });
    let dash = (await api(h, "GET", "/api/dashboard")).json() as Dashboard;
    expect(dash.confirmations.map((c) => c.evidence.suggests).sort()).toEqual(["received", "test_todo"]);
    const appId = dash.confirmations[0]!.application.id;
    expect(((await api(h, "GET", `/api/applications/${appId}`)).json() as ApplicationDetail).status).toBe("prepared");
    for (const c of dash.confirmations.sort((a, b) => (a.evidence.mailDate ?? "").localeCompare(b.evidence.mailDate ?? ""))) await api(h, "POST", `/api/evidence/${c.evidence.id}/confirm`, {});
    const detail = (await api(h, "GET", `/api/applications/${appId}`)).json() as ApplicationDetail;
    expect(detail.status).toBe("test_todo");
    expect(detail.sentAt).toBe("2026-10-20T09:00:00.000Z");
    expect(detail.deadlines[0]).toMatchObject({ kind: "test", dueAt: "2026-11-05", status: "todo" });
    expect(detail.deadlines[0]!.evidenceId).toBeTruthy();
    // A second reading proposes nothing new.
    expect((await api(h, "POST", "/api/gmail/sync")).json()).toMatchObject({ newMails: 0, proposals: 0 });
    dash = (await api(h, "GET", "/api/dashboard")).json() as Dashboard;
    expect(dash.counts.tests).toBeGreaterThan(0);
    // The password is stored protected, never in plain text, in the database or in the logs.
    const secrets = fs.readFileSync(path.join(base, "data", "secrets.json"), "utf8");
    expect(secrets).not.toContain("abcdefghijklmnop");
    expect(fs.readFileSync(path.join(base, "data", "orbit.db")).toString("latin1")).not.toContain("abcdefghijklmnop");
  });

  it("recognizes a finished test in English, also in an email read before the rule existed", async () => {
    const { h } = await boot();
    await api(h, "POST", "/api/import");
    await api(h, "POST", "/api/gmail/connect", { email: "camille.martin@gmail.com", password: "abcdefghijklmnop" });
    const appId = ((await api(h, "GET", "/api/applications")).json() as { id: string }[])[0]!.id;
    await api(h, "POST", `/api/applications/${appId}/deadlines`, { kind: "test", title: "Test Maki", dueAt: "2026-11-07" });
    // Read earlier and filed as "other", as the rules used to do.
    h.db.run(
      "INSERT INTO mails (id, thread_id, date, from_name, from_address, subject, snippet, category, application_id, link, synced_at) VALUES ('2001', '2001', '2026-10-29T01:53:01.000Z', 'Maki Assessments Team', 'contact@makipeople.com', 'Your assessment results', 'Your assessment results are ready!', 'other', ?, NULL, ?)",
      appId,
      new Date().toISOString(),
    );
    FakeGmail.mails = [
      mail({
        id: "2002",
        subject: "Assessment received - Wavestone",
        text: "Your assessment has been successfully submitted.",
        from: { name: "Maki Assessments Team", address: "contact@makipeople.com" },
      }),
      mail({
        id: "2003",
        subject: "Votre évaluation Wavestone",
        text: "Bienvenue dans votre évaluation pour le stage Intelligence artificielle.",
        from: { name: "Maki Assessments Team", address: "contact@makipeople.com" },
      }),
    ];
    // The second "test done" email joins the first proposal instead of making a second one.
    expect((await api(h, "POST", "/api/gmail/sync")).json()).toMatchObject({ newMails: 2, proposals: 2 });
    const mails = (await api(h, "GET", "/api/mails")).json() as { id: string; category: string }[];
    expect(Object.fromEntries(mails.map((m) => [m.id, m.category]))).toEqual({ "2001": "test_done", "2002": "test_done", "2003": "test" });
    const dash = (await api(h, "GET", "/api/dashboard")).json() as Dashboard;
    const done = dash.confirmations.find((c) => c.evidence.messageId === "2001")!;
    expect(done.evidence.suggests).toBe("test_done");
    await api(h, "POST", `/api/evidence/${done.evidence.id}/confirm`, {});
    const detail = (await api(h, "GET", `/api/applications/${appId}`)).json() as ApplicationDetail;
    expect(detail.status).toBe("test_done");
    expect(detail.deadlines.find((d) => d.title === "Test Maki")?.status).toBe("done");
    // Reading again proposes nothing twice.
    expect((await api(h, "POST", "/api/gmail/sync")).json()).toMatchObject({ newMails: 0, proposals: 0 });
  });

  it("turns job alerts into offers, keeps only clean links and leaves out jobs outside the search", async () => {
    const { h, base } = await boot();
    saveSettings(h.db, {
      alertKeywords: ["cyber", "sécurité", "security", "soc", "siem", "grc", "risque", "audit", "cloud", "ia", "ai", "data", "si", "it", "réseau", "network"],
      alertExclude: ["alternance", "alternant", "apprenti", "apprentissage", "contrat pro", "professionnalisation"],
    });
    await api(h, "POST", "/api/gmail/connect", { email: "camille.martin@gmail.com", password: "abcdefghijklmnop" });
    const tokens = "?trackingId=abc&refId=def&midToken=SECRET1&trk=eml&trkEmail=x&eid=y&otpToken=SECRETOTP";
    const linkedin = [
      "Votre alerte Emploi pour Cybersécurité (Ville de Paris)",
      `Gérer les alertes : https://www.linkedin.com/comm/jobs/alerts${tokens}`,
      "",
      "Ingénieur Sécurité Cloud - F/H",
      "Groupe ADP",
      "Paris",
      "",
      "1 ancien collègue",
      `Voir l’offre d’emploi : https://www.linkedin.com/comm/jobs/view/4456264211/${tokens}`,
      "",
      "---------------------------------------------------------",
      "",
      "Chargé de clientèle en alternance - Cybersécurité",
      "Banque X",
      "Paris",
      "",
      `Voir l’offre d’emploi : https://www.linkedin.com/comm/jobs/view/4481432111/${tokens}`,
      "",
      "---------------------------------------------------------",
      "",
      "Chef de rang",
      "Restaurant Y",
      "Paris",
      "",
      "Postulez avec un CV et un profil",
      `Voir l’offre d’emploi : https://www.linkedin.com/comm/jobs/view/4437972922/${tokens}`,
    ].join("\n");
    const indeed = [
      "Indeed Job Alert",
      "See matching results on Indeed: https://fr.indeed.com/jobs?q=cyber&alid=SECRET",
      "",
      "Stage - Consultant(e) GRC",
      "Sopra Steria - Courbevoie (92)",
      "Candidature simplifiée",
      "Accompagner des clients sur leur conformité ISO 27001.",
      "il y a 2 jours",
      "https://fr.indeed.com/rc/clk/dl?jk=888c39295c2a5128&from=ja&tk=SECRETTK&alid=SECRET",
    ].join("\n");
    FakeGmail.mails = [
      mail({ id: "3001", subject: "3 nouvelles offres d’emploi pour “Cybersécurité”", text: linkedin, from: { name: "LinkedIn Job Alerts", address: "jobalerts-noreply@linkedin.com" } }),
      mail({ id: "3002", subject: "Stage - Consultant(e) GRC à Sopra Steria", text: indeed, from: { name: "Indeed", address: "donotreply@jobalert.indeed.com" } }),
    ];
    // The Indeed alert was read once before alerts were understood.
    h.db.run(
      "INSERT INTO mails (id, thread_id, date, from_name, from_address, subject, snippet, category, application_id, link, synced_at) VALUES ('3002', '3002', '2026-10-20T09:00:00.000Z', 'Indeed', 'donotreply@jobalert.indeed.com', 'Stage - Consultant(e) GRC à Sopra Steria', 'x', 'other', NULL, NULL, ?)",
      new Date().toISOString(),
    );
    const sync = (await api(h, "POST", "/api/gmail/sync")).json();
    expect(sync).toMatchObject({ alertOffers: 2, alertKnown: 0, alertSkipped: 2 });
    const offers = (await api(h, "GET", "/api/offers?status=all")).json() as Offer[];
    expect(offers.map((o) => [o.company, o.title, o.source, o.url]).sort()).toEqual([
      ["Groupe ADP", "Ingénieur Sécurité Cloud - F/H", "alerte LinkedIn", "https://www.linkedin.com/jobs/view/4456264211/"],
      ["Sopra Steria", "Stage - Consultant(e) GRC", "alerte Indeed", "https://fr.indeed.com/viewjob?jk=888c39295c2a5128"],
    ]);
    expect(offers.find((o) => o.company === "Sopra Steria")).toMatchObject({ location: "Courbevoie (92)", description: expect.stringContaining("ISO 27001") });
    // No token from the email links is kept anywhere.
    for (const f of ["orbit.db", "orbit.db-wal"].map((n) => path.join(base, "data", n)).filter((p) => fs.existsSync(p))) expect(fs.readFileSync(f).toString("latin1")).not.toMatch(/SECRET/);
    const mails = (await api(h, "GET", "/api/mails")).json() as { id: string; category: string }[];
    expect(mails.filter((m) => m.id.startsWith("300")).map((m) => m.category)).toEqual(["alert", "alert"]);
    expect(((await api(h, "GET", "/api/mails?unassigned=1")).json() as unknown[]).length).toBe(0);
    // Reading again changes nothing.
    expect((await api(h, "POST", "/api/gmail/sync")).json()).toMatchObject({ newMails: 0, alertOffers: 0, alertKnown: 0 });
  });

  it("13. contains no command that could change, move, delete or send an email", () => {
    const code = fs.readFileSync(path.join(ROOT, "server", "mail", "imap.ts"), "utf8");
    for (const forbidden of [
      "messageFlagsAdd",
      "messageFlagsRemove",
      "messageFlagsSet",
      "messageMove",
      "messageCopy",
      "messageDelete",
      "append(",
      "mailboxCreate",
      "smtp",
      "nodemailer",
      "readOnly: false",
    ]) {
      expect(code.includes(forbidden), forbidden).toBe(false);
    }
    expect(code).toContain("readOnly: true");
  });
});

describe("dashboard details", () => {
  it("lists exactly what each number counts, and counts a test only once", async () => {
    const { h } = await boot();
    await api(h, "POST", "/api/import");
    const thales = (await api(h, "POST", "/api/offers/from-url", { url: "https://careers.thales.com/fr/job/R0251234" })).json().offer as Offer;
    const app = (await api(h, "POST", `/api/offers/${thales.id}/application`, {})).json();
    await api(h, "POST", `/api/applications/${app.id}/status`, { status: "test_todo" });
    await api(h, "POST", `/api/applications/${app.id}/deadlines`, { kind: "test", title: "Test en ligne", dueAt: "2026-11-05" });

    const dash = (await api(h, "GET", "/api/dashboard")).json() as Dashboard;
    for (const key of KPI_KEYS) {
      const d = (await api(h, "GET", `/api/dashboard/${key}`)).json() as KpiDetails;
      expect(d.items.length, key).toBe(dash.counts[key]);
      expect(d.rule.length, key).toBeGreaterThan(20);
    }
    const tests = (await api(h, "GET", "/api/dashboard/tests")).json() as KpiDetails;
    expect(tests.items).toEqual([expect.objectContaining({ type: "application", id: app.id, company: "Thales", status: "test_todo", date: "2026-11-05", dateKind: "due", detail: "Test en ligne" })]);
    const active = (await api(h, "GET", "/api/dashboard/active")).json() as KpiDetails;
    expect(active.breakdown.map((b) => b.status).sort()).toEqual(["prepared", "test_todo"]);
    expect((await api(h, "GET", "/api/dashboard/unknown")).status).toBe(400);
  });
});

// A personal CV generator to test against, and one of its models (optional: the test is skipped without them).
const GENERATOR = process.env.ORBIT_TEST_CV_GENERATOR ?? "";
const BASE = process.env.ORBIT_TEST_CV_BASE ?? "";

/** Name, size and date of every file of a folder (dependencies left out). */
function snapshot(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => !f.split(path.sep).includes("node_modules"))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return st.isFile() ? `${f}:${st.size}:${st.mtimeMs}` : f;
    })
    .sort();
}

describe("CV and cover letter", () => {
  it.skipIf(!GENERATOR || !BASE || !fs.existsSync(GENERATOR))(
    "makes an adapted CV and letter with the user's own generator, never touching its folder or replacing a file",
    async () => {
      const { h, claude, base } = await boot();
      saveSettings(h.db, { cvGenerator: GENERATOR });
      const cvDir = path.dirname(path.dirname(GENERATOR));
      const before = snapshot(cvDir);
      await api(h, "POST", "/api/import");
      const app = ((await api(h, "GET", "/api/applications")).json() as { id: string }[])[0]!;
      const letter = {
        destinataire: ["Wavestone"],
        lieuDate: "Paris, le 29 octobre 2026",
        objet: "Candidature au stage IA et Cybersécurité",
        paragraphes: ["Ce qui m'amène vers Wavestone tient à la façon dont vous reliez métier et technique.", "Je serais heureux d'en parler avec vous lors d'un entretien."],
        formule: "Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.",
      };
      claude.script = async (call) => {
        expect(((await call("get_writing_rules", {})).result as { rules: string }).rules).toContain("Lettre");
        const list = (await call("list_cv_bases", {})).result as { template: string; bases: { name: string }[] };
        expect(list.template).toBe("generator");
        expect(list.bases.map((b) => b.name)).toContain(BASE);
        expect(((await call("get_cv_base", { name: BASE })).result as { track: { experiences: unknown[] } }).track.experiences.length).toBeGreaterThan(1);
        const input = { applicationId: app.id, company: "Wavestone", offerTitle: "Stage IA et Cybersécurité", language: "fr", fileTag: "Wavestone_IA_Cyber_Stage" };
        expect((await call("generate_documents", { ...input, letter: { ...letter, paragraphes: ["Un tiret — cadratin, contraire aux règles de rédaction."] } })).ok).toBe(false);
        expect((await call("generate_documents", { ...input, cv: { base: BASE, overrides: { photo: "x" } } })).ok).toBe(false);
        const made = await call("generate_documents", { ...input, cv: { base: BASE, overrides: { headline: "Stage de fin d'études  ·  IA et Cybersécurité" } }, letter });
        expect(made.ok).toBe(true);
        expect((await call("generate_documents", { ...input, cv: { base: BASE, overrides: {} } })).ok).toBe(true);
        return "Documents prêts.";
      };
      // Drafts are made in mode A too: they are new files in ORBIT's folder and change no tracking data.
      const done = (await chat(h, "Prépare un CV et une lettre", "A")).at(-1) as Extract<StreamEvent, { type: "done" }>;
      expect(done.proposal).toBeNull();
      const names = (done.message.meta.files ?? []).map((f) => f.name);
      expect(names).toEqual(expect.arrayContaining(["CV_Martin_Wavestone_IA_Cyber_Stage_FR.docx", "LM_Martin_Wavestone_IA_Cyber_Stage_FR.docx", "CV_Martin_Wavestone_IA_Cyber_Stage_FR_v2.docx"]));
      const appsDir = path.join(base, "Applications");
      for (const f of done.message.meta.files ?? []) expect(f.path.startsWith(appsDir + path.sep)).toBe(true);

      const detail = (await api(h, "GET", `/api/applications/${app.id}`)).json() as ApplicationDetail;
      expect(detail.files!.length).toBe(names.length);
      const docx = done.message.meta.files!.find((f) => f.name.endsWith(".docx"))!;
      const dl = await h.app.inject({ method: "GET", url: `/api/files/download?path=${encodeURIComponent(docx.path)}` });
      expect(dl.statusCode).toBe(200);
      expect(dl.rawPayload.subarray(0, 2).toString()).toBe("PK");
      expect((await h.app.inject({ method: "GET", url: `/api/files/download?path=${encodeURIComponent(GENERATOR)}` })).statusCode).toBe(403);
      expect(snapshot(cvDir)).toEqual(before);
    },
    240_000,
  );

  it("makes a CV and a letter with the built-in template when no personal generator is set", async () => {
    const { h, claude, base } = await boot();
    await api(h, "POST", "/api/import");
    const app = ((await api(h, "GET", "/api/applications")).json() as { id: string }[])[0]!;
    const content = {
      headline: "Analyste SOC  ·  Stage de fin d'études",
      profile: "Élève ingénieur en cybersécurité, avec un projet de détection en **SOC** et une pratique de **Splunk**.",
      experiences: [
        {
          role: "Analyste SOC (stage)",
          org: "Acme Telecom, Lyon",
          date: "Février à juillet 2026",
          bullets: ["Analyse et tri des alertes **SIEM**.", "Règles de détection alignées sur **MITRE ATT&CK**."],
        },
      ],
      education: [{ degree: "Diplôme d'ingénieur", school: "École d'ingénieurs", date: "2023 à 2026" }],
      skills: [{ label: "Détection", value: "Splunk, Sysmon, Wazuh, Python" }],
      languages: "Français (langue maternelle)  ·  Anglais (C1)",
    };
    claude.script = async (call) => {
      expect(((await call("list_cv_bases", {})).result as { template: string }).template).toBe("builtin");
      const input = { applicationId: app.id, company: "Wavestone", offerTitle: "Stage SOC", language: "fr", fileTag: "Wavestone_SOC" };
      expect((await call("generate_documents", { ...input, cv: { base: "Un_modele", overrides: {} } })).error).toContain("cv.content");
      expect((await call("generate_documents", { ...input, cv: { content: { ...content, experiences: [] }, base: "Un_modele" } })).ok).toBe(false);
      const made = await call("generate_documents", {
        ...input,
        cv: { content },
        letter: {
          destinataire: ["Wavestone"],
          lieuDate: "Lyon, le 29 octobre 2026",
          objet: "Candidature au stage SOC",
          paragraphes: ["Votre façon de relier la détection et le conseil m'amène vers Wavestone."],
          formule: "Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.",
        },
      });
      expect(made.ok).toBe(true);
      return "Documents prêts.";
    };
    const done = (await chat(h, "Prépare un CV et une lettre", "B")).at(-1) as Extract<StreamEvent, { type: "done" }>;
    const docs = (done.message.meta.files ?? []).filter((f) => f.name.endsWith(".docx"));
    expect(docs.map((f) => f.name)).toEqual(["CV_Martin_Wavestone_SOC_FR.docx", "LM_Martin_Wavestone_SOC_FR.docx"]);
    for (const f of docs) expect(f.path.startsWith(path.join(base, "Applications") + path.sep)).toBe(true);
    const xml = await (await JSZip.loadAsync(fs.readFileSync(docs[0]!.path))).file("word/document.xml")!.async("string");
    expect(xml).toContain("Camille MARTIN");
    expect(xml).toContain("EXPÉRIENCE PROFESSIONNELLE");
    expect(xml).toContain("MITRE ATT&amp;CK");
  }, 120_000);
});

describe("performance", () => {
  it("counts offers, sent applications and answers over the chosen period", async () => {
    const { h } = await boot();
    await api(h, "POST", "/api/import");
    const thales = (await api(h, "POST", "/api/offers/from-url", { url: "https://careers.thales.com/fr/job/R0251234" })).json().offer as Offer;
    const app = (await api(h, "POST", `/api/offers/${thales.id}/application`, {})).json();
    await api(h, "POST", `/api/applications/${app.id}/status`, { status: "sent" });
    await api(h, "POST", `/api/applications/${app.id}/status`, { status: "interview_proposed" });
    const p = (await api(h, "GET", "/api/performance?days=7")).json() as JobsPerformance;
    expect(p.tiles).toMatchObject({ offers: 1, sent: 1, steps: 1, responseRate: 100 });
    expect(p.series).toHaveLength(7);
    expect(p.series.at(-1)).toMatchObject({ offers: 1, sent: 1 });
    expect(p.funnel.find((f) => f.key === "steps")?.value).toBe(1);
    expect(p.sources).toEqual([{ label: "Lien : careers.thales.com", value: 1 }]);
    // The imported offer was found earlier: it counts since the beginning only.
    const all = (await api(h, "GET", "/api/performance?days=all")).json() as JobsPerformance;
    expect(all.tiles.offers).toBe(2);
    expect(all.bucket).toBe("week");
    expect((await api(h, "GET", "/api/performance?days=12")).status).toBe(400);
  });
});

describe("robustness and privacy", () => {
  it("15. keeps the data intact when Claude or Gmail fail", async () => {
    const { h, claude } = await boot();
    await api(h, "POST", "/api/offers/from-url", { url: "https://careers.thales.com/fr/job/R0251234" });
    claude.script = async (call) => {
      await call("create_offer", { company: "Safran", title: "Stage cyber", source: "texte" });
      throw new ClaudeError("rate_limit", "La limite d'usage de votre abonnement Claude est atteinte pour le moment.");
    };
    const events = await chat(h, "Analyse", "A");
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect((await api(h, "GET", "/api/offers?status=all")).json()).toHaveLength(1);
    await api(h, "POST", "/api/gmail/connect", { email: "camille.martin@gmail.com", password: "abcdefghijklmnop" });
    FakeGmail.down = true;
    const r = await api(h, "POST", "/api/gmail/sync");
    expect(r.status).toBe(503);
    expect((await api(h, "GET", "/api/offers?status=all")).json()).toHaveLength(1);
  });

  it("16 and 18. keeps secrets out of the code and stands alone", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (["node_modules", "dist", "data", "Applications", ".git"].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|json|md|css|html)$/.test(e.name) && !p.includes(`${path.sep}tests${path.sep}`)) files.push(p);
      }
    };
    walk(ROOT);
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      expect(/sk-ant-[a-z0-9]{10,}|GOCSPX-[A-Za-z0-9_-]{10,}|ya29\.[A-Za-z0-9_-]{10,}/.test(text), f).toBe(false);
      expect(/Platform[\\/]|from ["'].*aura["']/i.test(text), f).toBe(false);
    }
  });

  it("17. exports the tracking table in CSV and Excel", async () => {
    const { h } = await boot();
    await api(h, "POST", "/api/import");
    const csv = await api(h, "GET", "/api/export.csv");
    expect(csv.body.startsWith("﻿Entreprise;Poste;Statut")).toBe(true);
    expect(csv.body).toContain("Wavestone;Stage - Intelligence artificielle & Cybersécurité;Préparée");
    const zip = await JSZip.loadAsync((await api(h, "GET", "/api/export.xlsx")).raw);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain("Wavestone");
    expect(sheet).toContain("<hyperlinks>");
  });
});

describe("assistant: auto mode, model, discovery, connectors", () => {
  const offerText = { company: "Orange Cyberdefense", title: "Stage GRC et conformité", source: "texte collé", description: "Stage de six mois en GRC, ISO 27001 et analyse de risques. ".repeat(6) };
  const doneOf = (ev: StreamEvent[]) => ev.find((e): e is Extract<StreamEvent, { type: "done" }> => e.type === "done")!;

  it("in auto, only prepares changes until Claude picks a mode, then follows the mode it picked", async () => {
    const { h, claude } = await boot();
    claude.script = async (call, req) => {
      expect(req.model).toBe("haiku");
      expect(req.prompt).toContain("Mode auto");
      expect((await call("create_offer", offerText)).result).toMatchObject({ prepared: true });
      expect((await call("choose_mode", { mode: "B", reason: "Demande explicite" })).error).toContain("déjà préparés");
      return "Préparé.";
    };
    const first = doneOf(await chatWith(h, { message: "Que penses-tu de cette offre ?", mode: "auto", model: "haiku" }));
    expect(first.message.meta).toMatchObject({ mode: "A", auto: true });
    expect(first.proposal?.ops).toHaveLength(1);
    expect((await api(h, "GET", "/api/offers")).json()).toHaveLength(0);

    claude.script = async (call) => {
      expect((await call("choose_mode", { mode: "B", reason: "L'utilisateur demande d'ajouter l'offre" })).ok).toBe(true);
      expect((await call("choose_mode", { mode: "C", reason: "Encore" })).error).toContain("déjà choisi");
      expect((await call("create_offer", offerText)).result).toMatchObject({ created: true });
      return "Ajoutée.";
    };
    const second = doneOf(await chatWith(h, { message: "Ajoute cette offre", mode: "auto" }));
    expect(second.message.meta).toMatchObject({ mode: "B", auto: true });
    expect(second.proposal).toBeNull();
    expect((await api(h, "GET", "/api/offers")).json()).toHaveLength(1);

    claude.script = async (call) => {
      expect((await call("choose_mode", { mode: "C", reason: "Tout" })).error).toContain("fixé par l'utilisateur");
      return "ok";
    };
    await chat(h, "Bonjour", "B");
  });

  it("tells Claude to prepare the CV and the letter of a new offer, and the new tools stay local", () => {
    const s = loadSettings({ get: () => undefined } as never);
    expect(s.defaultMode).toBe("auto");
    expect(s.autoDocuments).toBe(true);
    expect(buildPrompt("Voici une offre", "auto", [], s)).toContain("Préparation automatique du CV et de la lettre : activée.");
    expect(buildPrompt("Voici une offre", "B", [], { ...s, autoDocuments: false })).toContain("désactivée");
    expect(SYSTEM_PROMPT).toContain("Offre donnée par l'utilisateur");
    expect(SYSTEM_PROMPT).not.toContain("pas encore disponible");
  });

  it("discovery reads the documents and writes the profile only, and only prepares it when one exists", async () => {
    const { h, claude } = await boot();
    const profile = ["- Formation : École d'ingénieurs (2026-2027).", "- Expériences : SOC chez Acme Telecom.", "- Orientations : SOC, GRC (déduit, à confirmer)."].join("\n");
    claude.script = async (call, req) => {
      expect(req.connectors).toEqual([]);
      expect(req.prompt).toContain("Tâche : Découverte");
      expect((await call("create_offer", offerText)).error).toContain("pas disponible");
      expect((await call("list_documents", {})).ok).toBe(true);
      expect((await call("save_profile", { profile, contact: { name: "Test Person" } })).ok).toBe(true);
      return "Profil créé.";
    };
    const ev = await chatWith(h, { message: "x", task: "discovery" });
    expect(ev[0]).toMatchObject({ type: "accepted", message: { content: expect.stringContaining("Découverte : lis mes CV") } });
    expect(doneOf(ev).message.meta.mode).toBe("B");
    const s = (await api(h, "GET", "/api/settings")).json();
    expect(s.profile).toBe(profile);
    expect(s.contact.name).toBe("Test Person");
    expect(s.contact.city).toBe("Lyon, France");
    expect((await api(h, "GET", "/api/offers")).json()).toHaveLength(0);

    await api(h, "POST", "/api/import");
    claude.script = async (call) => {
      expect((await call("save_profile", { profile: "- Une autre version du profil, plus courte mais complète." })).result).toMatchObject({ prepared: true });
      return "Proposé.";
    };
    expect(doneOf(await chatWith(h, { message: "x", task: "discovery" })).proposal).not.toBeNull();
    expect((await api(h, "GET", "/api/settings")).json().profile).toBe(profile);
  });

  it("shows the application status in the offer list, and the status changes from there", async () => {
    const { h } = await boot();
    await api(h, "POST", "/api/import");
    const offer = ((await api(h, "GET", "/api/offers")).json() as Offer[])[0]!;
    expect(offer.applicationStatus).toBe("prepared");
    expect((await api(h, "POST", `/api/applications/${offer.applicationId}/status`, { status: "validated" })).status).toBe(200);
    expect(((await api(h, "GET", "/api/offers")).json() as Offer[])[0]!.applicationStatus).toBe("validated");
  });

  it("reads the connectors of the account and denies every one that is not allowed", () => {
    const out = [
      "Checking MCP server health…",
      "",
      "claude.ai LinkedIn Hiring Pro: https://mcp.linkedin.com/mcp-hiring-pro - ✔ Connected",
      "claude.ai Indeed: https://mcp.indeed.com/claude/mcp - ✔ Connected",
      "claude.ai Figma: https://mcp.figma.com/mcp - ! Needs authentication",
      "plugin:playwright:playwright: npx @playwright/mcp@latest - ✔ Connected",
    ].join("\n");
    expect(parseConnectorList(out)).toEqual([
      { name: "LinkedIn Hiring Pro", prefix: "mcp__claude_ai_LinkedIn_Hiring_Pro", status: "connected" },
      { name: "Indeed", prefix: "mcp__claude_ai_Indeed", status: "connected" },
      { name: "Figma", prefix: "mcp__claude_ai_Figma", status: "needs_auth" },
    ]);
    expect(connectorPrefix("Google Drive")).toBe("mcp__claude_ai_Google_Drive");
  });

  it("changing one setting keeps every other one, and an unreadable field never erases the rest", async () => {
    const { h } = await boot();
    const mine = { profile: "- Formation : École d'ingénieurs.\n- Orientations : SOC, GRC.", alertExclude: ["senior"], alertKeywords: ["cyber"], model: "opus" as const };
    saveSettings(h.db, mine);
    const before = (await api(h, "GET", "/api/settings")).json();
    // A switch, the theme, the end of the welcome screen: each sends one field only.
    for (const patch of [{ theme: "dark" }, { setupDone: true }, { indeedConnector: false }]) expect((await api(h, "PATCH", "/api/settings", patch)).status).toBe(200);
    const after = (await api(h, "GET", "/api/settings")).json();
    expect(after).toMatchObject({ ...mine, contact: before.contact, documentRoots: before.documentRoots, theme: "dark", setupDone: true, indeedConnector: false });

    // A stored value that no longer fits (an older or a hand-edited file) only loses that value.
    const row = JSON.parse(h.db.get<{ data: string }>("SELECT data FROM settings WHERE id = 1")!.data);
    h.db.run("UPDATE settings SET data = ? WHERE id = 1", JSON.stringify({ ...row, model: "gpt-9" }));
    expect((await api(h, "GET", "/api/settings")).json()).toMatchObject({ ...mine, model: "sonnet", contact: before.contact });
  });

  it("shows the welcome screen only on a new install", async () => {
    const { h } = await boot();
    expect((await api(h, "GET", "/api/bootstrap")).json().firstRun).toBe(true);
    await api(h, "PATCH", "/api/settings", { setupDone: true });
    expect((await api(h, "GET", "/api/bootstrap")).json().firstRun).toBe(false);
    const other = await boot();
    await api(other.h, "POST", "/api/import");
    expect((await api(other.h, "GET", "/api/bootstrap")).json().firstRun).toBe(false);
  });
});
