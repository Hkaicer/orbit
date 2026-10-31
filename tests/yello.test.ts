// Yello career sites (EY): recognized from a link, read through the board's own
// search with pauses, filtered by the board's own country filter.

import { describe, expect, it } from "vitest";
import { collectCompany, YELLO_LIMITS } from "../server/search/collectors";
import { companyFromUrl } from "../server/search/search";

const BOARD = "https://eyglobal.yello.co/job_boards/c1riT--B2O-KySgYWsZO1Q";

const card = (id: string, title: string) =>
  `<li class="search-results__item"><div class="clearfix"><div class="search-results__jobinfo pull-left"><a class="search-results__req_title" lang="en" href="/jobs/${id}?job_board_id=c1riT--B2O-KySgYWsZO1Q">${title}</a><div><span>17</span></div></div></div></li>`;

/** EY's board as ORBIT sees it. */
function fakeYello() {
  const calls: string[] = [];
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === BOARD)
      return new Response(
        `<div data-filter-search-url="${BOARD}/filter_fields/search/245">Country/Region</div><div data-filter-search-url="${BOARD}/filter_fields/search/970">City</div><div data-filter-search-url="https://evil.example/x"></div>`,
      );
    if (url.startsWith(`${BOARD}/filter_fields/search/245`)) {
      const asked = new URL(url).searchParams.get("query");
      if (asked === "Morocco") return json({ filter_answers: [{ id: 555, label: "Morocco" }], more_answers: false });
      return json({
        filter_answers:
          asked === "France"
            ? [
                { id: 29994, label: "France" },
                { id: 1, label: "French Polynesia" },
              ]
            : [],
        more_answers: false,
      });
    }
    if (url.startsWith(`${BOARD}/filter_fields/search/970`)) return json({ filter_answers: [], more_answers: false });
    if (url.startsWith(`${BOARD}/search?`)) {
      const p = new URL(url).searchParams;
      if (p.get("filters") === "555") return json({ html: card("ma1", "Consultant Cybersécurité - Casablanca"), more_requisitions: false });
      if (p.get("filters") !== "29994") return json({ html: card("world", "USA - Intern"), more_requisitions: false });
      if (p.get("page_number") === "1")
        return json({ html: card("a1", "Stage en Digital Forensics / eDiscovery - Paris") + card("a2", "Junior Cybersecurity Consultant &amp; GRC"), more_requisitions: true });
      return json({ html: card("a2", "Junior Cybersecurity Consultant &amp; GRC") + card("a3", "Auditeur IT"), more_requisitions: false });
    }
    if (url.startsWith("https://eyglobal.yello.co/jobs/a1"))
      return new Response(
        '<h1>Stage</h1><div class="job-details__description pull-left"><p>Nous recrutons des <b>stagiaires</b> en Digital Forensic.</p></div><div class="job-details__sidebar pull-right"><div class="secondary-details__group"><span class="secondary-details__title">Country/Region</span><span class="secondary-details__content">France</span></div></div>',
      );
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("Yello career sites", () => {
  it("recognizes a board or an offer link, reads the board's search in the place asked for, slowly, and reads an offer page", async () => {
    expect(companyFromUrl(BOARD, "EY")).toEqual({ type: "yello", company: "EY", host: "eyglobal.yello.co", slug: "c1riT--B2O-KySgYWsZO1Q", active: true });
    expect(companyFromUrl("https://eyglobal.yello.co/jobs/8fiqv7D6PIeTht36-WQkZw?job_board_id=c1riT--B2O-KySgYWsZO1Q")).toMatchObject({ type: "yello", company: "Ey", slug: "c1riT--B2O-KySgYWsZO1Q" });
    // An offer link without its board says nothing about the board.
    expect(companyFromUrl("https://eyglobal.yello.co/jobs/8fiqv7D6PIeTht36-WQkZw")).toBeNull();

    const { fetchFn, calls } = fakeYello();
    const pauses: number[] = [];
    const src = companyFromUrl(BOARD, "EY")!;
    const jobs = await collectCompany(
      src,
      { keywords: ["cyber"], location: "France", since: null, internship: false, remoteOnly: false },
      { fetch: fetchFn, sleep: async (ms) => void pauses.push(ms) },
    );
    expect(jobs.map((j) => j.title)).toEqual(["Stage en Digital Forensics / eDiscovery - Paris", "Junior Cybersecurity Consultant & GRC", "Auditeur IT"]);
    expect(jobs[0]).toMatchObject({ site: "Site carrières (Yello)", company: "EY", location: "France", located: true, url: "https://eyglobal.yello.co/jobs/a1?job_board_id=c1riT--B2O-KySgYWsZO1Q" });
    // Only the board's own filters are asked, and every request waits its turn.
    expect(calls.some((u) => u.includes("evil.example"))).toBe(false);
    expect(calls.filter((u) => u.includes("/search?"))).toHaveLength(2);
    expect(pauses).toHaveLength(3);
    expect(pauses.every((ms) => ms >= YELLO_LIMITS.minPauseMs && ms <= YELLO_LIMITS.maxPauseMs)).toBe(true);

    const text = await jobs[0]!.detail!();
    expect(text).toContain("Nous recrutons des stagiaires en Digital Forensic.");
    expect(text).toContain("Country/Region : France");

    // Without a place, the whole board is searched and the place filter of ORBIT applies later.
    const world = await collectCompany(src, { keywords: ["cyber"], location: "", since: null, internship: false, remoteOnly: false }, { fetch: fetchFn, sleep: async () => undefined });
    expect(world).toMatchObject([{ title: "USA - Intern", location: "" }]);
    expect(world[0]!.located).toBeUndefined();

    // A search in Morocco, asked in French: the board names it in English.
    const ma = await collectCompany(src, { keywords: ["cyber"], location: "Maroc", since: null, internship: false, remoteOnly: false }, { fetch: fetchFn, sleep: async () => undefined });
    expect(ma).toMatchObject([{ title: "Consultant Cybersécurité - Casablanca", location: "Morocco", located: true }]);
  });
});
