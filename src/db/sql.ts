/**
 * Helpers for hand-written SQL against D1.
 */

/**
 * Convert a Date to the epoch-SECONDS integer SQLite stores.
 *
 * Needed whenever a Date is interpolated into a raw `sql` template. Drizzle's
 * query builder converts bound Dates for you because it knows the column is
 * `integer({ mode: "timestamp" })`; a raw template has no column to consult,
 * so it hands the Date straight to D1 — which accepts only null, number,
 * string, boolean and ArrayBuffer, and rejects it at runtime.
 *
 * SECONDS, not milliseconds: the schema uses `mode: "timestamp"`. Getting this
 * wrong doesn't throw, it just silently compares against a date in 1970 (or
 * the year 56000), so a filter quietly matches everything or nothing.
 *
 * If you are using `gt()` / `lt()` / `gte()` from drizzle-orm you do NOT need
 * this — pass the Date directly.
 */
export function toEpochSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}
