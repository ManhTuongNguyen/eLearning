/**
 * TEST-ONLY SQLite driver backed by sql.js (WebAssembly SQLite).
 *
 * Executes real SQL semantics in the Node/Jest environment so migrations and
 * CRUD behavior are verified against an actual engine rather than stubs.
 * Never import this module from application code — sql.js is a devDependency
 * that must not reach the Metro bundle.
 */
import initSqlJs, {type Database} from 'sql.js';

import type {SqlDriver, SqlExecutor, SqlParam, SqlResult} from '../src/db/driver';

function isInsert(sql: string): boolean {
  return /^\s*(WITH[\s\S]*?)?\s*INSERT\b/i.test(sql);
}

class SqlJsDriver implements SqlDriver {
  constructor(private readonly db: Database) {}

  async execute(sql: string, params: readonly SqlParam[] = []): Promise<SqlResult> {
    const statement = this.db.prepare(sql);
    try {
      if (params.length > 0) {
        statement.bind([...params]);
      }

      const rows: Record<string, SqlParam>[] = [];
      while (statement.step()) {
        rows.push(statement.getAsObject() as Record<string, SqlParam>);
      }
      const rowsAffected = this.db.getRowsModified();

      let insertId: number | null = null;
      if (isInsert(sql)) {
        const idStatement = this.db.prepare('SELECT last_insert_rowid() AS insertId');
        try {
          if (idStatement.step()) {
            insertId = Number(idStatement.getAsObject().insertId);
          }
        } finally {
          idStatement.free();
        }
      }

      return {rows, rowsAffected, insertId};
    } finally {
      statement.free();
    }
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    await this.execute('BEGIN IMMEDIATE');
    try {
      const outcome = await work({execute: (sql, params) => this.execute(sql, params)});
      await this.execute('COMMIT');
      return outcome;
    } catch (error) {
      await this.execute('ROLLBACK');
      throw error;
    }
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

/** Open a fresh in-memory database with foreign-key enforcement enabled. */
export async function openSqlJsDriver(): Promise<SqlDriver> {
  const SQL = await initSqlJs();
  const driver = new SqlJsDriver(new SQL.Database());
  await driver.execute('PRAGMA foreign_keys = ON');
  return driver;
}
