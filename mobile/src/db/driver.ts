/**
 * Driver seam for the local SQLite database (SPEC TASK-081).
 *
 * Application code (stores, repositories) depends only on this small
 * interface; the concrete driver wraps react-native-sqlite-storage on
 * device. Keeping the surface tiny keeps stores trivially testable with a
 * real-SQL in-memory driver.
 */

export type SqlParam = string | number | null;

/** One result row keyed by column name. */
export type SqlRow = Record<string, SqlParam>;

export interface SqlResult {
  rows: SqlRow[];
  rowsAffected: number;
  /** Row id of the most recent INSERT, when applicable. */
  insertId: number | null;
}

/**
 * Minimal SQL executor. `execute` runs one statement; PRAGMA statements and
 * other non-parameterized SQL must pass no params.
 */
export interface SqlExecutor {
  execute(sql: string, params?: readonly SqlParam[]): Promise<SqlResult>;
}

/**
 * A database connection. Transactions run the callback against an executor
 * bound to an open transaction: either everything commits or nothing does.
 */
export interface SqlDriver extends SqlExecutor {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Current UTC time as an ISO-8601 string (stored timestamp format). */
export function nowIso(): string {
  return new Date().toISOString();
}
