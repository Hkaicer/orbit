import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { runMigrations } from "./migrations";

export type Row = Record<string, SQLInputValue>;

/**
 * Thin wrapper over node:sqlite with nested transactions (savepoints).
 * Every write goes through `tx` so that a failure never leaves partial data.
 */
export class Database {
  raw: DatabaseSync;
  private depth = 0;

  constructor(readonly file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA synchronous = NORMAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec("PRAGMA busy_timeout = 5000;");
  }

  migrate() {
    return runMigrations(this);
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }

  tx<T>(fn: () => T): T {
    const name = `sp_${this.depth}`;
    if (this.depth === 0) this.raw.exec("BEGIN IMMEDIATE");
    else this.raw.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      if (this.depth === 0) this.raw.exec("COMMIT");
      else this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      this.depth--;
      if (this.depth === 0) this.raw.exec("ROLLBACK");
      else {
        this.raw.exec(`ROLLBACK TO ${name}`);
        this.raw.exec(`RELEASE ${name}`);
      }
      throw err;
    }
  }

  /** Consistent online copy of the database file. */
  backupTo(target: string) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.raw.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  }

  close() {
    this.raw.close();
  }
}
