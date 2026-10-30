// The user's Gmail as ORBIT uses it: connecting with an app password,
// reading recruiting emails to propose status updates with their proof, and
// reading one email on request. Read only throughout.

import type { GmailStatus, MailCategory } from "../../shared/types";
import type { Database } from "../db/database";
import { proposeStatus, rowToMail } from "../domain/applications";
import { addEvent } from "../domain/history";
import { companyKey, createOffer } from "../domain/offers";
import { log } from "../logger";
import type { SecretStore } from "../secrets";
import { ALERT_QUERY, alertSource, inSearch, parseAlert, type AlertJob } from "./alerts";
import { ATS_SENDERS, categorize, findDeadline, mailText, matchApplication, SUGGESTS, type Candidate } from "./classify";
import { dpapi, type Protector } from "./dpapi";
import { emailLinks } from "../services/openLink";
import { GmailReader, MailError, type MailReader, type RawMail } from "./imap";

export type MakeReader = (account: { email: string; password: string }) => MailReader;

/** The text of an email as shown to the AI: no links, no email addresses, no quoted reply. */
export function cleanForAi(text: string, max = 3000): string {
  let t = text.replace(/\r\n?/g, "\n");
  const quoted = /\n(On|Le) [^\n]{0,200}(\n[^\n]{0,60})?(wrote|a écrit)\s*:/.exec(t);
  if (quoted) t = t.slice(0, quoted.index);
  t = t
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join("\n")
    .replace(/(https?:\/\/|www\.)[^\s<>"')\]]+/gi, "[lien]")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[adresse]")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const mailLink = (threadId: string, account: string) => `https://mail.google.com/mail/u/${account}/#all/${/^\d+$/.test(threadId) ? BigInt(threadId).toString(16) : threadId}`;

export interface SyncResult {
  scanned: number;
  newMails: number;
  matched: number;
  proposals: number;
  unassigned: number;
  /** Jobs read in alert emails: new offers, offers already known, jobs outside the search. */
  alertOffers: number;
  alertKnown: number;
  alertSkipped: number;
}

export interface AlertFilter {
  keywords: string[];
  exclude: string[];
}

export class Mailbox {
  private account: { email: string; password: string } | null = null;

  constructor(
    private readonly secrets: SecretStore,
    private readonly protector: Protector = dpapi,
    private readonly makeReader: MakeReader = (a) => new GmailReader(a),
  ) {}

  status(lastSyncAt: string | null): GmailStatus {
    const g = this.secrets.read().gmail;
    return { email: g?.email ?? null, connectedAt: g?.connectedAt ?? null, lastSyncAt: g ? lastSyncAt : null, protectedBy: g?.protectedBy ?? "none" };
  }

  get connected(): boolean {
    return Boolean(this.secrets.read().gmail);
  }

  /** Check the address and app password with Gmail (read only), then keep the password encrypted. */
  async connect(email: string, appPassword: string): Promise<void> {
    const address = email.trim().toLowerCase();
    const password = appPassword.replace(/\s+/g, "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new MailError("auth", "Ce n'est pas une adresse e-mail.");
    if (!/^[a-z]{16}$/i.test(password)) throw new MailError("auth", "Un mot de passe d'application compte 16 lettres. Créez-en un dans votre compte Google, rubrique Sécurité.");
    await this.makeReader({ email: address, password }).verify();
    const stored = await this.protector.protect(password);
    this.secrets.update((s) => ({ ...s, gmail: { email: address, password: stored, protectedBy: this.protector.name, connectedAt: new Date().toISOString() } }));
    this.account = { email: address, password };
  }

  disconnect() {
    this.secrets.update(({ gmail: _removed, ...rest }) => rest);
    this.account = null;
  }

  private async reader(): Promise<{ reader: MailReader; email: string }> {
    const g = this.secrets.read().gmail;
    if (!g) throw new MailError("not_connected", "Gmail n'est pas connecté. Connectez-le dans Réglages > Gmail.");
    if (!this.account || this.account.email !== g.email) this.account = { email: g.email, password: await this.protector.unprotect(g.password) };
    return { reader: this.makeReader(this.account), email: g.email };
  }

  /**
   * Read the recruiting emails of the last days and propose the status they
   * suggest, with the email as proof. Nothing is applied before the user confirms.
   */
  async sync(db: Database, lookbackDays: number, alerts: AlertFilter = { keywords: [], exclude: [] }): Promise<SyncResult> {
    const { reader, email } = await this.reader();
    const candidates = db.all<Candidate>("SELECT a.id, o.company, o.title, MIN(a.created_at, o.discovered_at) AS since FROM applications a JOIN offers o ON o.id = a.offer_id");
    const companies = [...new Set(candidates.map((c) => companyKey(c.company)).filter((k) => k.length >= 3))].slice(0, 40);
    const terms = [
      ALERT_QUERY,
      `from:(${ATS_SENDERS.join(" OR ")})`,
      "subject:(candidature OR application OR entretien OR interview OR assessment OR évaluation OR test OR offre OR stage OR internship)",
      ...companies.map((c) => `"${c}"`),
    ];
    const query = `newer_than:${lookbackDays}d -in:sent -in:chats (${terms.join(" OR ")})`;
    const ids = await reader.search(query, 300);
    const reclassified = this.reclassify(db);
    const known = new Map(db.all<{ id: string; from_address: string | null; alert_checked: number }>("SELECT id, from_address, alert_checked FROM mails").map((r) => [r.id, r]));
    const fresh = ids.filter((id) => !known.has(id));
    // Emails of alert senders read before alerts were understood: read once more for the jobs they list.
    const again = ids.filter((id) => {
      const r = known.get(id);
      return r && !r.alert_checked && alertSource(r.from_address);
    });
    const result: SyncResult = { scanned: ids.length, newMails: fresh.length, matched: 0, proposals: reclassified, unassigned: 0, alertOffers: 0, alertKnown: 0, alertSkipped: 0 };
    const todo = [...fresh, ...again];
    for (let i = 0; i < todo.length; i += 20) {
      const batch = await reader.read(todo.slice(i, i + 20));
      for (const m of batch) {
        const jobs = alertSource(m.from?.address) ? parseAlert(m) : [];
        if (jobs.length) this.fileAlert(db, m, email, jobs, alerts, result);
        else if (!known.has(m.id)) this.file(db, m, email, candidates, result);
        db.run("UPDATE mails SET alert_checked = 1 WHERE id = ?", m.id);
      }
    }
    log.info("gmail sync", { ...result });
    return result;
  }

  private file(db: Database, m: RawMail, account: string, candidates: Candidate[], result: SyncResult) {
    const category: MailCategory = categorize(m);
    const { applicationId, ambiguous } = matchApplication(m, candidates);
    const snippet = mailText(m).replace(/\s+/g, " ").trim().slice(0, 400);
    db.run(
      "INSERT OR IGNORE INTO mails (id, thread_id, date, from_name, from_address, subject, snippet, category, application_id, link, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      m.id,
      m.threadId,
      m.date.toISOString(),
      m.from?.name ?? null,
      m.from?.address ?? null,
      m.subject,
      snippet,
      category,
      applicationId,
      mailLink(m.threadId, account),
      new Date().toISOString(),
    );
    if (!applicationId) {
      if (ambiguous.length || category !== "other") result.unassigned++;
      return;
    }
    result.matched++;
    if (this.propose(db, m, category, applicationId, snippet)) result.proposals++;
  }

  /** A job alert: each job in the search becomes an offer (or a new source of a known one), with only its clean link. */
  private fileAlert(db: Database, m: RawMail, account: string, jobs: AlertJob[], filter: AlertFilter, result: SyncResult) {
    const kept = jobs.filter((j) => inSearch(j.title, filter.keywords, filter.exclude));
    result.alertSkipped += jobs.length - kept.length;
    db.run(
      `INSERT INTO mails (id, thread_id, date, from_name, from_address, subject, snippet, category, application_id, link, synced_at, alert_checked) VALUES (?, ?, ?, ?, ?, ?, ?, 'alert', NULL, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET category = 'alert', application_id = NULL, snippet = excluded.snippet, alert_checked = 1`,
      m.id,
      m.threadId,
      m.date.toISOString(),
      m.from?.name ?? null,
      m.from?.address ?? null,
      m.subject,
      `${jobs.length} offre${jobs.length > 1 ? "s" : ""}, ${kept.length} dans votre recherche : ${kept.map((j) => `${j.title} (${j.company})`).join(" · ")}`.slice(0, 400),
      mailLink(m.threadId, account),
      new Date().toISOString(),
    );
    for (const j of kept) {
      const r = createOffer(
        db,
        { company: j.company, title: j.title, location: j.location, url: j.url, source: `alerte ${j.source}`, description: j.snippet ?? "", discoveredAt: m.date.toISOString() },
        "system",
      );
      if (r.created) result.alertOffers++;
      else result.alertKnown++;
    }
  }

  /** Propose the status an email suggests, with the email as proof. Returns false when there is nothing new to propose. */
  private propose(db: Database, m: RawMail, category: MailCategory, applicationId: string, snippet: string): boolean {
    const suggests = SUGGESTS[category];
    const current = db.get<{ status: string }>("SELECT status FROM applications WHERE id = ?", applicationId)?.status;
    if (!suggests || suggests === current) return false;
    if (db.get("SELECT 1 AS x FROM evidence WHERE application_id = ? AND message_id = ?", applicationId, m.id)) return false;
    // Another email already waits with the same proposal: this one stays attached to the application, without a second card.
    if (db.get("SELECT 1 AS x FROM evidence WHERE application_id = ? AND suggests = ? AND confirmed = 0 AND dismissed = 0", applicationId, suggests)) return false;
    proposeStatus(
      db,
      applicationId,
      {
        kind: "email",
        messageId: m.id,
        mailDate: m.date.toISOString(),
        mailFrom: [m.from?.name, m.from?.address ? `<${m.from.address}>` : null].filter(Boolean).join(" "),
        mailSubject: m.subject.slice(0, 500),
        excerpt: snippet.slice(0, 600),
        suggests,
        dueAt: category === "test" || category === "interview" ? findDeadline(m) : null,
      },
      "gmail",
    );
    return true;
  }

  /**
   * Emails filed as "other" are read again with the current rules (subject and
   * beginning of the text, as kept), so that a rule added later also covers
   * them. A category is only ever made more precise, never undone.
   */
  reclassify(db: Database): number {
    let proposals = 0;
    const rows = db.all<{
      id: string;
      thread_id: string | null;
      date: string;
      from_name: string | null;
      from_address: string | null;
      subject: string | null;
      snippet: string | null;
      application_id: string | null;
    }>("SELECT id, thread_id, date, from_name, from_address, subject, snippet, application_id FROM mails WHERE category = 'other'");
    for (const r of rows) {
      const m: RawMail = {
        id: r.id,
        threadId: r.thread_id ?? r.id,
        date: new Date(r.date),
        from: r.from_address ? { name: r.from_name ?? "", address: r.from_address } : null,
        subject: r.subject ?? "",
        text: r.snippet ?? "",
        html: null,
        attachments: [],
      };
      const category = categorize(m);
      if (category === "other") continue;
      db.run("UPDATE mails SET category = ? WHERE id = ?", category, r.id);
      if (r.application_id && this.propose(db, m, category, r.application_id, r.snippet ?? "")) proposals++;
    }
    if (proposals) log.info("gmail reclassify", { proposals });
    return proposals;
  }

  /** Attach an email the rules could not place to an application (the user's choice), and propose what it suggests. */
  attach(db: Database, mailId: string, applicationId: string) {
    const r = db.get<Record<string, unknown>>("SELECT * FROM mails WHERE id = ?", mailId);
    if (!r) throw new MailError("gmail", "Ce mail n'est plus dans la liste.");
    db.run("UPDATE mails SET application_id = ? WHERE id = ?", applicationId, mailId);
    const mail = rowToMail(r);
    const suggests = SUGGESTS[mail.category];
    addEvent(db, { applicationId, actor: "user", kind: "mail", summary: `Mail rattaché : ${mail.subject}` });
    if (suggests) {
      proposeStatus(db, applicationId, { kind: "email", messageId: mailId, mailDate: mail.date, mailFrom: mail.from, mailSubject: mail.subject, excerpt: mail.snippet, suggests }, "user");
    }
  }

  /** Search Gmail live (read only), for the user or the assistant. */
  async search(query: string, max: number): Promise<{ id: string; date: string; from: string; subject: string; snippet: string }[]> {
    const { reader } = await this.reader();
    const ids = await reader.search(query, max);
    return (await reader.read(ids)).map((m) => ({
      id: m.id,
      date: m.date.toISOString(),
      from: m.from?.name || m.from?.address.split("@")[1] || "?",
      subject: m.subject,
      snippet: cleanForAi(mailText(m), 300),
    }));
  }

  /** The links of one email, to open the useful one (a test result, an offer). Links that act are flagged. */
  async links(id: string): Promise<{ id: string; subject: string; links: { n: number; text: string; url: string; acts: boolean }[] } | null> {
    const { reader } = await this.reader();
    const [m] = await reader.read([id], { html: true });
    if (!m) return null;
    return { id: m.id, subject: m.subject, links: emailLinks(m.html, m.text).map((l, i) => ({ n: i + 1, ...l })) };
  }

  /** One email's text for reading, links and addresses removed. */
  async read(id: string): Promise<{ id: string; date: string; from: string; subject: string; attachments: string[]; text: string } | null> {
    const { reader } = await this.reader();
    const [m] = await reader.read([id]);
    if (!m) return null;
    return { id: m.id, date: m.date.toISOString(), from: m.from?.name || m.from?.address.split("@")[1] || "?", subject: m.subject, attachments: m.attachments, text: cleanForAi(mailText(m)) };
  }
}
