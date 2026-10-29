// The AI services other than Claude Code: the ChatGPT plan (signed in with
// ChatGPT) and an API key. OpenAI is simulated: nothing leaves the computer.

import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AiProviders, AiStatus, RunnerStatus, StreamEvent } from "../shared/types";
import { createApp, type AppHandle } from "../server/app";
import { ChatGptAuth, type Fetch } from "../server/ai/chatgptAuth";
import { detectService } from "../server/ai/providers";
import type { AssistantRunner } from "../server/ai/runner";
import { AiVault } from "../server/ai/vault";
import { loadConfig } from "../server/config";
import { noProtection } from "../server/mail/dpapi";
import { SecretStore } from "../server/secrets";

const nowSec = () => Math.floor(Date.now() / 1000);

/** A stand-in for OpenAI: sign-in endpoints, published keys, the model list and the Responses API. */
function fakeOpenAI() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const calls: { url: string; body: string; auth: string }[] = [];
  const state = { nonce: "", refreshes: 0, revoked: false, responses: [] as string[] };
  const idToken = (aud: string) => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
    const body = enc({ iss: "https://auth.openai.com", aud, sub: "user-1", email: "camille@example.com", nonce: state.nonce, exp: nowSec() + 3600, iat: nowSec() });
    return `${head}.${body}.${sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  const fetchFn: Fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? String(init.body) : "";
    const headers = new Headers(init?.headers);
    calls.push({ url, body, auth: headers.get("authorization") ?? "" });
    if (url.endsWith("/.well-known/openid-configuration")) {
      return json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/.well-known/jwks.json", revocation_endpoint: "https://auth.openai.com/oauth/revoke" });
    }
    if (url.endsWith("/.well-known/jwks.json")) return json({ keys: [jwk] });
    if (url.endsWith("/oauth/token")) {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") {
        state.refreshes++;
        return json({ access_token: `at-${state.refreshes + 1}`, refresh_token: `rt-${state.refreshes + 1}`, expires_in: 3600, scope });
      }
      return json({ access_token: "at-1", refresh_token: "rt-1", id_token: idToken(form.get("client_id")!), expires_in: 3600, scope });
    }
    if (url.endsWith("/oauth/revoke")) {
      state.revoked = true;
      return new Response("", { status: 200 });
    }
    if (url.endsWith("/v1/models")) {
      return json({
        data: [
          { id: "gpt-test-1", slug: "gpt-test-1", display_name: "GPT Test", visibility: "list", created: 2 },
          { id: "hidden", slug: "hidden", visibility: "hide", created: 1 },
          { id: "text-embedding-test", slug: "text-embedding-test", created: 3 },
        ],
      });
    }
    if (url.endsWith("/v1/responses")) {
      const sse = state.responses.shift();
      if (!sse) return json({ error: { code: "unexpected", message: "no response queued" } }, 500);
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }
    return json({ error: "not found" }, 404);
  };
  return { fetchFn, calls, state };
}

const sse = (...events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** A tool call to ORBIT, then the final answer. */
function queueAnswer(openai: ReturnType<typeof fakeOpenAI>, answer: string) {
  openai.state.responses.push(
    sse(
      { type: "response.output_text.delta", delta: "Je regarde. " },
      { type: "response.completed", response: { model: "gpt-test-1", output: [{ type: "function_call", call_id: "call_1", name: "list_offers", arguments: "{}" }] } },
    ),
    sse(
      { type: "response.output_text.delta", delta: answer },
      { type: "response.completed", response: { model: "gpt-test-1", output: [{ type: "message", content: [{ type: "output_text", text: answer }] }] } },
    ),
  );
}

const authorizeParams = (url: string) => {
  const u = new URL(url);
  expect(u.origin + u.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
  return u.searchParams;
};

/** Claude Code is not used here: a stand-in that is never ready. */
const noClaude: AssistantRunner = {
  status: async (): Promise<RunnerStatus> => ({ state: "not_installed", message: "Claude Code n'est pas installé.", plan: null, version: null }),
  run: async () => {
    throw new Error("Claude Code ne doit pas servir ici.");
  },
};

const handles: AppHandle[] = [];
const dirs: string[] = [];

async function boot(openai: ReturnType<typeof fakeOpenAI>) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-ai-"));
  dirs.push(base);
  const secretsFile = path.join(base, "data", "secrets.json");
  const h = await createApp({
    config: { ...loadConfig(), dataDir: path.join(base, "data"), applicationsDir: path.join(base, "Applications"), webDir: path.join(base, "no-web") },
    claude: noClaude,
    secretsFile,
    protector: noProtection,
    aiFetch: openai.fetchFn,
    verifyKey: async (_service, key) => (key.includes("refusee") ? "rejected" : "ok"),
  });
  handles.push(h);
  return { h, secretsFile };
}

const chat = async (h: AppHandle, message: string) =>
  (await h.app.inject({ method: "POST", url: "/api/ai/chat", payload: { message, mode: "A" } })).body
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

describe("ChatGPT plan", () => {
  it("signs in through OpenAI's page, then answers with the plan and ORBIT's tools", async () => {
    const openai = fakeOpenAI();
    const { h, secretsFile } = await boot(openai);

    const { url } = (await h.app.inject({ method: "POST", url: "/api/ai/chatgpt/login", payload: {} })).json() as { url: string };
    const params = authorizeParams(url);
    expect(params.get("client_id")).toBe("dynamic_agent_client");
    expect(params.get("agent_name_hint")).toBe("ORBIT");
    expect(params.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/chatgpt\/callback$/);
    expect(params.get("code_challenge_method")).toBe("S256");
    openai.state.nonce = params.get("nonce")!;

    const back = await h.app.inject({ method: "GET", url: `/auth/chatgpt/callback?code=c1&state=${params.get("state")}&client_id=oaiapp_test` });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe("/#/reglages/assistant");
    const exchange = new URLSearchParams(openai.calls.find((c) => c.url.endsWith("/oauth/token"))!.body);
    expect(exchange.get("client_id")).toBe("oaiapp_test");
    expect(exchange.get("code_verifier")).toBeTruthy();

    const status = (await h.app.inject({ method: "GET", url: "/api/ai/status" })).json() as AiStatus;
    expect(status).toMatchObject({ provider: "chatgpt", assistant: "ChatGPT", family: "openai", state: "ready", model: "gpt-test-1" });
    expect(JSON.stringify(status)).not.toContain("at-1");
    expect(((await h.app.inject({ method: "GET", url: "/api/ai/providers" })).json() as AiProviders).chatgpt).toEqual({ email: "camille@example.com", planUsage: true });

    queueAnswer(openai, "Vous n'avez pas encore d'offre.");
    const events = await chat(h, "Quelles offres ai-je ?");
    const done = events.find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
    expect(done.message.content).toBe("Vous n'avez pas encore d'offre.");
    expect(done.message.meta).toMatchObject({ provider: "chatgpt", model: "gpt-test-1", tools: [{ name: "list_offers", ok: true }] });

    const requests = openai.calls.filter((c) => c.url.endsWith("/v1/responses"));
    expect(requests).toHaveLength(2);
    expect(requests[0]!.auth).toBe("Bearer at-1");
    const first = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(first).toMatchObject({ model: "gpt-test-1", store: false, stream: true });
    expect((first.tools as { name: string }[]).some((t) => t.name === "create_offer")).toBe(true);
    // Claude Code's connectors are not offered to other services.
    expect(JSON.stringify(first.tools)).not.toContain("mcp__");
    const followUp = JSON.parse(requests[1]!.body).input as { type?: string; call_id?: string }[];
    expect(followUp.find((i) => i.type === "function_call_output")).toMatchObject({ call_id: "call_1" });

    // The tokens are kept encrypted, never in clear in the secrets file or the database.
    await h.vault.flush();
    expect(fs.readFileSync(secretsFile, "utf8")).not.toMatch(/at-1|rt-1/);

    const out = await h.app.inject({ method: "POST", url: "/api/ai/chatgpt/logout", payload: {} });
    expect(out.json()).toEqual({ revoked: true });
    expect(openai.state.revoked).toBe(true);
    expect(((await h.app.inject({ method: "GET", url: "/api/ai/status" })).json() as AiStatus).provider).toBe("claude");
  });

  it("refreshes an expired access token and refuses a sign-in with a forged identity", async () => {
    const openai = fakeOpenAI();
    let now = Date.now();
    const vault = new AiVault(new SecretStore(null), noProtection);
    await vault.ready();
    const auth = new ChatGptAuth(vault, openai.fetchFn, () => now);

    const params = authorizeParams(auth.startLogin("http://127.0.0.1:4320"));
    openai.state.nonce = params.get("nonce")!;
    await auth.finishLogin({ code: "c1", state: params.get("state")!, client_id: "oaiapp_test" });
    expect(await auth.accessToken()).toBe("at-1");

    now += 2 * 3600_000;
    expect(await auth.accessToken()).toBe("at-2");
    const refresh = new URLSearchParams(openai.calls.filter((c) => c.url.endsWith("/oauth/token")).at(-1)!.body);
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("rt-1");

    const again = authorizeParams(auth.startLogin("http://127.0.0.1:4320"));
    openai.state.nonce = "pas-le-bon";
    await expect(auth.finishLogin({ code: "c2", state: again.get("state")! })).rejects.toThrow("vérifier");
    await expect(auth.finishLogin({ code: "c3", state: "inconnu" })).rejects.toThrow("expiré");
  });
});

describe("API key", () => {
  it("recognizes the key, asks for consent, keeps it encrypted, and answers with ORBIT's tools", async () => {
    expect(detectService("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBe("anthropic");
    expect(detectService("sk-proj-abcdefghijklmnopqrstuvwxyz0123")).toBe("openai");
    expect(detectService("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz")).toBe("subscription_token");
    expect(detectService("bonjour")).toBeNull();

    const openai = fakeOpenAI();
    const { h, secretsFile } = await boot(openai);
    const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
    expect((await h.app.inject({ method: "POST", url: "/api/ai/key", payload: { key } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "POST", url: "/api/ai/key", payload: { key: "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz", consent: true } })).json().error.message).toContain("abonnement");
    expect((await h.app.inject({ method: "POST", url: "/api/ai/key", payload: { key: "sk-proj-refuseeabcdefghijklmnopqrstu", consent: true } })).statusCode).toBe(400);
    // Consent cannot be set through the settings.
    await h.app.inject({ method: "PATCH", url: "/api/settings", payload: { apiConsentAt: "2026-01-01T00:00:00Z" } });
    expect((await h.app.inject({ method: "GET", url: "/api/settings" })).json().apiConsentAt).toBeNull();

    expect((await h.app.inject({ method: "POST", url: "/api/ai/key", payload: { key, consent: true } })).json()).toEqual({ service: "openai" });
    const status = (await h.app.inject({ method: "GET", url: "/api/ai/status" })).json() as AiStatus;
    expect(status).toMatchObject({ provider: "api", assistant: "GPT", family: "openai", state: "ready", model: "gpt-test-1" });
    expect(status.models).toEqual([{ id: "gpt-test-1", label: "gpt-test-1" }]);
    expect(fs.readFileSync(secretsFile, "utf8")).not.toContain(key);

    queueAnswer(openai, "Aucune offre pour le moment.");
    const done = (await chat(h, "Mes offres ?")).find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
    expect(done.message.meta).toMatchObject({ provider: "api", model: "gpt-test-1" });
    expect(openai.calls.filter((c) => c.url.endsWith("/v1/responses")).every((c) => c.auth === `Bearer ${key}`)).toBe(true);

    await h.app.inject({ method: "DELETE", url: "/api/ai/key" });
    const after = (await h.app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(after).toMatchObject({ provider: "claude", apiConsentAt: null });
    expect(((await h.app.inject({ method: "GET", url: "/api/ai/providers" })).json() as AiProviders).apiKey).toBeNull();
  });
});
