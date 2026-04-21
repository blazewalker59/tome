import { drizzle } from "drizzle-orm/neon-serverless";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import * as schema from "./schema";
import { getEnv } from "@/lib/env";

/**
 * Drizzle client factory for Cloudflare Workers + Node.
 *
 * Why the Neon **WebSocket** driver (not HTTP)?
 * ---------------------------------------------
 * The HTTP variant is stateless per-query (nice!), but it does NOT support
 * interactive transactions — only `sql.transaction([...])` pipelined arrays,
 * which are useless when later statements depend on earlier read results.
 * `src/server/collection.ts#recordRipFn` runs a multi-step read-then-write
 * flow (check existing rows → compute new vs. duplicate → insert/update
 * atomically) that requires a real `BEGIN ... COMMIT`.
 *
 * `@neondatabase/serverless`'s `Pool` speaks Postgres over a WebSocket,
 * which Cloudflare Workers supports. Drizzle's `neon-serverless` adapter
 * recognises it and gives us `db.transaction((tx) => ...)` semantics
 * identical to `postgres-js` / `node-postgres`.
 *
 * A fresh `Pool` per request is the right default on Workers. Each incoming
 * request runs in a short-lived isolate; trying to share a pool across
 * requests means juggling `ctx.waitUntil` to keep sockets open and dealing
 * with half-closed connections after isolate suspend. Neon is also
 * optimised for spin-up-fast-and-drop connections. `pool.end()` is called
 * implicitly when the handler returns — we don't keep references.
 */

type Database = NeonDatabase<typeof schema>;

// The `ws` shim: on Node, Neon's driver auto-loads the `ws` package; on
// Cloudflare Workers the runtime provides a native WebSocket that Neon
// picks up without any wiring. The driver's defaults are right for both,
// so this module deliberately does NOT touch `neonConfig.webSocketConstructor`.
//
// Keeping the import so future per-env tweaks (e.g. `poolQueryViaFetch`)
// have a home.
void neonConfig;

export async function getDb(): Promise<Database> {
  const url = await getEnv("DATABASE_URL");
  if (!url) {
    throw new Error(
      "[tome/db] DATABASE_URL is not set. On Cloudflare Workers, set it via " +
        "`wrangler secret put DATABASE_URL --name tome`. Locally, put it in " +
        ".env.local (for `pnpm dev`) or .dev.vars (for `wrangler dev`).",
    );
  }

  // `max: 1` keeps the pool tiny — each request builds its own anyway, so
  // letting Neon open more than one socket per isolate is pure waste.
  const pool = new Pool({ connectionString: url, max: 1 });
  return drizzle(pool, { schema });
}

export { schema };
