import type { Database } from "./database";

interface Migration {
  version: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    up: `
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);

      CREATE TABLE offers (
        id TEXT PRIMARY KEY,
        company TEXT NOT NULL,
        title TEXT NOT NULL,
        location TEXT,
        contract TEXT,
        duration TEXT,
        start_date TEXT,
        reference TEXT,
        url TEXT,
        source TEXT NOT NULL,
        language TEXT,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','kept','ignored')),
        score INTEGER,
        analysis TEXT,
        analysis_md TEXT,
        missing TEXT NOT NULL DEFAULT '[]',
        dedup_key TEXT NOT NULL,
        url_key TEXT,
        similar_to TEXT,
        discovered_at TEXT NOT NULL,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_offers_dedup ON offers(dedup_key);
      CREATE INDEX idx_offers_url ON offers(url_key);

      CREATE TABLE offer_sources (
        id TEXT PRIMARY KEY,
        offer_id TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        url TEXT,
        seen_at TEXT NOT NULL,
        note TEXT
      );
      CREATE INDEX idx_sources_offer ON offer_sources(offer_id);

      CREATE TABLE applications (
        id TEXT PRIMARY KEY,
        offer_id TEXT NOT NULL UNIQUE REFERENCES offers(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'B' CHECK (mode IN ('A','B','C')),
        folder TEXT,
        source_folder TEXT,
        cv_path TEXT,
        letter_path TEXT,
        sent_at TEXT,
        next_action TEXT,
        next_action_due TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
        offer_id TEXT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT
      );
      CREATE INDEX idx_events_app ON events(application_id);
      CREATE INDEX idx_events_at ON events(at);

      CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        message_id TEXT,
        mail_date TEXT,
        mail_from TEXT,
        mail_subject TEXT,
        excerpt TEXT,
        suggests TEXT,
        due_at TEXT,
        confirmed INTEGER NOT NULL DEFAULT 0,
        dismissed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_evidence_app ON evidence(application_id);
      CREATE UNIQUE INDEX idx_evidence_mail ON evidence(application_id, message_id) WHERE message_id IS NOT NULL;

      CREATE TABLE deadlines (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        due_at TEXT,
        status TEXT NOT NULL DEFAULT 'todo',
        evidence_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        root TEXT NOT NULL,
        name TEXT NOT NULL,
        ext TEXT NOT NULL,
        kind TEXT NOT NULL,
        family TEXT,
        language TEXT,
        company TEXT,
        size INTEGER NOT NULL,
        mtime TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        text TEXT,
        status TEXT NOT NULL DEFAULT 'unknown',
        signals TEXT NOT NULL DEFAULT '[]',
        validated INTEGER NOT NULL DEFAULT 0,
        private INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX idx_documents_sha ON documents(sha256);

      CREATE TABLE mails (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        date TEXT NOT NULL,
        from_name TEXT,
        from_address TEXT,
        subject TEXT,
        snippet TEXT,
        category TEXT NOT NULL DEFAULT 'other',
        application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
        link TEXT,
        synced_at TEXT NOT NULL
      );
      CREATE INDEX idx_mails_app ON mails(application_id);

      CREATE TABLE pending_actions (
        id TEXT PRIMARY KEY,
        application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        description TEXT NOT NULL,
        details TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        ops TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
    `,
  },
  {
    version: 2,
    name: "job alerts",
    // 1 once an email of an alert sender has been read for the jobs it lists.
    up: "ALTER TABLE mails ADD COLUMN alert_checked INTEGER NOT NULL DEFAULT 0;",
  },
];

export function runMigrations(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const current = db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_migrations")?.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.tx(() => {
      db.exec(m.up);
      db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", m.version, m.name, new Date().toISOString());
    });
  }
  return { current: Math.max(current, MIGRATIONS.at(-1)?.version ?? 0) };
}
