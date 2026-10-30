// Images sent to the assistant, and links of emails opened read only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage, RunnerStatus, StreamEvent } from "../shared/types";
import { createApp, type AppHandle } from "../server/app";
import type { AssistantRunner, RunRequest } from "../server/ai/runner";
import { loadConfig } from "../server/config";
import { noProtection } from "../server/mail/dpapi";
import { emailLinks, LinkRefused, openLink } from "../server/services/openLink";

const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/html", ...headers } });

/** Pages of a test platform, as seen from ORBIT. */
const site = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url === "https://click.maki.test/ls/abc") return new Response(null, { status: 302, headers: { location: "https://app.maki.test/results/r-42" } });
  if (url === "https://app.maki.test/results/r-42") return html("<html><title>Vos résultats</title><body><h1>Résultats</h1><p>Raisonnement logique : 82e centile</p></body></html>");
  if (url === "https://click.maki.test/ls/def") return new Response(null, { status: 302, headers: { location: "https://app.maki.test/unsubscribe?u=1" } });
  if (url === "https://app.maki.test/score-card/x") return html('<html><body><noscript>Please enable JavaScript to use this app.</noscript><div id="root"></div></body></html>');
  if (url === "https://app.maki.test/private") return html('<html><title>Connexion</title><form><input type="password"></form></html>');
  return html("not found", 404);
}) as typeof fetch;

describe("links of emails", () => {
  it("opens a result page through its tracking link, and never a link that acts", async () => {
    const page = await openLink(site, "https://click.maki.test/ls/abc");
    expect(page).toMatchObject({ url: "https://app.maki.test/results/r-42", status: 200, title: "Vos résultats", loginRequired: false });
    expect(page.text).toContain("82e centile");

    // Unsubscribing, confirming or signing in: refused, even behind a redirect.
    await expect(openLink(site, "https://app.maki.test/unsubscribe?u=1")).rejects.toBeInstanceOf(LinkRefused);
    await expect(openLink(site, "https://click.maki.test/ls/def")).rejects.toThrow("action");
    await expect(openLink(site, "https://app.maki.test/interview/confirm?slot=3")).rejects.toThrow("action");
    await expect(openLink(site, "https://auth.maki.test/magic-link?t=x")).rejects.toThrow("action");
    // Nothing on this computer or the local network.
    await expect(openLink(site, "http://127.0.0.1:4320/api/settings")).rejects.toThrow("publics");
    await expect(openLink(site, "http://192.168.1.10/")).rejects.toThrow("publics");
    // A score card built by JavaScript is shown by the invisible browser, and only then.
    const shown: string[] = [];
    const render = async (u: string) => {
      shown.push(u);
      return "<html><body><h1>Votre score 76%</h1><p>Résolution de problèmes 80%</p></body></html>";
    };
    const card = await openLink(site, "https://app.maki.test/score-card/x", { render });
    expect(card).toMatchObject({ rendered: true, loginRequired: false });
    expect(card.text).toContain("76%");
    await openLink(site, "https://click.maki.test/ls/abc", { render });
    expect(shown).toEqual(["https://app.maki.test/score-card/x"]);
    // A page that asks to sign in is reported as such.
    expect((await openLink(site, "https://app.maki.test/private")).loginRequired).toBe(true);

    const links = emailLinks(
      '<p>Bonjour</p><a href="https://click.maki.test/ls/abc">Voir mes résultats</a> <a href="https://app.maki.test/unsubscribe?u=1">Se désabonner</a> <a href="mailto:x@y.z">écrire</a>',
      null,
    );
    expect(links).toEqual([
      { text: "Voir mes résultats", url: "https://click.maki.test/ls/abc", acts: false },
      { text: "Se désabonner", url: "https://app.maki.test/unsubscribe?u=1", acts: true },
    ]);
  });
});

class RecordingRunner implements AssistantRunner {
  requests: RunRequest[] = [];
  async status(): Promise<RunnerStatus> {
    return { state: "ready", message: "ok", plan: "test", version: "test" };
  }
  async run(req: RunRequest) {
    this.requests.push(req);
    return { text: "Je vois une capture d'écran.", model: "test" };
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

describe("images in the assistant", () => {
  it("sends attached images to the AI, keeps them with the conversation, and removes them when it is cleared", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-img-"));
    dirs.push(base);
    const runner = new RecordingRunner();
    const h = await createApp({
      config: { ...loadConfig(), dataDir: path.join(base, "data"), applicationsDir: path.join(base, "Applications"), webDir: path.join(base, "no-web") },
      claude: runner,
      secretsFile: null,
      protector: noProtection,
    });
    handles.push(h);
    // A 1x1 PNG.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const res = await h.app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: "", mode: "B", images: [{ mediaType: "image/png", data: png }] } });
    const events = res.body
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as StreamEvent);
    expect(events.at(-1)?.type).toBe("done");

    expect(runner.requests[0]!.images).toEqual([{ mediaType: "image/png", data: png }]);
    expect(runner.requests[0]!.prompt).toContain("1 image jointe à ce message");
    const user = (events[0] as { message: ChatMessage }).message;
    expect(user.content).toBe("Voici une image.");
    const file = user.meta.images![0]!.file;
    const served = await h.app.inject({ method: "GET", url: `/api/ai/images/${file}` });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    // Only ORBIT's own image files are served.
    expect((await h.app.inject({ method: "GET", url: "/api/ai/images/..%2F..%2Fsecrets.json" })).statusCode).toBe(404);
    // Wrong format, or too many images: refused.
    expect((await h.app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: "x", images: [{ mediaType: "image/svg+xml", data: png }] } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: "x", images: Array(5).fill({ mediaType: "image/png", data: png }) } })).statusCode).toBe(400);

    await h.app.inject({ method: "DELETE", url: "/api/ai/conversation" });
    expect((await h.app.inject({ method: "GET", url: `/api/ai/images/${file}` })).statusCode).toBe(404);
  });
});
