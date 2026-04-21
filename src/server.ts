/**
 * Custom TanStack Start server entry.
 *
 * TanStack Start (as of v1.167) auto-resolves an optional `src/server.{ts,tsx}`
 * entry and uses its default export as the Worker's `fetch` handler. We pull
 * that lever here to pre-dispatch anything under `/api/auth/*` to Better
 * Auth's request handler before falling through to the default TanStack Start
 * stream handler for SSR.
 *
 * Why this instead of a server-file route? This version of TanStack Start
 * (`@tanstack/react-start@1.167.42`) does not expose `createServerFileRoute`
 * or a public "API route" primitive. Overriding the server entry is the
 * supported escape hatch — the plugin's `resolveStartEntryPlan` explicitly
 * reads `src/server.ts` before falling back to the package default at
 * `@tanstack/react-start/default-entry/server.ts`.
 *
 * The shape (`export default { fetch }`) matches that default entry 1:1, so
 * everything Nitro / the `cloudflare-module` preset expects continues to work.
 */

import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import type { Register } from "@tanstack/react-router";
import type { RequestHandler } from "@tanstack/react-start/server";
import { getAuth } from "@/lib/auth/server";

const startFetch = createStartHandler(defaultStreamHandler);

// Cheap prefix check — Better Auth's default `basePath` is `/api/auth`.
// Keeping it literal rather than importing from Better Auth avoids pulling
// the auth module into every static-asset cold start.
function isAuthRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

async function fetch(...args: Parameters<RequestHandler<Register>>) {
  const request = args[0];
  if (isAuthRequest(request)) {
    const auth = await getAuth();
    return auth.handler(request);
  }
  return startFetch(...args);
}

export type ServerEntry = { fetch: RequestHandler<Register> };

export default { fetch } satisfies ServerEntry;
