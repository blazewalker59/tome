import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { getEnv } from "@/lib/env";

/**
 * Drizzle client factory for Cloudflare Workers + Node.
 *
 * Why NOT cache across requests on Workers
 * -----------------------------------------
 * postgres-js keeps a long-lived TCP socket. On Cloudflare Workers:
 *   1. A Worker isolate can be suspended/resumed between requests; sockets
 *      don't always survive the nap.
 *   2. Supabase's transaction pooler (pgbouncer) closes idle server
 *      connections aggressively.
 *   3. When the cached client fires a query through a now-dead socket,
 *      postgres-js throws CONNECTION_CLOSED — drizzle wraps that as
 *      "Failed query" with no context, producing the intermittent errors
 *      we saw on /rip and /collection.
 *
 * So: we create a fresh client per `getDb()` call. For Supabase's pooler
 * this is the intended pattern — the pooler pools server-side, each
 * client-side connection is cheap. `{ max: 1 }` keeps the per-request
 * socket count at 1; `{ idle_timeout: 20 }` lets it die quickly after the
 * request finishes so we don't leak sockets across the isolate's lifetime.
 *
 * On Node (local dev), the overhead of a new connection per server
 * function is negligible for a dev workflow. If this becomes a hot path
 * in production Node deployments we can reintroduce caching gated on
 * runtime detection — but we don't deploy to Node.
 */

type Database = PostgresJsDatabase<typeof schema>;

export async function getDb(): Promise<Database> {
  const url = await getEnv("DATABASE_URL");
  if (!url) {
    throw new Error(
      "[tome/db] DATABASE_URL is not set. On Cloudflare Workers, set it via " +
        "`wrangler secret put DATABASE_URL --name tome`. Locally, put it in " +
        ".env.local (for `pnpm dev`) or .dev.vars (for `wrangler dev`).",
    );
  }

  const client = postgres(url, {
    // Required for Supabase's transaction pooler (port 6543): pgbouncer in
    // transaction mode does not support the extended query protocol's
    // prepared statements.
    prepare: false,
    // One socket per invocation is enough — the pooler handles fan-out.
    max: 1,
    // Drop idle sockets quickly so a suspended-then-resumed isolate
    // doesn't try to reuse a socket the server has already closed.
    idle_timeout: 20,
    // Cap socket lifetime as a further safety net.
    max_lifetime: 60 * 5,
  });

  return drizzle(client, { schema });
}

export { schema };
