// The secrets of the assistant and of the job search: an API key, the ChatGPT
// sign-in, the France Travail and Adzuna keys. They are kept in the secrets file
// next to the database, encrypted like the Gmail password (Windows DPAPI), and
// never go into the database, the backups, the exports or the logs. Decrypted
// once, then read from memory.

import type { ApiService } from "../../shared/types";
import type { SearchKeys } from "../search/collectors";
import { log } from "../logger";
import type { Protector } from "../mail/dpapi";
import type { SecretStore } from "../secrets";

/** A ChatGPT session: the tokens OpenAI issued after the user signed in. */
export interface ChatGptSession {
  accessToken: string;
  refreshToken: string | null;
  idToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
  sub: string;
  email: string | null;
}

export interface ChatGptRecord {
  /** Opaque identifier of this ORBIT install, chosen once and reused for every sign-in. */
  hostId: string;
  /** Issued by OpenAI at the first sign-in (oaiapp_...) and kept after signing out. */
  clientId: string | null;
  session: ChatGptSession | null;
}

export interface AiSecrets {
  apiKey?: { service: ApiService; key: string };
  chatgpt?: ChatGptRecord;
  /** France Travail and Adzuna, for the job search. */
  search?: SearchKeys;
}

export class AiVault {
  private cache: AiSecrets | null = null;
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: SecretStore,
    private readonly protector: Protector,
  ) {}

  /** Decrypts the secrets the first time. Every other method needs it done. */
  ready(): Promise<void> {
    if (this.cache) return Promise.resolve();
    this.loading ??= (async () => {
      const sealed = this.store.read().ai;
      try {
        this.cache = sealed ? (JSON.parse(await this.protector.unprotect(sealed.data)) as AiSecrets) : {};
      } catch {
        // Made on another computer or by another Windows account: the key and the sign-in must be entered again.
        log.warn("ai secrets unreadable, starting empty");
        this.cache = {};
      }
    })();
    return this.loading;
  }

  read(): AiSecrets {
    if (!this.cache) throw new Error("AI secrets read before they were loaded.");
    return structuredClone(this.cache);
  }

  /** Changes the secrets at once in memory, and encrypts them to disk in the background, one write at a time. */
  update(fn: (current: AiSecrets) => AiSecrets): AiSecrets {
    const next = fn(this.read());
    this.cache = structuredClone(next);
    this.writing = this.writing
      .then(async () => {
        const data = await this.protector.protect(JSON.stringify(this.cache));
        this.store.update((s) => ({ ...s, ai: { protectedBy: this.protector.name, data } }));
      })
      .catch((err: unknown) => log.error("ai secrets not saved", { error: (err as Error).message }));
    return next;
  }

  /** Waits for the last write (tests, shutdown). */
  flush(): Promise<void> {
    return this.writing;
  }
}
