/**
 * Server-side Supabase client. Reads the user session from request cookies
 * so server functions (TanStack Start `createServerFn`) can authenticate
 * the caller.
 *
 * Why not just use the browser client on the server? Because server code has
 * no `document.cookie`. `@supabase/ssr`'s `createServerClient` accepts a
 * cookies adapter that we wire to `@tanstack/react-start/server`'s
 * per-request cookie accessors.
 *
 * This module must ONLY be imported from server code (server functions,
 * middleware, loaders executed server-side). Importing it from a client
 * bundle will throw when the cookie helpers attempt to access the request.
 *
 * Env resolution is **lazy** — reading `process.env` at module eval on
 * Cloudflare Workers yields undefined because bindings aren't populated
 * until the first `fetch` handler invocation. We resolve on every call to
 * `getServerSupabase()`, which happens per request anyway.
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { getCookies, getRequestHeaders } from '@tanstack/react-start/server'
import { getEnv } from '@/lib/env'

async function resolveSupabaseEnv(): Promise<{ url: string; key: string }> {
  // Accept the VITE_-prefixed names (matches what the client bundle uses,
  // so dev setups with a single `.env.local` Just Work) as well as the
  // unprefixed names (preferred on Workers since `VITE_` is conventionally
  // a build-time marker for the client bundle). `getEnv` resolves from
  // the Cloudflare Workers `env` binding first, then falls back to Node's
  // `process.env` — so this works identically in both runtimes.
  const url =
    (await getEnv('SUPABASE_URL')) ?? (await getEnv('VITE_SUPABASE_URL'))
  const key =
    (await getEnv('SUPABASE_PUBLISHABLE_KEY')) ??
    (await getEnv('VITE_SUPABASE_PUBLISHABLE_KEY')) ??
    (await getEnv('SUPABASE_ANON_KEY')) ??
    (await getEnv('VITE_SUPABASE_ANON_KEY'))

  if (!url || !key) {
    throw new Error(
      '[supabase/server] Missing Supabase config. On Cloudflare Workers set ' +
        '`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` as Worker secrets ' +
        '(`wrangler secret put SUPABASE_URL --name tome`, etc). Locally put ' +
        'them in .env.local — the `VITE_SUPABASE_*` names are also accepted.',
    )
  }
  return { url, key }
}

/**
 * Create a request-scoped Supabase client. Do NOT cache this across requests —
 * each call reads the current request's cookies, and re-using a client from
 * another request would leak sessions.
 *
 * Async because env resolution on Cloudflare Workers requires a dynamic
 * `import('cloudflare:workers')`.
 */
export async function getServerSupabase(): Promise<SupabaseClient> {
  const { url, key } = await resolveSupabaseEnv()

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        // TanStack exposes parsed cookies as a Record<string, string>.
        const raw = getCookies() ?? {}
        return Object.entries(raw).map(([name, value]) => ({ name, value }))
      },
      setAll(_cookiesToSet: ReadonlyArray<{ name: string; value: string; options: CookieOptions }>) {
        // In a server-function context we don't have direct access to the
        // outgoing response, but Supabase only calls setAll when it refreshes
        // the session. For our use case (read-only session checks inside
        // server fns) this is effectively a no-op — the next request will
        // pick up the refreshed cookies via the browser client.
      },
    },
    // Attach the incoming request's headers so Supabase can forward any
    // `Authorization` bearer tokens (we don't use them yet, but this keeps
    // the client compatible with future header-based auth).
    global: {
      headers: getRequestHeaders() as unknown as Record<string, string>,
    },
  })
}

/**
 * Read the current user from the server-side session. Returns `null` for
 * unauthenticated requests. Throws only on Supabase communication errors
 * (network / misconfig) — a missing session is a normal result.
 */
export async function getSessionUser(): Promise<User | null> {
  const supabase = await getServerSupabase()
  const { data, error } = await supabase.auth.getUser()
  if (error) {
    // Common case: no session cookie at all. Supabase returns an
    // `AuthSessionMissingError` here — treat it as anonymous.
    if (error.name === 'AuthSessionMissingError') return null
    throw error
  }
  return data.user ?? null
}
