/// <reference types="@cloudflare/workers-types" />
/**
 * Custom TanStack Start server entry.
 *
 * TanStack Start (as of v1.167) auto-resolves an optional `src/server.{ts,tsx}`
 * entry and uses its default export as the Worker's `fetch` handler. We pull
 * that lever here for two reasons:
 *
 * 1. Pre-dispatch anything under `/api/auth/*` to Better Auth's request
 *    handler before falling through to the default stream handler for SSR.
 *    This version of Start does not expose `createServerFileRoute` or a public
 *    "API route" primitive, so overriding the server entry is the supported
 *    escape hatch.
 *
 * 2. Capture the Cloudflare `env` — the D1 binding lives there and nowhere
 *    else. Under the old Neon setup the database was reachable from a
 *    connection string, so any code path could build a client from
 *    `process.env`; a binding is only handed to the Worker's fetch invocation.
 *    We stash it in an AsyncLocalStorage scope (see `src/db/client.ts`) so
 *    server functions running downstream of this request can call `getDb()`
 *    without threading `env` through every signature.
 *
 * AsyncLocalStorage (rather than a module-level global) is what makes this
 * safe under concurrency: one isolate serves many overlapping requests, and a
 * plain global would let request B's env leak into request A's continuation.
 * A module-level fallback is still set for contexts that run outside the ALS
 * scope, but the per-request store always wins.
 */

import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import type { CloudflareEnv } from "@/db/client";
import { getAuth } from "@/lib/auth/server";
import { serverRequestContext, setWorkerEnv } from "@/db/client";

const startFetch = createStartHandler(defaultStreamHandler) as (
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

// Cheap prefix check — Better Auth's default `basePath` is `/api/auth`.
// Keeping it literal rather than importing from Better Auth avoids pulling
// the auth module into every static-asset cold start.
function isAuthRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

async function fetch(
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  // Fallback for anything that escapes the ALS scope below.
  setWorkerEnv(env);

  // Better Auth's handler is invoked inside the context too — it resolves the
  // session out of D1, so it needs the binding just like a server function.
  return serverRequestContext.run(
    { headers: request.headers, env },
    async () => {
      if (isAuthRequest(request)) {
        const auth = await getAuth();
        return auth.handler(request);
      }
      return startFetch(request, env, ctx);
    },
  );
}

export default { fetch };
