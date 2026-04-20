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
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { getCookies, getRequestHeaders } from '@tanstack/react-start/server'

const url = process.env.VITE_SUPABASE_URL
const publishableKey =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY

if (!url || !publishableKey) {
  // Surface the misconfig loudly at module-eval time so server-fn failures
  // point at the real cause rather than a cryptic fetch error.
  console.warn(
    '[supabase/server] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY missing. ' +
      'Server-side auth will throw until they are set in .env.local.',
  )
}

/**
 * Create a request-scoped Supabase client. Do NOT cache this across requests —
 * each call reads the current request's cookies, and re-using a client from
 * another request would leak sessions.
 */
export function getServerSupabase(): SupabaseClient {
  if (!url || !publishableKey) {
    throw new Error(
      'Supabase env vars missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.',
    )
  }

  return createServerClient(url, publishableKey, {
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
        //
        // If/when we need session rotation server-side, replace this with
        // the appropriate response header writer.
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
  const supabase = getServerSupabase()
  const { data, error } = await supabase.auth.getUser()
  if (error) {
    // Common case: no session cookie at all. Supabase returns an
    // `AuthSessionMissingError` here — treat it as anonymous.
    if (error.name === 'AuthSessionMissingError') return null
    throw error
  }
  return data.user ?? null
}
