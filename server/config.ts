import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(ROOT_DIR, ".env");
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // A malformed .env must not prevent the app from starting.
  }
}

/** ORBIT_ variables, or their former AURAJOBS_ names. */
export const env = (key: string): string | undefined => process.env[`ORBIT_${key}`] ?? process.env[`AURAJOBS_${key}`];

/** The database file: orbit.db, or aurajobs.db for data made before the name changed. */
export function dbPath(dataDir: string): string {
  const legacy = path.join(dataDir, "aurajobs.db");
  const current = path.join(dataDir, "orbit.db");
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Where ORBIT writes the folder of each application. */
  applicationsDir: string;
  webDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: env("HOST") ?? "127.0.0.1",
    port: int(env("PORT"), 4320),
    dataDir: path.resolve(ROOT_DIR, env("DATA_DIR") ?? "data"),
    applicationsDir: path.resolve(ROOT_DIR, env("APPLICATIONS_DIR") ?? "Applications"),
    webDir: path.join(ROOT_DIR, "dist", "web"),
    logLevel: (env("LOG_LEVEL") as AppConfig["logLevel"]) ?? "info",
    ...overrides,
  };
}
