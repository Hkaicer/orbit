import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { Agent } from "./ai/agent";
import { ClaudeCli, type ClaudeRunner } from "./ai/claude";
import { registerMcp } from "./ai/mcp";
import { dbPath, type AppConfig } from "./config";
import { Database } from "./db/database";
import { errorReply } from "./errors";
import type { Protector } from "./mail/dpapi";
import { Mailbox, type MakeReader } from "./mail/mailbox";
import { registerRoutes } from "./routes";
import { SecretStore } from "./secrets";
import type { FetchFn } from "./services/fetchOffer";
import { loadSettings } from "./services/settings";

export const VERSION = "0.1.0";

export interface AppOptions {
  config: AppConfig;
  db?: Database;
  /** Claude Code by default; a stand-in in tests. */
  claude?: ClaudeRunner;
  /** Secrets file; null keeps them in memory (tests). */
  secretsFile?: string | null;
  protector?: Protector;
  mailReader?: MakeReader;
  fetch?: FetchFn;
}

export interface AppHandle {
  app: FastifyInstance;
  db: Database;
  agent: Agent;
  mailbox: Mailbox;
}

const LOCAL_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);

export async function createApp(opts: AppOptions): Promise<AppHandle> {
  const { config } = opts;
  const db = opts.db ?? new Database(dbPath(config.dataDir));
  db.migrate();
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  const secrets = new SecretStore(opts.secretsFile === undefined ? path.join(config.dataDir, "secrets.json") : opts.secretsFile);
  const mailbox = new Mailbox(secrets, opts.protector, opts.mailReader);
  const fetchFn = opts.fetch ?? fetch;
  const claude = opts.claude ?? new ClaudeCli(path.join(config.dataDir, "agent"), (token) => `http://127.0.0.1:${config.port}/mcp/${token}`, () => loadSettings(db).claudePath);
  const agent = new Agent(db, claude, () => ({ db, config, mailbox, fetch: fetchFn }));

  // Local only: requests addressed to this computer, and no state change coming from another website.
  app.addHook("onRequest", async (req, reply) => {
    const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    if (!LOCAL_NAMES.has(hostname)) return reply.code(403).send({ error: { code: "forbidden", message: "ORBIT n'accepte que les requêtes de cet ordinateur." } });
    const origin = req.headers.origin;
    if (origin && req.method !== "GET" && req.method !== "HEAD") {
      let host = "";
      try {
        host = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
      } catch {
        host = "";
      }
      if (!LOCAL_NAMES.has(host)) return reply.code(403).send({ error: { code: "forbidden", message: "Requêtes venant d'un autre site refusées." } });
    }
  });
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = errorReply(err);
    return reply.code(status).send(body);
  });

  registerMcp(app, agent, VERSION);
  registerRoutes(app, { db, config, agent, claude, mailbox, fetch: fetchFn, version: VERSION });

  const notFound = (url: string) => url.startsWith("/api") || url.startsWith("/mcp");
  if (fs.existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: config.webDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => (notFound(req.url) ? reply.code(404).send({ error: { code: "not_found", message: "Adresse inconnue." } }) : reply.sendFile("index.html")));
  } else {
    app.setNotFoundHandler((req, reply) =>
      notFound(req.url)
        ? reply.code(404).send({ error: { code: "not_found", message: "Adresse inconnue." } })
        : reply.type("text/html").send("<p style='font-family:sans-serif'>L'interface n'est pas encore construite : lancez <code>npm run build</code>.</p>"),
    );
  }
  return { app, db, agent, mailbox };
}
