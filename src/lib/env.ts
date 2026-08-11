/**
 * Cross-runtime env accessor.
 *
 * Server code runs on Node locally (tsx scripts) and on Cloudflare Workers in
 * dev and production. Each surfaces configuration differently:
 *
 *   - Cloudflare Workers: secrets + vars live on the `env` object handed to
 *     the Worker's fetch invocation. `src/server.ts` captures it into an
 *     AsyncLocalStorage scope; `getCloudflareEnv()` reads it back.
 *   - Node: `process.env.FOO`, populated from `.env.local` by the scripts.
 *
 * This used to dynamically `import("cloudflare:workers")` to reach the env.
 * That worked, but the virtual specifier is unresolvable off-Workers, so the
 * module threw-and-caught on every Node call and — more annoyingly — Vitest's
 * resolver choked on it, which is why several tests had to mock whole server
 * modules just to avoid importing this file. Reading the request-scoped env
 * instead removes the virtual import entirely.
 *
 * NOTE: call `getEnv('FOO')` from inside a function body, never at module
 * top-level. On Workers there is no env until a request is in flight.
 */

import { getCloudflareEnv } from "@/db/client";

/**
 * Resolve a server-side env variable from whatever runtime we're on.
 *
 * Checks the Cloudflare request env first (secrets + vars), then
 * `process.env`. Returns `undefined` if neither has it.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function getEnv(name: string): Promise<string | undefined> {
  try {
    const value = getCloudflareEnv()[name];
    if (typeof value === "string" && value) return value;
  } catch {
    // Not inside a Worker request — fall through to process.env.
  }

  if (typeof process !== "undefined" && process.env) {
    return process.env[name];
  }
  return undefined;
}
