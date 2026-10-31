// A user in Morocco: the country comes from the profile, the places from Moroccan
// cities, and the sites with offers in France only are skipped. France is unchanged.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppHandle } from "../server/app";
import { loadConfig } from "../server/config";
import { parseAlert } from "../server/mail/alerts";
import { noProtection } from "../server/mail/dpapi";
import type { RawMail } from "../server/mail/imap";
import { placeFits, runSearch, searchCountry } from "../server/search/search";
import { loadSettings, saveSettings } from "../server/services/settings";

const handles: AppHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.app.close();
    h.db.close();
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("France or Morocco", () => {
  it("knows Moroccan places in French and in English, and leaves France as it was", () => {
    // France, as before.
    expect(placeFits("Massy, Île-de-France", "France")).toBe(true);
    expect(placeFits("Paris (75)", "Île-de-France")).toBe(true);
    expect(placeFits("Casablanca, Morocco", "France")).toBe(false);
    // Morocco.
    expect(placeFits("Casablanca, Casablanca-Settat, Morocco", "Maroc")).toBe(true);
    expect(placeFits("Rabat", "Maroc")).toBe(true);
    expect(placeFits("Fès-Meknès", "Morocco")).toBe(true);
    expect(placeFits("Casanearshore, Sidi Maârouf", "Maroc")).toBe(true);
    expect(placeFits("Salerno, Italy", "Maroc")).toBe(false);
    expect(placeFits("Paris, France", "Maroc")).toBe(false);
    expect(placeFits("Tanger", "Tanger")).toBe(true);
  });

  it("takes the country from the assistant, then from the places asked, then from the profile", () => {
    const profile = (text: string, city = "") => ({ text, city });
    expect(searchCountry("ma", ["Paris"], profile(""))).toBe("ma");
    expect(searchCountry(undefined, ["Casablanca"], profile(""))).toBe("ma");
    expect(searchCountry(undefined, ["Maroc"], profile(""))).toBe("ma");
    expect(searchCountry(undefined, ["Lyon"], profile("- Recherche : stage au Maroc"))).toBe("fr");
    expect(searchCountry(undefined, [], profile("- Recherche : stage PFE en cybersécurité au Maroc (Casablanca, Rabat)"))).toBe("ma");
    expect(searchCountry(undefined, [], profile("- Recherche : CDI junior", "Rabat"))).toBe("ma");
    // A Moroccan experience in the CV does not make a search Moroccan.
    expect(searchCountry(undefined, [], profile("- Stage chez Maroc Telecom, Rabat\n- Recherche : CDI junior", "Paris, France"))).toBe("fr");
    expect(searchCountry(undefined, [], profile(""))).toBe("fr");
  });

  it("skips the sites with offers in France only for a search in Morocco, and keeps them for France", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-ma-"));
    dirs.push(base);
    const h = await createApp({
      config: { ...loadConfig(), dataDir: path.join(base, "data"), applicationsDir: path.join(base, "Applications"), webDir: path.join(base, "no-web") },
      secretsFile: null,
      protector: noProtection,
    });
    handles.push(h);
    saveSettings(h.db, {
      profile: "- Recherche : stage PFE en cybersécurité au Maroc",
      searchBoards: { linkedin: false, wttj: false, hellowork: true, france_travail: true, adzuna: true, remotive: false, arbeitnow: false, remoteok: false },
      searchCompanies: [{ type: "greenhouse", company: "Acme", slug: "acme", active: true }],
    });
    const called: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      called.push(url);
      if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/acme/jobs"))
        return new Response(
          JSON.stringify({
            jobs: [
              { title: "Stage PFE Cybersécurité SOC", location: { name: "Casablanca, Morocco" }, absolute_url: "https://acme.example/jobs/1", content: "SOC SIEM", updated_at: "2026-10-30" },
              { title: "Stage Cybersécurité SOC", location: { name: "Paris, France" }, absolute_url: "https://acme.example/jobs/2", content: "SOC SIEM", updated_at: "2026-10-30" },
            ],
          }),
        );
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const run = (locations: string[], country?: "fr" | "ma") =>
      runSearch(
        { db: h.db, settings: loadSettings(h.db), keys: {}, collect: { fetch: fetchFn, sleep: async () => undefined } },
        { keywords: ["cybersécurité", "SOC"], contracts: [], locations, remote: false, since: null, exclude: [], limit: 50, only: [], country },
      );

    // The profile says Morocco: no place given, Morocco anyway.
    const ma = await run([]);
    expect(ma.country).toBe("ma");
    expect(ma.sources.filter((s) => s.skipped).map((s) => s.source)).toEqual(["HelloWork", "France Travail", "Adzuna"]);
    expect(called.some((u) => /hellowork|francetravail|adzuna/.test(u))).toBe(false);
    const inMorocco = await run(["Maroc"]);
    expect(inMorocco.results.map((r) => r.location)).toEqual(["Casablanca, Morocco"]);

    // The assistant says France: the French sites are read as before, and the place filter is the French one.
    const fr = await run(["France"], "fr");
    expect(fr.country).toBe("fr");
    expect(fr.sources.some((s) => s.skipped)).toBe(false);
    expect(fr.results.map((r) => r.location)).toEqual(["Paris, France"]);
  });

  it("reads the job alerts of Rekrute and Emploi.ma, keeping only the clean link of each offer", () => {
    const mail = (address: string, text: string): RawMail => ({
      id: "1",
      threadId: "1",
      date: new Date("2026-10-30T08:00:00Z"),
      from: { name: "Alerte", address },
      subject: "Nouvelles offres",
      text,
      html: null,
      attachments: [],
    });
    const rekrute = parseAlert(
      mail(
        "alertes@rekrute.com",
        [
          "Bonjour,",
          "",
          "Consultant Sécurité Pentest H/F",
          "Orange Business",
          "Casablanca",
          "https://www.rekrute.com/offre-emploi-consultant-securite-pentest-hf-recrutement-orange-business-casablanca-187248.html?utm_source=alerte&token=abc",
          "",
          "Se désabonner : https://www.rekrute.com/unsubscribe?u=1",
        ].join("\n"),
      ),
    );
    expect(rekrute).toEqual([
      {
        source: "Rekrute",
        title: "Consultant Sécurité Pentest H/F",
        company: "Orange Business",
        location: "Casablanca",
        url: "https://www.rekrute.com/offre-emploi-consultant-securite-pentest-hf-recrutement-orange-business-casablanca-187248.html",
        snippet: null,
      },
    ]);
    const emploi = parseAlert(
      mail("noreply@emploi.ma", ["Ingénieur Cybersécurité", "CGI Maroc", "Rabat", "https://www.emploi.ma/offre-emploi-maroc/ingenieur-cybersecurite-8412345?utm_medium=email"].join("\n")),
    );
    expect(emploi).toMatchObject([
      { source: "Emploi.ma", title: "Ingénieur Cybersécurité", company: "CGI Maroc", location: "Rabat", url: "https://www.emploi.ma/offre-emploi-maroc/ingenieur-cybersecurite-8412345" },
    ]);
  });
});
