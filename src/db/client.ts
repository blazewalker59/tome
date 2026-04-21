import { drizzle } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";
import { getEnv } from "@/lib/env";

/**
 * Drizzle client factory for Cloudflare Workers + Node.
 *
 * Why the Neon HTTP driver?
 * -------------------------
 * The Neon serverless driver (`@neondatabase/serverless`) speaks SQL over
 * HTTPS (fetch). That gives us three properties we want on Workers:
 *
 *   1. No long-lived TCP sockets to manage across isolate suspend/resume.
 *      Every query is a fresh fetch; there's nothing to keep alive.
 *   2. No pgbouncer transaction-mode gotchas (prepared statements, etc).
 *      The HTTP endpoint is stateless.
 *   3. No WebSocket polyfills required in the Workers runtime.
 *
 * The tradeoff: each HTTP call is one SQL statement, so multi-statement
 * transactions use `sql.transaction([...])` (array form) — not an
 * interactive `BEGIN ... COMMIT`. None of our current server fns use
 * interactive transactions, so that's a non-issue. If we ever need one
 * (batch write that must be atomic with cross-statement reads), switch
 * that call site to the WebSocket `Pool` variant, not the whole app.
 *
 * We still create a fresh Drizzle instance per request. `neon()` itself
 * is cheap (it closes over a config object, no socket), but the Drizzle
 * wrapper caches prepared-statement stubs internally; giving each request
 * its own instance keeps behaviour predictable on Workers' shared isolates.
 */

type Database = NeonHttpDatabase<typeof schema>;

export async function getDb(): Promise<Database> {
  const url = await getEnv("DATABASE_URL");
  if (!url) {
    throw new Error(
      "[tome/db] DATABASE_URL is not set. On Cloudflare Workers, set it via " +
        "`wrangler secret put DATABASE_URL --name tome`. Locally, put it in " +
        ".env.local (for `pnpm dev`) or .dev.vars (for `wrangler dev`).",
    );
  }

  const sql = neon(url);
  return drizzle(sql, { schema });
}

export { schema };
