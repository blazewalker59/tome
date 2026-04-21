/**
 * Cross-runtime env accessor.
 *
 * Server code runs on Node locally (tsx / `pnpm dev`) and on Cloudflare
 * Workers in production. Each surfaces bindings differently:
 *
 *   - Node: `process.env.FOO` (populated from .env.local by the dev server).
 *   - Cloudflare Workers: secrets + vars are on the `env` object exposed by
 *     the virtual `cloudflare:workers` module — NOT on `process.env` unless
 *     the `nodejs_compat_populate_process_env` compat flag is set, which is
 *     gated behind a specific compat date and brittle to reason about.
 *
 * Reading from `cloudflare:workers` first and falling back to `process.env`
 * works on both runtimes with no flag coordination. The dynamic `import()`
 * is deliberate so Node (where the specifier is unresolvable) just throws
 * and falls through.
 *
 * NOTE: call `getEnv('FOO')` from inside a function body, NEVER at module
 * top-level. On Workers the `cloudflare:workers` module is only available
 * once a `fetch` handler is running; importing at module eval can return
 * an `env` object that hasn't been populated yet.
 */

let cachedCfEnv: Record<string, string | undefined> | null | undefined =
  undefined;

async function loadCloudflareEnv(): Promise<
  Record<string, string | undefined> | null
> {
  if (cachedCfEnv !== undefined) return cachedCfEnv;
  try {
    // @ts-expect-error — virtual module, only resolvable on Workers runtime
    const mod = (await import("cloudflare:workers")) as {
      env?: Record<string, string | undefined>;
    };
    cachedCfEnv = mod.env ?? null;
  } catch {
    cachedCfEnv = null;
  }
  return cachedCfEnv;
}

/**
 * Resolve a server-side env variable from whatever runtime we're on.
 *
 * Checks Cloudflare Workers bindings first (secrets + vars), then
 * `process.env` as a fallback. Returns `undefined` if neither has it.
 */
export async function getEnv(name: string): Promise<string | undefined> {
  const cf = await loadCloudflareEnv();
  if (cf && cf[name]) return cf[name];
  if (typeof process !== "undefined" && process.env) {
    return process.env[name];
  }
  return undefined;
}
