/// <reference types="@cloudflare/workers-types" />
/**
 * Cloudflare D1 access via Drizzle.
 *
 * Replaces the Neon (Postgres-over-WebSocket) client. The shape of the problem
 * changed with the driver: Neon was reachable from a connection string, so any
 * code path that could read `DATABASE_URL` could build a client. A D1 binding
 * is not a string — it is a live object handed to the Worker's `fetch`
 * invocation and available nowhere else. So the env has to be captured at the
 * entry and carried down.
 *
 * `AsyncLocalStorage` is how it's carried. A module-level global would be
 * wrong: one isolate serves many overlapping requests, and a global would let
 * request B's env leak into request A's continuation. The ALS store is scoped
 * to a single request's async tree. `workerEnv` below exists only as a
 * fallback for code that runs outside any request scope, and the store always
 * takes precedence.
 *
 * NOTE ON TRANSACTIONS: D1 does not support interactive transactions, and
 * `db.transaction()` on the D1 driver does NOT give you atomicity — it runs
 * the callback against the same connection with no BEGIN. Do not use it. Use
 * `db.batch([...])`, which D1 executes atomically, and see
 * `src/lib/economy/ledger.ts` for the compare-and-swap pattern that replaced
 * the old `SELECT ... FOR UPDATE` row lock.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";

export type CloudflareEnv = {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  HARDCOVER_API_TOKEN?: string;
  ADMIN_EMAILS?: string;
  [key: string]: unknown;
};

export type Database = DrizzleD1Database<typeof schema>;

/**
 * Per-request context captured by the Worker entry (`src/server.ts`). Carries
 * the raw request headers (Better Auth reads the session cookie off them) and
 * the full env (bindings + secrets).
 */
export interface ServerRequestContext {
  headers: Headers;
  env: CloudflareEnv;
}

export const serverRequestContext =
  new AsyncLocalStorage<ServerRequestContext>();

// Fallback env for contexts outside the ALS scope (the entry sets this too).
let workerEnv: CloudflareEnv | null = null;

/** Capture the real Worker env. Called by the fetch entry before routing. */
export function setWorkerEnv(env: CloudflareEnv): void {
  workerEnv = env;
}

/**
 * Read the Cloudflare env (bindings + secrets). Prefers the per-request
 * context, then the entry-captured fallback.
 */
export function getCloudflareEnv(): CloudflareEnv {
  const ctx = serverRequestContext.getStore();
  if (ctx?.env?.DB) return ctx.env;
  if (workerEnv?.DB) return workerEnv;

  throw new Error(
    "[tome/db] The D1 binding is not available. This code must run in server " +
      "code on Cloudflare Workers, downstream of the fetch entry in " +
      "src/server.ts. If you are seeing this in a script, use the D1 HTTP " +
      "API instead — a binding does not exist outside the Worker.",
  );
}

/** Build a Drizzle client from a raw D1 binding. */
export function dbFromD1(d1: D1Database): Database {
  return drizzle(d1, { schema });
}

/** Build a Drizzle client from a Cloudflare env. */
export function dbFromEnv(env: CloudflareEnv): Database {
  return dbFromD1(env.DB);
}

/**
 * Get a Drizzle client bound to the current request's D1 database.
 *
 * Still `async` even though nothing awaits: every call site says
 * `await getDb()` (there are dozens), and the Neon version genuinely needed
 * to be. Keeping the signature avoids a mechanical churn commit across every
 * server function for no behavioural gain.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function getDb(): Promise<Database> {
  return dbFromEnv(getCloudflareEnv());
}

export { schema };
