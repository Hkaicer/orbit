// The HTTP API used by the interface. Every route is local only (see app.ts).

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { StreamEvent } from "../shared/types";
import { KPI_KEYS, STATUSES } from "../shared/types";
import { type Agent, conversation } from "./ai/agent";
import { CALLBACK_PATH, ChatGptError, type ChatGptAuth } from "./ai/chatgptAuth";
import type { ClaudeRunner } from "./ai/claude";
import { detectService, type Providers } from "./ai/providers";
import type { AiVault } from "./ai/vault";
import type { AppConfig } from "./config";
import type { Database } from "./db/database";
import {
  addDeadline,
  addNote,
  confirmEvidence,
  createApplication,
  decideExternalAction,
  dismissEvidence,
  getApplicationDetail,
  listApplications,
  rowToMail,
  setDeadlineStatus,
  setMode,
  setStatus,
  updateApplication,
  zAppPatch,
  zDeadlineInput,
  zMode,
  zStatus,
} from "./domain/applications";
import { listEvents } from "./domain/history";
import { createOffer, getOffer, listOffers, resolveSimilar, saveAnalysis, setOfferStatus, updateOffer, zOfferInput, zOfferPatch } from "./domain/offers";
import { AppError } from "./errors";
import { log } from "./logger";
import { MailError } from "./mail/imap";
import type { Mailbox } from "./mail/mailbox";
import { folderFiles } from "./services/cvgen";
import { dashboard, kpiDetails } from "./services/dashboard";
import { performance } from "./services/performance";
import { documentText, findDocumentByPath, indexDocuments, listDocuments, setDocumentFlags } from "./services/documents";
import { exportCsv, exportXlsx } from "./services/exports";
import { fetchOfferPage, type FetchFn } from "./services/fetchOffer";
import { writeApplicationFolder } from "./services/folders";
import { importTrackingFile } from "./services/importers";
import { localAnalysis } from "./services/localScore";
import { loadSettings, saveSettings, zSettingsPatch } from "./services/settings";

export interface RouteDeps {
  db: Database;
  config: AppConfig;
  agent: Agent;
  claude: ClaudeRunner;
  providers: Providers;
  vault: AiVault;
  chatgptAuth: ChatGptAuth;
  mailbox: Mailbox;
  fetch: FetchFn;
  version: string;
}

const zId = z.object({ id: z.string().min(1).max(80) });

const mailError = (err: unknown) => (err instanceof MailError ? new AppError(err.code === "auth" ? "validation" : "unavailable", err.message) : err);

export function createBackup(db: Database, dataDir: string, kind: "manual" | "auto"): string {
  const name = `orbit-${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}.db`;
  db.backupTo(path.join(dataDir, "backups", name));
  return name;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, config, agent, claude, providers, vault, chatgptAuth, mailbox } = deps;
  const settings = () => loadSettings(db);

  // ---- general ---------------------------------------------------------------
  app.get("/api/health", async () => ({ ok: true, version: deps.version }));
  app.get("/api/bootstrap", async () => ({
    settings: settings(),
    version: deps.version,
    dataDir: config.dataDir,
    applicationsDir: config.applicationsDir,
    documents: Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM documents")?.n ?? 0),
    applications: Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM applications")?.n ?? 0),
    // The welcome screen: only on a new install, before any offer or application.
    firstRun: !settings().setupDone && !db.get("SELECT 1 AS x FROM offers LIMIT 1") && !db.get("SELECT 1 AS x FROM applications LIMIT 1") && !db.get("SELECT 1 AS x FROM messages LIMIT 1"),
  }));
  app.get("/api/ai/connectors", async (req) => {
    if (!claude.connectors) return { items: [], checkedAt: null };
    const force = (req.query as { force?: string }).force === "1";
    try {
      return { items: await claude.connectors(force), checkedAt: new Date().toISOString() };
    } catch (err) {
      throw new AppError("unavailable", err instanceof Error ? err.message : "Connecteurs illisibles.");
    }
  });
  app.get("/api/settings", async () => settings());
  app.patch("/api/settings", async (req) => {
    const patch = zSettingsPatch.parse(req.body);
    delete (patch as Record<string, unknown>).mailLastSyncAt;
    // Consent to a billed API key is given only when the key is saved.
    delete (patch as Record<string, unknown>).apiConsentAt;
    return saveSettings(db, patch);
  });
  app.get("/api/dashboard", async () => dashboard(db, settings().followupAfterDays));
  app.get("/api/performance", async (req) => {
    const days = z.object({ days: z.enum(["7", "30", "90", "all"]).default("7") }).parse(req.query).days;
    return performance(db, days === "all" ? null : Number(days));
  });
  app.get("/api/dashboard/:kpi", async (req) => kpiDetails(db, z.object({ kpi: z.enum(KPI_KEYS) }).parse(req.params).kpi, settings().followupAfterDays));
  app.get("/api/history", async (req) => {
    const q = z.object({ applicationId: z.string().optional(), offerId: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query);
    return listEvents(db, q);
  });

  // ---- offers ----------------------------------------------------------------
  app.get("/api/offers", async (req) => {
    const q = z.object({ status: z.enum(["new", "kept", "ignored", "all"]).optional(), q: z.string().max(200).optional(), minScore: z.coerce.number().int().optional() }).parse(req.query);
    return listOffers(db, q);
  });
  app.get("/api/offers/:id", async (req) => getOffer(db, zId.parse(req.params).id));
  app.post("/api/offers", async (req) => createOffer(db, zOfferInput.parse({ source: "manuel", ...(req.body as object) }), "user"));
  app.patch("/api/offers/:id", async (req) => updateOffer(db, zId.parse(req.params).id, zOfferPatch.parse(req.body), "user"));
  app.post("/api/offers/:id/status", async (req) => setOfferStatus(db, zId.parse(req.params).id, z.object({ status: z.enum(["new", "kept", "ignored"]) }).parse(req.body).status, "user"));
  app.post("/api/offers/:id/similar", async (req) => ({ offer: resolveSimilar(db, zId.parse(req.params).id, z.object({ decision: z.enum(["distinct", "merge"]) }).parse(req.body).decision) }));
  app.post("/api/offers/:id/local-score", async (req) => {
    const o = getOffer(db, zId.parse(req.params).id);
    if (o.analysis && o.analysis.by === "claude") throw new AppError("conflict", "Cette offre a déjà une analyse de Claude : l'estimation locale ne la remplace pas.");
    return saveAnalysis(db, o.id, localAnalysis(db, `${o.title}\n${o.description}`), "system");
  });
  /** An offer from its link: structured data is used directly, otherwise the page text is returned for Claude or for the user. */
  app.post("/api/offers/from-url", async (req) => {
    const { url } = z.object({ url: z.string().url().max(2000) }).parse(req.body);
    const page = await fetchOfferPage(url, deps.fetch);
    if (!page.ok) return { status: page.reason === "not_found" ? "not_found" : "needs_text", message: page.message };
    if (page.posting?.company && page.posting.title) {
      const r = createOffer(
        db,
        {
          ...page.posting,
          company: page.posting.company,
          title: page.posting.title,
          url: page.url,
          source: `lien (${new URL(page.url).hostname.replace(/^www\./, "")})`,
          description: page.posting.description ?? page.text,
        },
        "user",
      );
      return { status: r.created ? "created" : "known", offer: r.offer, changes: r.changes };
    }
    return {
      status: "needs_ai",
      title: page.title,
      text: page.text.slice(0, 20_000),
      url: page.url,
      message: "La page a été lue mais ne donne pas les champs de l'offre : demandez à Claude de créer la fiche à partir de ce texte, ou remplissez-la.",
    };
  });
  app.post("/api/offers/:id/application", async (req) => {
    const body = z.object({ mode: zMode.optional() }).parse(req.body ?? {});
    const fallback = settings().defaultMode;
    return createApplication(db, zId.parse(req.params).id, { actor: "user", mode: body.mode ?? (fallback === "auto" ? "B" : fallback) });
  });

  // ---- applications ----------------------------------------------------------
  app.get("/api/applications", async (req) => listApplications(db, z.object({ status: zStatus.optional(), q: z.string().max(200).optional() }).parse(req.query)));
  app.get("/api/applications/:id", async (req) => {
    const detail = getApplicationDetail(db, zId.parse(req.params).id);
    return { ...detail, files: folderFiles(detail.folder) };
  });
  app.patch("/api/applications/:id", async (req) => updateApplication(db, zId.parse(req.params).id, zAppPatch.parse(req.body), "user"));
  app.post("/api/applications/:id/status", async (req) => {
    const b = z.object({ status: z.enum(STATUSES), note: z.string().max(500).optional() }).parse(req.body);
    return setStatus(db, zId.parse(req.params).id, b.status, { actor: "user", note: b.note });
  });
  app.post("/api/applications/:id/mode", async (req) => setMode(db, zId.parse(req.params).id, zMode.parse((req.body as { mode?: string })?.mode), "user"));
  app.post("/api/applications/:id/notes", async (req) => {
    addNote(db, zId.parse(req.params).id, z.object({ text: z.string().trim().min(1).max(500) }).parse(req.body).text, "user");
    return { ok: true };
  });
  app.post("/api/applications/:id/deadlines", async (req) => addDeadline(db, zId.parse(req.params).id, zDeadlineInput.parse(req.body), "user"));
  app.post("/api/deadlines/:id", async (req) => setDeadlineStatus(db, zId.parse(req.params).id, z.object({ status: z.enum(["todo", "done", "cancelled"]) }).parse(req.body).status, "user"));
  app.post("/api/applications/:id/folder", async (req) => writeApplicationFolder(db, config.applicationsDir, zId.parse(req.params).id, "user"));
  app.post("/api/evidence/:id/confirm", async (req) => confirmEvidence(db, zId.parse(req.params).id, { status: z.object({ status: zStatus.optional() }).parse(req.body ?? {}).status }));
  app.post("/api/evidence/:id/dismiss", async (req) => {
    dismissEvidence(db, zId.parse(req.params).id);
    return { ok: true };
  });
  app.post("/api/actions/:id", async (req) => decideExternalAction(db, zId.parse(req.params).id, z.object({ decision: z.enum(["approved", "rejected", "done"]) }).parse(req.body).decision));

  /** Open a local file or folder in Explorer: only documents, application folders and ORBIT's own folders. */
  app.post("/api/open", async (req) => {
    const target = path.resolve(z.object({ path: z.string().min(3).max(1000) }).parse(req.body).path);
    const s = settings();
    const allowedRoots = [config.applicationsDir, config.dataDir, ...s.documentRoots].map((r) => path.resolve(r).toLowerCase());
    const known =
      allowedRoots.some((r) => target.toLowerCase() === r || target.toLowerCase().startsWith(r + path.sep)) ||
      Boolean(db.get("SELECT 1 AS x FROM applications WHERE folder = ? OR source_folder = ? OR cv_path = ? OR letter_path = ?", target, target, target, target));
    if (!known) throw new AppError("forbidden", "Ce chemin n'appartient pas à ORBIT ni à vos dossiers de documents.");
    if (!fs.existsSync(target)) throw new AppError("not_found", "Ce fichier ou dossier n'existe plus.");
    const isDir = fs.statSync(target).isDirectory();
    execFile("explorer.exe", isDir ? [target] : [`/select,${target}`], { windowsHide: false }, () => undefined);
    return { opened: target };
  });

  /** Download a file ORBIT made (CV, letter, folder files): only inside its Applications directory. */
  app.get("/api/files/download", async (req, reply) => {
    const target = path.resolve(z.object({ path: z.string().min(3).max(1000) }).parse(req.query).path);
    const root = path.resolve(config.applicationsDir);
    if (!target.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new AppError("forbidden", "Seuls les fichiers créés par ORBIT peuvent être téléchargés ici.");
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new AppError("not_found", "Ce fichier n'existe plus.");
    const name = path.basename(target);
    const types: Record<string, string> = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".md": "text/markdown; charset=utf-8" };
    const ascii = name
      .normalize("NFD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/"/g, "");
    return reply
      .header("content-type", types[path.extname(name).toLowerCase()] ?? "application/octet-stream")
      .header("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(fs.readFileSync(target));
  });

  // ---- documents and import --------------------------------------------------
  app.get("/api/documents", async (req) =>
    listDocuments(db, z.object({ kind: z.enum(["cv", "letter", "offer", "generator", "tracking", "other"]).optional(), q: z.string().max(200).optional() }).parse(req.query)),
  );
  app.get("/api/documents/:id/text", async (req) => ({ text: documentText(db, zId.parse(req.params).id, false) }));
  app.patch("/api/documents/:id", async (req) => setDocumentFlags(db, zId.parse(req.params).id, z.object({ validated: z.boolean().optional(), private: z.boolean().optional() }).parse(req.body)));
  app.post("/api/documents/reindex", async () => {
    const s = settings();
    return indexDocuments(db, s.documentRoots, s.privatePatterns);
  });
  app.post("/api/import", async () => {
    const s = settings();
    const findCv = (name: string) => findDocumentByPath(db, name)?.path ?? null;
    return s.trackingFiles.map((f) => importTrackingFile(db, f, findCv));
  });

  // ---- Gmail (read only) -----------------------------------------------------
  app.get("/api/gmail/status", async () => mailbox.status(settings().mailLastSyncAt));
  app.post("/api/gmail/connect", async (req) => {
    const b = z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(100) }).parse(req.body);
    try {
      await mailbox.connect(b.email, b.password);
    } catch (err) {
      log.warn("gmail connection failed", { code: err instanceof MailError ? err.code : "unknown" });
      throw mailError(err);
    }
    log.info("gmail connected");
    return mailbox.status(settings().mailLastSyncAt);
  });
  app.post("/api/gmail/disconnect", async () => {
    mailbox.disconnect();
    log.info("gmail disconnected");
    return mailbox.status(null);
  });
  app.post("/api/gmail/sync", async () => {
    try {
      const s = settings();
      const r = await mailbox.sync(db, s.mailLookbackDays, { keywords: s.alertKeywords, exclude: s.alertExclude });
      saveSettings(db, { mailLastSyncAt: new Date().toISOString() });
      return r;
    } catch (err) {
      throw mailError(err);
    }
  });
  app.get("/api/mails", async (req) => {
    const q = z.object({ q: z.string().max(200).optional(), unassigned: z.enum(["1"]).optional() }).parse(req.query);
    const where: string[] = [];
    const params: string[] = [];
    if (q.unassigned) where.push("application_id IS NULL AND category NOT IN ('other', 'alert')");
    if (q.q?.trim()) {
      where.push("(subject LIKE ? OR snippet LIKE ? OR from_name LIKE ? OR from_address LIKE ?)");
      const like = `%${q.q.trim()}%`;
      params.push(like, like, like, like);
    }
    return db.all(`SELECT * FROM mails ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY date DESC LIMIT 300`, ...params).map(rowToMail);
  });
  app.post("/api/mails/:id/attach", async (req) => {
    try {
      mailbox.attach(db, zId.parse(req.params).id, z.object({ applicationId: z.string().min(1) }).parse(req.body).applicationId);
    } catch (err) {
      throw mailError(err);
    }
    return { ok: true };
  });

  // ---- exports and backups ---------------------------------------------------
  app.get("/api/export.csv", async (_req, reply) =>
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="suivi-candidatures.csv"`).send(exportCsv(db)),
  );
  app.get("/api/export.xlsx", async (_req, reply) =>
    reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="suivi-candidatures.xlsx"`)
      .send(await exportXlsx(db)),
  );
  app.post("/api/backups", async () => ({ name: createBackup(db, config.dataDir, "manual") }));
  app.get("/api/backups", async () => {
    const dir = path.join(config.dataDir, "backups");
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".db"))
          .sort()
          .reverse()
          .map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size }))
      : [];
  });

  // ---- assistant -------------------------------------------------------------
  app.get("/api/ai/status", async (req) => providers.status(settings(), z.object({ force: z.enum(["0", "1"]).optional() }).parse(req.query).force === "1"));
  app.get("/api/ai/providers", async () => providers.overview(settings()));
  app.get("/api/ai/models", async () => providers.models(settings()));

  // An API key: recognized from its form, checked with a free call, kept encrypted, used only after consent.
  app.post("/api/ai/key", async (req) => {
    const body = z.object({ key: z.string().min(20).max(400), consent: z.literal(true) }).parse(req.body);
    const key = body.key.trim();
    const service = detectService(key);
    if (service === "subscription_token") throw new AppError("validation", "C'est un jeton d'abonnement Claude, pas une clé d'API. Pour l'abonnement, choisissez « Abonnement Claude ».");
    if (!service) throw new AppError("validation", "Ce texte ne ressemble pas à une clé d'API Anthropic (sk-ant-...) ou OpenAI (sk-...).");
    const check = await providers.verifyKey(service, key);
    if (check === "rejected") throw new AppError("validation", `${service === "anthropic" ? "Anthropic" : "OpenAI"} a refusé cette clé.`);
    if (check === "unreachable") throw new AppError("unavailable", "La clé n'a pas pu être vérifiée : le service est injoignable. Réessayez.");
    await vault.ready();
    vault.update((s) => ({ ...s, apiKey: { service, key } }));
    await vault.flush();
    saveSettings(db, { provider: "api", apiConsentAt: new Date().toISOString() });
    log.info("api key saved", { service });
    return { service };
  });
  app.delete("/api/ai/key", async () => {
    await vault.ready();
    vault.update(({ apiKey: _removed, ...rest }) => rest);
    await vault.flush();
    const s = settings();
    saveSettings(db, { apiConsentAt: null, ...(s.provider === "api" ? { provider: "claude" as const } : {}) });
    return { removed: true };
  });

  // Sign in with ChatGPT: OpenAI's page in the browser, then back here.
  app.post("/api/ai/chatgpt/login", async () => {
    await vault.ready();
    return { url: chatgptAuth.startLogin(`http://127.0.0.1:${config.port}`) };
  });
  app.get(CALLBACK_PATH, async (req, reply) => {
    try {
      await vault.ready();
      const { account } = await chatgptAuth.finishLogin(req.query as Record<string, string | undefined>);
      if (account.planUsage) saveSettings(db, { provider: "chatgpt" });
      log.info("chatgpt signed in", { planUsage: account.planUsage });
      return reply.redirect("/#/reglages/assistant");
    } catch (err) {
      log.warn("chatgpt sign-in failed", { code: err instanceof ChatGptError ? err.code : "unknown" });
      const message = err instanceof ChatGptError ? err.message : "La connexion à ChatGPT a échoué.";
      return reply.redirect(`/#/reglages/assistant?erreur=${encodeURIComponent(message)}`);
    }
  });
  app.post("/api/ai/chatgpt/logout", async () => {
    const r = await chatgptAuth.signOut();
    await vault.flush();
    if (settings().provider === "chatgpt") saveSettings(db, { provider: "claude" });
    return r;
  });
  app.get("/api/ai/conversation", async () => ({ ...conversation(db), busy: agent.busy }));
  app.delete("/api/ai/conversation", async () => {
    agent.clear();
    return { ok: true };
  });
  app.post("/api/ai/cancel", async () => ({ cancelled: agent.cancel() }));
  app.post("/api/ai/chat", async (req, reply) => {
    const body = z
      .object({ message: z.string().max(60_000), mode: z.enum(["auto", "A", "B", "C"]).optional(), model: z.enum(["haiku", "sonnet", "opus"]).optional(), task: z.enum(["discovery"]).optional() })
      .parse(req.body);
    if (agent.busy) throw new AppError("conflict", "ORBIT traite encore la demande précédente.");
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
    const send = (e: StreamEvent) => {
      if (!reply.raw.writableEnded) reply.raw.write(JSON.stringify(e) + "\n");
    };
    try {
      await agent.chat({ message: body.message, mode: body.mode, model: body.model, task: body.task }, send);
    } catch (err) {
      reply.raw.write(JSON.stringify({ type: "fatal", message: err instanceof AppError ? err.message : "Une erreur est survenue. Vos données n'ont pas été modifiées." }) + "\n");
    } finally {
      reply.raw.end();
    }
  });
  app.post("/api/proposals/:id/apply", async (req) => agent.applyProposal(zId.parse(req.params).id));
  app.post("/api/proposals/:id/discard", async (req) => {
    agent.discardProposal(zId.parse(req.params).id);
    return { ok: true };
  });
}
