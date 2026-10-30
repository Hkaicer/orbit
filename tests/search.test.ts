// The job search asked through the assistant. The sites are simulated: nothing
// leaves the computer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Offer, RunnerStatus, StreamEvent } from "../shared/types";
import { createApp, type AppHandle } from "../server/app";
import type { AssistantRunner, RunRequest } from "../server/ai/runner";
import { executeTool } from "../server/ai/tools";
import { loadConfig } from "../server/config";
import { noProtection } from "../server/mail/dpapi";
import { companyFromUrl, contractOf, hasWord, placeFits, scoreJob } from "../server/search/search";
import type { FoundJob } from "../server/search/collectors";
import { saveSettings } from "../server/services/settings";

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
const html = (text: string) => new Response(text, { status: 200, headers: { "content-type": "text/html" } });

const card = (id: string, title: string, company: string, location: string) => `
<li><div class="base-card relative w-full base-search-card base-search-card--link job-search-card" data-entity-urn="urn:li:jobPosting:${id}">
  <a class="base-card__full-link" href="https://fr.linkedin.com/jobs/view/x-${id}?position=1&amp;trk=public_jobs"></a>
  <h3 class="base-search-card__title">  ${title}  </h3>
  <h4 class="base-search-card__subtitle"><a href="#">${company}</a></h4>
  <span class="job-search-card__location">${location}</span>
  <time class="job-search-card__listdate" datetime="2026-10-28">2 days ago</time>
</div></li>`;

/** The sites, as seen from ORBIT. */
function fakeSites() {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/acme/jobs")) {
      return json({
        jobs: [
          {
            title: "Security Analyst Intern",
            location: { name: "Paris, France" },
            absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
            updated_at: "2026-10-27T10:00:00Z",
            content: "&lt;p&gt;SOC team: SIEM, Splunk, Python, MITRE ATT&amp;amp;CK.&lt;/p&gt;",
          },
          {
            title: "Security Analyst Intern",
            location: { name: "Singapore" },
            absolute_url: "https://boards.greenhouse.io/acme/jobs/2",
            updated_at: "2026-10-27T10:00:00Z",
            content: "&lt;p&gt;SOC team: SIEM, Splunk, Python, MITRE ATT&amp;amp;CK.&lt;/p&gt;",
          },
          { title: "Senior Security Engineer", location: { name: "Paris" }, absolute_url: "https://boards.greenhouse.io/acme/jobs/3", content: "&lt;p&gt;Cybersecurity&lt;/p&gt;" },
          { title: "Sales Manager", location: { name: "Paris" }, absolute_url: "https://boards.greenhouse.io/acme/jobs/4", content: "&lt;p&gt;Sell our products&lt;/p&gt;" },
          { title: "Alternance - Analyste cybersécurité", location: { name: "Lyon" }, absolute_url: "https://boards.greenhouse.io/acme/jobs/5", content: "&lt;p&gt;SIEM&lt;/p&gt;" },
        ],
      });
    }
    if (url.includes("/jobs-guest/jobs/api/seeMoreJobPostings/search")) {
      const start = new URL(url).searchParams.get("start");
      return html(
        start === "0"
          ? card("4100000001", "Stage - Analyste SOC", "Banque Exemple", "Paris, Île-de-France, France") + card("4100000002", "Consultant cybersécurité junior", "Conseil Exemple", "Lyon")
          : "",
      );
    }
    if (url.includes("/jobs-guest/jobs/api/jobPosting/")) {
      return html(
        '<section><div class="show-more-less-html__markup show-more-less-html__markup--clamp-after-5">Analyse des alertes <strong>SIEM</strong> et Splunk, détection, Python.</div></section>',
      );
    }
    if (url.includes("algolia.net/1/indexes/wttj_jobs_production_fr/query")) {
      return json({
        nbPages: 1,
        hits: [
          {
            name: "Stage - Analyste Cybersécurité",
            organization: { name: "Jungle Corp", slug: "jungle-corp" },
            slug: "stage-analyste-cybersecurite_paris",
            offices: [{ city: "Paris", country: "France" }],
            contract_type: "internship",
            published_at: "2026-10-28T10:00:00Z",
            summary: "Au sein du SOC : SIEM, Splunk, détection.",
            remote: "partial",
          },
        ],
      });
    }
    if (url.startsWith("https://www.hellowork.com/fr-fr/emploi/recherche.html")) {
      return html(
        '<li><a href="/fr-fr/emplois/91000001.html" class="forwarder" data-cy="offerTitle" aria-label="Voir offre de Consultant cybers&#xE9;curit&#xE9; junior H/F &#xE0; Lyon - 69, chez HW Conseil, pour un CDI, avec un salaire de 40&#x202F;000 &#x20AC; / an, en temps plein"><h3>x</h3></a></li>',
      );
    }
    if (url === "https://www.hellowork.com/fr-fr/emplois/91000001.html") {
      return html('<script type="application/ld&#x2B;json">{"@type":"JobPosting","description":"<p>Audit, GRC, ISO 27001 et EBIOS.</p>"}</script>');
    }
    if (url.startsWith("https://remotive.com/api/remote-jobs")) {
      return json({
        jobs: [
          {
            title: "Cybersecurity Analyst",
            company_name: "Remote Co",
            candidate_required_location: "Europe",
            publication_date: "2026-10-20T00:00:00",
            url: "https://remotive.com/j/9",
            description: "<p>Incident response, SIEM</p>",
            job_type: "full_time",
          },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

/** Runs the tools of a request as the AI would, with no AI at all. */
class ScriptedRunner implements AssistantRunner {
  script: (call: (name: string, input: unknown) => ReturnType<typeof executeTool>) => Promise<string> = async () => "ok";
  async status(): Promise<RunnerStatus> {
    return { state: "ready", message: "ok", plan: "test", version: "test" };
  }
  async run(req: RunRequest) {
    return { text: await this.script((name, input) => executeTool(req.run!, name, input)), model: "test" };
  }
}

const handles: AppHandle[] = [];
const dirs: string[] = [];

async function boot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-search-"));
  dirs.push(base);
  const sites = fakeSites();
  const runner = new ScriptedRunner();
  const pauses: number[] = [];
  const h = await createApp({
    config: { ...loadConfig(), dataDir: path.join(base, "data"), applicationsDir: path.join(base, "Applications"), webDir: path.join(base, "no-web") },
    claude: runner,
    secretsFile: null,
    protector: noProtection,
    fetch: sites.fetchFn,
    searchSleep: async (ms) => {
      pauses.push(ms);
    },
  });
  saveSettings(h.db, {
    searchBoards: { linkedin: true, wttj: true, hellowork: true, france_travail: false, adzuna: false, remotive: true, arbeitnow: false, remoteok: false },
    searchCompanies: [{ type: "greenhouse", company: "Acme", slug: "acme", active: true }],
    alertExclude: ["senior"],
  });
  handles.push(h);
  return { h, runner, sites, pauses };
}

const chat = async (h: AppHandle, message: string) =>
  (await h.app.inject({ method: "POST", url: "/api/ai/chat", payload: { message, mode: "B" } })).body
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as StreamEvent);

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.app.close();
    h.db.close();
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("job search", () => {
  it("asks for the preferences first, reads the sites, ranks without the place, and keeps the site of each offer", async () => {
    const { h, runner, sites, pauses } = await boot();
    type Result = { id: string; title: string; company: string; site: string; location: string; score: number; reasons: string[]; descriptionRead: boolean };
    let search: { searchId: string; counts: Record<string, number>; sources: { source: string; found: number }[]; results: Result[] } | null = null;
    runner.script = async (call) => {
      // Without the user's answers, the search does not run.
      expect((await call("search_jobs", { keywords: ["cyber"] })).ok).toBe(false);
      const r = await call("search_jobs", { preferencesConfirmed: true, keywords: ["cybersécurité", "cybersecurity", "security", "SOC"], contracts: ["stage", "cdi"], limit: 50 });
      expect(r.ok).toBe(true);
      search = (r as { result: unknown }).result as typeof search;
      const added = await call("add_search_results", { searchId: search!.searchId, ids: search!.results.map((x) => x.id) });
      expect((added as { result: unknown }).result).toMatchObject({ added: search!.results.length, alreadyKnown: 0 });
      return "Offres ajoutées.";
    };
    await chat(h, "Cherche-moi des stages en cybersécurité");
    const s = search!;

    // Out of the search, excluded words and other contracts are left out.
    const titles = s.results.map((x) => `${x.company} | ${x.title} | ${x.location}`);
    expect(titles.some((t) => t.includes("Sales Manager"))).toBe(false);
    expect(titles.some((t) => t.includes("Senior"))).toBe(false);
    expect(titles.some((t) => t.includes("Alternance"))).toBe(false);
    expect(s.counts).toMatchObject({ excluded: 1, otherContract: 1 });
    // The same company and title in two cities is one offer, as when an offer is added by hand.
    expect(s.results.filter((x) => x.company === "Acme" && x.title === "Security Analyst Intern")).toHaveLength(1);
    // Acme in Singapore, Remotive's offer seen again for three of the four keywords, Welcome to the Jungle's for two of its three.
    expect(s.counts.duplicates).toBe(6);

    // LinkedIn: read without an account, with a pause of at least 2 seconds before each request after the first.
    const linkedinCalls = sites.calls.filter((u) => u.includes("linkedin.com"));
    expect(linkedinCalls.length).toBeGreaterThan(1);
    expect(pauses.filter((ms) => ms >= 2000).length).toBeGreaterThanOrEqual(linkedinCalls.length - 1);
    // Every site read without an account waits between two requests: 1 to 4 seconds.
    expect(pauses.every((ms) => ms >= 1000 && ms <= 4000)).toBe(true);
    const li = s.results.find((x) => x.site === "LinkedIn" && x.title === "Stage - Analyste SOC")!;
    expect(li.descriptionRead).toBe(true);

    // Every offer keeps the site it was found on, and the search's score as an estimate.
    const offers = (await h.app.inject({ method: "GET", url: "/api/offers" })).json() as Offer[];
    expect(offers).toHaveLength(s.results.length);
    const liOffer = offers.find((o) => o.title === "Stage - Analyste SOC")!;
    expect(liOffer).toMatchObject({ source: "LinkedIn", url: "https://www.linkedin.com/jobs/view/4100000001/", company: "Banque Exemple" });
    expect(liOffer.analysis).toMatchObject({ by: "local", score: li.score });
    expect(offers.find((o) => o.company === "Acme")!.source).toBe("Site carrières (Greenhouse)");
    expect(offers.find((o) => o.company === "Remote Co")!.source).toBe("Remotive");
    expect(offers.find((o) => o.company === "Jungle Corp")).toMatchObject({
      source: "Welcome to the Jungle",
      url: "https://www.welcometothejungle.com/fr/companies/jungle-corp/jobs/stage-analyste-cybersecurite_paris",
    });
    const hw = offers.find((o) => o.company === "HW Conseil")!;
    expect(hw).toMatchObject({ source: "HelloWork", title: "Consultant cybersécurité junior H/F", location: "Lyon - 69", url: "https://www.hellowork.com/fr-fr/emplois/91000001.html" });
    expect(hw.description).toContain("EBIOS");

    // A second search recognizes the offers already in ORBIT.
    runner.script = async (call) => {
      const r = ((await call("search_jobs", { preferencesConfirmed: true, keywords: ["cybersécurité", "cybersecurity", "security", "SOC"], contracts: ["stage", "cdi"] })) as { result: unknown })
        .result as { counts: { alreadyInOrbit: number }; results: unknown[] };
      expect(r.counts.alreadyInOrbit).toBe(s.results.length);
      expect(r.results).toHaveLength(0);
      return "Rien de nouveau.";
    };
    await chat(h, "Encore une fois");
  });

  it("filters by place only when asked, and recognizes career sites from a link", async () => {
    const { h, runner } = await boot();
    runner.script = async (call) => {
      const r = ((await call("search_jobs", { preferencesConfirmed: true, keywords: ["security"], locations: ["Paris"], remote: true })) as { result: unknown }).result as {
        results: { location: string; site: string }[];
      };
      // Paris, and the remote offer, are kept. Singapore is not.
      expect(r.results.map((x) => x.location).sort()).toEqual(["Europe", "Paris, France"]);
      return "ok";
    };
    await chat(h, "Seulement Paris ou à distance");

    expect(companyFromUrl("https://job-boards.greenhouse.io/datadog/jobs/123")).toMatchObject({ type: "greenhouse", slug: "datadog", company: "Datadog" });
    expect(companyFromUrl("https://jobs.eu.lever.co/acme/abc")).toMatchObject({ type: "lever", slug: "acme", eu: true });
    expect(companyFromUrl("https://jobs.ashbyhq.com/openai/xyz")).toMatchObject({ type: "ashby", slug: "openai" });
    expect(companyFromUrl("https://jobs.smartrecruiters.com/rolandberger/7444")).toMatchObject({ type: "smartrecruiters", slug: "rolandberger" });
    expect(companyFromUrl("https://ag.wd3.myworkdayjobs.com/fr-FR/Airbus/job/Toulouse/Stage_JR1", "Airbus")).toMatchObject({
      type: "workday",
      host: "ag.wd3.myworkdayjobs.com",
      tenant: "ag",
      site: "Airbus",
      company: "Airbus",
    });
    expect(companyFromUrl("https://www.welcometothejungle.com/fr/companies/x/jobs/y")).toBeNull();

    // A phrase matches with all its words, in any order. Short words must be whole words.
    expect(hasWord("Security Engineer - Cloud", "cloud security")).toBe(true);
    expect(hasWord("Consultant en cybersécurité", "conseil en cybersécurité")).toBe(false);
    expect(hasWord("Senior Associate", "SOC")).toBe(false);
    // "France" and "Île-de-France" know the cities that job sites write without the country.
    expect(placeFits("Élancourt", "France")).toBe(true);
    expect(placeFits("Toulouse Area", "France")).toBe(true);
    expect(placeFits("Montreuil (93)", "Île-de-France")).toBe(true);
    expect(placeFits("Lyon", "Île-de-France")).toBe(false);
    expect(placeFits("San Francisco", "France")).toBe(false);
    expect(contractOf({ title: "Stage - Analyste SOC", contract: null })).toBe("stage");
    expect(contractOf({ title: "SOC Analyst", contract: "Full-time" })).toBe("cdi");
    const job: FoundJob = { site: "x", company: "c", title: "SOC Analyst", location: "Paris", posted: null, url: "u", description: "SIEM Splunk", contract: null, remote: false };
    const basis = { keywords: ["SOC"], orientations: [], skills: new Set(["siem"]), contracts: [] };
    expect(scoreJob(job, basis).score).toBe(scoreJob({ ...job, location: "Tokyo" }, basis).score);
  });
});
