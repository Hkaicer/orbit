import fs from "node:fs";
import path from "node:path";
import { createApp, VERSION } from "./app";
import { dbPath, env, loadConfig } from "./config";
import { configureLogger, log } from "./logger";
import { idleClock } from "./idleClock";
import { createBackup } from "./routes";
import { findDocumentByPath, indexDocuments } from "./services/documents";
import { importTrackingFile } from "./services/importers";
import { loadSettings, saveSettings } from "./services/settings";

const IDLE_TICK_MS = 30_000;

async function main() {
  const config = loadConfig();
  configureLogger({ level: config.logLevel, dir: path.join(config.dataDir, "logs") });
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host)) {
    console.error(`[orbit] Refus d'écouter sur ${config.host} : ORBIT n'a pas de connexion par mot de passe et reste sur cet ordinateur.`);
    process.exit(1);
  }
  const firstRun = !fs.existsSync(dbPath(config.dataDir));
  const { app, db, agent } = await createApp({ config });

  // Started by the shortcut: stop after a while without any request (the open
  // window sends a heartbeat every minute). Time spent asleep does not count.
  const idleMinutes = env("LAUNCHED_BY") === "app" ? Number(env("IDLE_EXIT_MIN") ?? 20) : 0;
  const idle = idleClock(2 * IDLE_TICK_MS);
  if (idleMinutes > 0) {
    app.addHook("onRequest", async () => {
      idle.reset();
    });
  }

  if (firstRun) {
    // First launch: index the documents and import the existing tracking files, read only.
    const s = saveSettings(db, loadSettings(db));
    try {
      const idx = await indexDocuments(db, s.documentRoots, s.privatePatterns);
      log.info("first indexing", { indexed: idx.indexed });
      for (const f of s.trackingFiles) {
        const r = importTrackingFile(db, f, (n) => findDocumentByPath(db, n)?.path ?? null);
        log.info("first import", { file: path.basename(f), created: r.offersCreated, missing: r.missing });
      }
    } catch (err) {
      log.warn("first import failed", { error: (err as Error).message });
    }
  } else {
    // A safety copy at each start, keeping the last 30.
    try {
      createBackup(db, config.dataDir, "auto");
      const dir = path.join(config.dataDir, "backups");
      const autos = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith("-auto.db"))
        .sort();
      for (const f of autos.slice(0, Math.max(0, autos.length - 30))) fs.rmSync(path.join(dir, f));
    } catch (err) {
      log.warn("startup backup failed", { error: (err as Error).message });
    }
  }

  await app.listen({ host: config.host, port: config.port });
  log.info(`ORBIT ${VERSION} is running at http://127.0.0.1:${config.port}`);
  const shutdown = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (idleMinutes > 0) {
    log.info(`will stop after ${idleMinutes} min without activity`);
    setInterval(() => {
      if (idle.tick() > idleMinutes * 60_000 && !agent.busy) {
        log.info("no activity, stopping");
        void shutdown();
      }
    }, IDLE_TICK_MS).unref();
  }
}

main().catch((err) => {
  const e = err as NodeJS.ErrnoException;
  console.error(e.code === "EADDRINUSE" ? "[orbit] Le port est déjà utilisé : ORBIT tourne peut-être déjà (http://127.0.0.1:4320)." : `[orbit] Démarrage impossible : ${e.message}`);
  process.exit(1);
});
