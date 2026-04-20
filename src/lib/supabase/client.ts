import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser-side Supabase client. Uses `@supabase/ssr`'s createBrowserClient
 * so the PKCE code_verifier is stored in cookies instead of localStorage.
 * Cookies survive the full OAuth redirect chain (sign-in page → Supabase
 * auth server → Google → Supabase auth server → /auth/callback) reliably,
 * which localStorage does not in every SSR setup.
 *
 * The publishable key (the new replacement for `anon`) is browser-safe and
 * scoped to public row-level-security policies.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
// Accept the new publishable key (preferred) and fall back to the legacy
// anon key so projects that haven't rotated yet keep working.
const publishableKey =
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ??
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);

if (typeof window !== "undefined" && (!url || !publishableKey)) {
  // Loud at module-eval time so misconfig surfaces in dev immediately rather
  // than as a confusing runtime error inside the auth flow.
  // eslint-disable-next-line no-console
  console.warn(
    "[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY missing. " +
      "Auth features will throw until you set them in .env. " +
      "See .env.example for the keys you need.",
  );
}

let _client: SupabaseClient | null = null;

/**
 * Lazily-instantiated singleton. Lazy so SSR / tests that don't actually
 * touch auth never construct a client (and therefore never throw on missing
 * env vars or try to read cookies server-side).
 */
export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  if (!url || !publishableKey) {
    throw new Error(
      "Supabase env vars missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.",
    );
  }
  _client = createBrowserClient(url, publishableKey, {
    // createBrowserClient already defaults to PKCE flow and stores the
    // code_verifier + session in cookies via document.cookie. We disable
    // detectSessionInUrl because the /auth/callback route drives the
    // exchange explicitly so there's no race.
    auth: {
      detectSessionInUrl: false,
    },
  });
  return _client;
}

/** Test-only: reset the singleton so each test gets a fresh client. */
export function __resetSupabaseForTests() {
  _client = null;
}
