// Gmail over IMAP, read only.
//
// An app password would technically allow everything on the mailbox. ORBIT
// restricts itself in code: "All Mail" is always opened with EXAMINE (read
// only, the server then changes no flag, not even "read"), messages are only
// searched and downloaded, and there is no command here that writes, moves,
// deletes or sends. SMTP is never used.

import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";

export class MailError extends Error {
  constructor(
    readonly code: "auth" | "network" | "not_connected" | "gmail",
    message: string,
  ) {
    super(message);
    this.name = "MailError";
  }
}

/** One email as read from the mailbox. */
export interface RawMail {
  /** Gmail's message id (X-GM-MSGID). */
  id: string;
  /** Gmail's conversation id (X-GM-THRID), in decimal. */
  threadId: string;
  date: Date;
  from: { name: string; address: string } | null;
  subject: string;
  text: string | null;
  html: string | null;
  attachments: string[];
}

/** What ORBIT needs from a mailbox, read only (Gmail over IMAP, or a stand-in in tests). */
export interface MailReader {
  verify(): Promise<void>;
  /** Ids of the emails matching a Gmail search, newest first. */
  search(query: string, max: number): Promise<string[]>;
  /** The emails with their text, in the order asked. Unknown ids are skipped. */
  read(ids: string[]): Promise<RawMail[]>;
}

export function imapError(err: unknown): MailError {
  if (err instanceof MailError) return err;
  const e = err as { authenticationFailed?: boolean; code?: string; message?: string };
  if (e.authenticationFailed) return new MailError("auth", "Gmail refuse cette adresse ou ce mot de passe d'application. Vérifiez-les, ou créez un nouveau mot de passe d'application.");
  if (e.code && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(e.code)) return new MailError("network", "Gmail est injoignable. Vérifiez la connexion internet.");
  return new MailError("gmail", `Gmail n'a pas pu être lu (${(e.message ?? "erreur inconnue").slice(0, 120)}).`);
}

function partsOf(node: MessageStructureObject | undefined): { plain: string | null; html: string | null; attachments: string[] } {
  const found = { plain: null as string | null, html: null as string | null, attachments: [] as string[] };
  const walk = (n: MessageStructureObject, root: boolean) => {
    if (n.childNodes?.length) {
      for (const c of n.childNodes) walk(c, false);
      return;
    }
    const filename = n.dispositionParameters?.filename ?? n.parameters?.name;
    if (n.disposition === "attachment" || (filename && !n.type.startsWith("text/"))) {
      found.attachments.push(filename ?? n.type);
      return;
    }
    // A message with a single part has its body in part "1".
    const part = n.part ?? (root ? "1" : null);
    if (!part) return;
    if (n.type === "text/plain" && !found.plain) found.plain = part;
    else if (n.type === "text/html" && !found.html) found.html = part;
  };
  if (node) walk(node, true);
  return found;
}

async function download(c: ImapFlow, uid: number, part: string): Promise<string | null> {
  const d = await c.download(String(uid), part, { uid: true, maxBytes: 300_000 });
  if (!d.content) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of d.content) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export class GmailReader implements MailReader {
  constructor(private readonly account: { email: string; password: string }) {}

  /** One connection, "All Mail" opened read only, then logout. */
  private async session<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: this.account.email, pass: this.account.password }, logger: false });
    client.on("error", () => undefined);
    try {
      await client.connect();
      const all = (await client.list()).find((m) => m.specialUse === "\\All")?.path ?? "[Gmail]/All Mail";
      const lock = await client.getMailboxLock(all, { readOnly: true });
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } catch (err) {
      throw imapError(err);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  verify() {
    return this.session(async () => undefined);
  }

  search(query: string, max: number) {
    return this.session(async (c) => {
      const uids = ((await c.search({ gmraw: query }, { uid: true })) || []).slice(-max);
      if (uids.length === 0) return [];
      const found: { id: string; at: number }[] = [];
      for await (const m of c.fetch(uids.join(","), { uid: true, emailId: true, internalDate: true }, { uid: true })) {
        if (m.emailId) found.push({ id: m.emailId, at: new Date(m.internalDate ?? 0).getTime() });
      }
      return found.sort((a, b) => b.at - a.at).map((f) => f.id);
    });
  }

  read(ids: string[]) {
    return this.session(async (c) => {
      if (ids.length === 0) return [];
      const uids = (await c.search(ids.length === 1 ? { emailId: ids[0] } : { or: ids.map((id) => ({ emailId: id })) }, { uid: true })) || [];
      if (uids.length === 0) return [];
      // No other command may run while a FETCH is being read: collect first, download after.
      const metas: FetchMessageObject[] = [];
      for await (const m of c.fetch(uids.join(","), { uid: true, emailId: true, threadId: true, envelope: true, bodyStructure: true, internalDate: true }, { uid: true })) metas.push(m);
      const mails: RawMail[] = [];
      for (const m of metas) {
        const parts = partsOf(m.bodyStructure);
        const text = parts.plain ? await download(c, m.uid, parts.plain) : null;
        const html = !text && parts.html ? await download(c, m.uid, parts.html) : null;
        const from = m.envelope?.from?.[0];
        mails.push({
          id: m.emailId ?? String(m.uid),
          threadId: m.threadId ?? m.emailId ?? String(m.uid),
          date: new Date(m.internalDate ?? m.envelope?.date ?? Date.now()),
          from: from ? { name: from.name ?? "", address: from.address ?? "" } : null,
          subject: m.envelope?.subject ?? "",
          text,
          html,
          attachments: parts.attachments,
        });
      }
      return ids.map((id) => mails.find((m) => m.id === id)).filter((m): m is RawMail => Boolean(m));
    });
  }
}
