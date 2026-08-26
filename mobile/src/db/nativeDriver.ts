/**
 * react-native-sqlite-storage adapter for the local serverless database
 * (SPEC TASK-081).
 *
 * Wraps the native module behind the driver seam in `driver.ts`. Foreign-key
 * enforcement is enabled per connection so deleting a session cascades to its
 * messages and summary.
 */
import SQLite from 'react-native-sqlite-storage';

import type {SqlDriver, SqlExecutor, SqlParam, SqlResult} from './driver';

/** On-device database file name inside the app's default storage location. */
export const LOCAL_DB_NAME = 'elearning-serverless.db';

// Promise-based API throughout; callbacks are never used.
SQLite.enablePromise(true);

type NativeResultSet = {
  rows: {raw: () => Array<Record<string, unknown>>};
  rowsAffected: number;
  insertId?: number;
};

type NativeDatabase = {
  executeSql: (
    sql: string,
    params?: unknown[],
  ) => Promise<[NativeResultSet]>;
  close: () => Promise<void>;
};

function mapResult(resultSet: NativeResultSet): SqlResult {
  return {
    // raw() returns plain objects keyed by column name; normalize values.
    rows: resultSet.rows.raw().map(row => {
      const mapped: Record<string, SqlParam> = {};
      for (const [key, value] of Object.entries(row)) {
        if (value === null || typeof value === 'string' || typeof value === 'number') {
          mapped[key] = value;
        } else if (typeof value === 'boolean') {
          mapped[key] = value ? 1 : 0;
        } else {
          mapped[key] = String(value);
        }
      }
      return mapped;
    }),
    rowsAffected: resultSet.rowsAffected ?? 0,
    insertId: resultSet.insertId ?? null,
  };
}

class NativeSqliteDriver implements SqlDriver {
  constructor(private readonly db: NativeDatabase) {}

  async execute(sql: string, params: readonly SqlParam[] = []): Promise<SqlResult> {
    const [resultSet] = await this.db.executeSql(sql, [...params]);
    return mapResult(resultSet);
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

  async close(): Promise<void> {
    await this.db.close();
  }
}

/** Open (creating if needed) the on-device database and enable foreign keys. */
export async function openNativeDriver(name: string = LOCAL_DB_NAME): Promise<SqlDriver> {
  const db: NativeDatabase = await SQLite.openDatabase({name, location: 'default'});
  await db.executeSql('PRAGMA foreign_keys = ON');
  return new NativeSqliteDriver(db);
}
