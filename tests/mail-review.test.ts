// The assistant sorts the recruiting emails: it only proposes, the user edits
// and accepts one by one or all at once.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Application, MailReview, Offer, RunnerStatus, StreamEvent } from "../shared/types";
import { createApp, type AppHandle } from "../server/app";
import type { AssistantRunner, RunRequest } from "../server/ai/runner";
import { executeTool } from "../server/ai/tools";
import { loadConfig } from "../server/config";
import { noProtection } from "../server/mail/dpapi";

/** Runs the tools of a request as the AI would, with no AI at all. */
class ScriptedRunner implements AssistantRunner {
  requests: RunRequest[] = [];
  script: (call: (name: string, input: unknown) => ReturnType<typeof executeTool>) => Promise<string> = async () => "ok";
  async status(): Promise<RunnerStatus> {
    return { state: "ready", message: "ok", plan: "test", version: "test" };
  }
  async run(req: RunRequest) {
    this.requests.push(req);
    return { text: await this.script((name, input) => executeTool(req.run!, name, input)), model: "test" };
  }
}

const handles: AppHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.app.close();
    h.db.close();
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("sorting the emails with the assistant", () => {
  it("proposes an application and a status for each email, lets the user edit, and applies everything only when accepted", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-review-"));
    dirs.push(base);
    const runner = new ScriptedRunner();
    const h = await createApp({
      config: { ...loadConfig(), dataDir: path.join(base, "data"), applicationsDir: path.join(base, "Applications"), webDir: path.join(base, "no-web") },
      claude: runner,
      secretsFile: null,
      protector: noProtection,
    });
    handles.push(h);
    const req = async <T>(method: "GET" | "POST" | "PATCH", url: string, payload?: object) => {
      const res = await h.app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as T;
    };

    // One application already tracked, sent.
    const { offer } = await req<{ offer: Offer }>("POST", "/api/offers", { company: "Thales", title: "Analyste SOC", source: "manual" });
    const thales = await req<Application>("POST", `/api/offers/${offer.id}/application`, {});
    await req("POST", `/api/applications/${thales.id}/status`, { status: "sent" });

    const mail = (id: string, date: string, from: string, subject: string, snippet: string, category = "other") =>
      h.db.run(
        "INSERT INTO mails (id, thread_id, date, from_name, from_address, subject, snippet, category, application_id, link, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
        id,
        id,
        date,
        from,
        "noreply@example.com",
        subject,
        snippet,
        category,
        new Date().toISOString(),
      );
    mail("m1", "2026-10-20T09:00:00.000Z", "Thales Recrutement", "Votre candidature", "Nous vous invitons à passer un test en ligne avant le 5 novembre.", "test");
    mail("m2", "2026-10-21T09:00:00.000Z", "Capgemini Talent", "Thank you for applying", "We received your application for Cyber Analyst.");
    mail("m3", "2026-10-22T09:00:00.000Z", "Newsletter Cyber", "Les actus de la semaine", "Abonnez-vous à notre webinaire.");
    mail("m4", "2026-10-23T09:00:00.000Z", "Sopra Steria", "Invitation à un entretien", "Nous souhaitons vous rencontrer pour le poste d'auditeur GRC.", "interview");
    mail("m5", "2026-10-24T09:00:00.000Z", "Job alerts", "10 nouvelles offres", "x", "alert");

    runner.script = async (call) => {
      const list = await call("list_mails_to_review", {});
      expect(list.ok).toBe(true);
      const { total, mails } = (list as { result: { total: number; mails: { id: string }[] } }).result;
      // Job alerts are read elsewhere.
      expect(total).toBe(4);
      expect(mails.map((m) => m.id)).toEqual(["m4", "m3", "m2", "m1"]);
      const saved = await call("propose_mail_reviews", {
        items: [
          { mailId: "m1", action: "attach", applicationId: thales.id, status: "test_todo", dueAt: "2026-11-05", note: "Thales invite à un test avant le 5 novembre." },
          { mailId: "m2", action: "new_offer", company: "Capgemini", title: "Cyber Analyst", status: "received", note: "Accusé de réception de Capgemini." },
          { mailId: "m3", action: "nothing", note: "Newsletter." },
          { mailId: "m4", action: "new_offer", company: "Sopra Steria", title: "Auditeur GRC", status: "interview_proposed", note: "Sopra Steria propose un entretien." },
          { mailId: "nope", action: "nothing", note: "Inconnu." },
          { mailId: "m3", action: "attach", note: "Sans candidature." },
        ],
      });
      const r = (saved as { result: { saved: number; results: { ok: boolean; error?: string }[] } }).result;
      expect(r.saved).toBe(4);
      expect(r.results.slice(4).every((x) => !x.ok)).toBe(true);
      // Nothing is listed twice.
      expect(((await call("list_mails_to_review", {})) as { result: { total: number } }).result.total).toBe(0);
      // Only the tools of the task.
      expect((await call("create_offer", { company: "X", title: "Y", source: "manual" })).ok).toBe(false);
      return "4 e-mails lus, 3 propositions.";
    };
    const events = (await h.app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: "", task: "mail_review" } })).body
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as StreamEvent);
    expect(events.at(-1)?.type).toBe("done");
    expect(runner.requests[0]!.prompt).toContain("tri des e-mails");

    // Nothing has changed yet.
    expect((await req<Application>("GET", `/api/applications/${thales.id}`)).status).toBe("sent");
    expect(await req<Offer[]>("GET", "/api/offers")).toHaveLength(1);
    let reviews = await req<MailReview[]>("GET", "/api/mail-reviews");
    expect(reviews.map((r) => r.mail.id)).toEqual(["m4", "m2", "m1"]);
    // An email being placed by the assistant leaves the list to attach by hand.
    expect((await req<{ id: string }[]>("GET", "/api/mails?unassigned=1")).map((m) => m.id)).toEqual([]);

    // The user corrects one: Sopra Steria's offer is "Consultant GRC".
    const sopra = reviews.find((r) => r.mail.id === "m4")!;
    await req("PATCH", `/api/mail-reviews/${sopra.id}`, { title: "Consultant GRC" });
    // And accepts the Thales one alone.
    await req("POST", `/api/mail-reviews/${reviews.find((r) => r.mail.id === "m1")!.id}/accept`);
    const detail = await req<{ status: string; evidence: { confirmed: boolean; messageId: string }[]; deadlines: { kind: string; dueAt: string }[] }>("GET", `/api/applications/${thales.id}`);
    expect(detail.status).toBe("test_todo");
    expect(detail.evidence.find((e) => e.messageId === "m1")?.confirmed).toBe(true);
    expect(detail.deadlines).toMatchObject([{ kind: "test", dueAt: "2026-11-05" }]);

    // Then all the others at once.
    reviews = await req<MailReview[]>("GET", "/api/mail-reviews");
    expect(reviews).toHaveLength(2);
    const all = await req<{ accepted: number; confirmed: number; left: number; errors: string[] }>("POST", "/api/mail-reviews/accept-all");
    expect(all).toMatchObject({ accepted: 2, left: 0, errors: [] });
    const apps = await req<Application[]>("GET", "/api/applications");
    const byCompany = Object.fromEntries(apps.map((a) => [a.offer.company, a]));
    expect(byCompany["Capgemini"]).toMatchObject({ status: "received", offer: { title: "Cyber Analyst" } });
    expect(byCompany["Sopra Steria"]).toMatchObject({ status: "interview_proposed", offer: { title: "Consultant GRC" } });
    const offers = await req<Offer[]>("GET", "/api/offers");
    expect(offers.find((o) => o.company === "Capgemini")?.source).toBe("gmail");
    expect(await req<MailReview[]>("GET", "/api/mail-reviews")).toEqual([]);

    // An old email read late does not undo progress when everything is accepted.
    mail("m6", "2026-09-01T09:00:00.000Z", "Thales Recrutement", "Accusé de réception", "Nous avons bien reçu votre candidature.");
    runner.script = async (call) => {
      const r = await call("propose_mail_reviews", { items: [{ mailId: "m6", action: "attach", applicationId: thales.id, status: "received", note: "Ancien accusé de réception." }] });
      expect((r as { result: { results: { note?: string }[] } }).result.results[0]!.note).toContain("reculer");
      return "ok";
    };
    await h.app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: "", task: "mail_review" } });
    expect((await req<MailReview[]>("GET", "/api/mail-reviews"))[0]).toMatchObject({ back: true });
    expect(await req("POST", "/api/mail-reviews/accept-all")).toMatchObject({ accepted: 0, left: 1 });
    expect((await req<Application>("GET", `/api/applications/${thales.id}`)).status).toBe("test_todo");
  });
});
