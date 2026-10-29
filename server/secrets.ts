// Secrets kept on this computer, in their own file next to the database (never
// in the database, the backups, the exports or the logs). The Gmail app
// password is stored encrypted with Windows DPAPI.

import fs from "node:fs";
import path from "node:path";

export interface Secrets {
  gmail?: {
    email: string;
    /** The app password, encrypted (DPAPI, base64). */
    password: string;
    protectedBy: "dpapi" | "none";
    connectedAt: string;
  };
}

export class SecretStore {
  private memory: Secrets = {};

  /** `file` null keeps everything in memory (tests). */
  constructor(private readonly file: string | null) {}

  read(): Secrets {
    if (!this.file) return structuredClone(this.memory);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Secrets) : {};
    } catch {
      return {};
    }
  }

  update(fn: (current: Secrets) => Secrets): Secrets {
    const next = fn(this.read());
    if (!this.file) {
      this.memory = structuredClone(next);
      return next;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return next;
  }
}
