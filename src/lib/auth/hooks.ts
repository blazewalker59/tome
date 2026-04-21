/**
 * Auth hooks facade.
 *
 * Preserves the API shape the rest of the app already imports from the old
 * `src/lib/supabase/auth.ts` module — specifically `useAuth`, `useUser`,
 * `signOut`, and `signInWithGoogle`. Only the import path changes for
 * downstream files; the surface is compatible.
 *
 * State shape mirrors the Supabase-era store:
 *   - status: "loading" while Better Auth's initial session fetch is in
 *     flight, then "authenticated" or "anonymous".
 *   - user: the Better Auth user (with our `username` / `displayName` /
 *     `avatarUrl` additional fields) or null when anonymous.
 *   - session: the full session object or null. The session no longer
 *     carries `access_token` like Supabase did — cookie-based auth means
 *     we never touch a bearer token on the client.
 */

import { useEffect, useState } from "react";
import { authClient, useSession } from "./client";
import { checkAdminFn } from "@/server/admin";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

type BetterAuthSession = ReturnType<typeof useSession>["data"];
// The non-null session shape is `{ user, session }`; we pluck the pieces.
type SessionUser = NonNullable<BetterAuthSession>["user"];
type SessionRecord = NonNullable<BetterAuthSession>["session"];

export interface AuthState {
  status: AuthStatus;
  user: SessionUser | null;
  session: SessionRecord | null;
}

/** Returns the current auth state and re-renders on changes. */
export function useAuth(): AuthState {
  const { data, isPending } = useSession();
  if (isPending) return { status: "loading", user: null, session: null };
  if (!data) return { status: "anonymous", user: null, session: null };
  return { status: "authenticated", user: data.user, session: data.session };
}

/** Convenience: returns just the user, or null. */
export function useUser(): SessionUser | null {
  return useAuth().user;
}

/**
 * Sign out the current user. Better Auth clears the session cookie and
 * the in-memory nanostore, which triggers a re-render through `useSession`.
 */
export async function signOut(): Promise<void> {
  await authClient.signOut();
}

/**
 * Kick off Google OAuth. Better Auth redirects to Google, then back to
 * `/api/auth/callback/google`, which our Better Auth server handler picks
 * up — no custom callback route needed (contrast with the old Supabase
 * flow that drove a manual PKCE exchange in `/auth/callback`).
 *
 * `callbackURL` is where Better Auth bounces the browser after a successful
 * sign-in. The default is `/`, which is what we want post-sign-in anyway.
 */
export async function signInWithGoogle(): Promise<void> {
  const { error } = await authClient.signIn.social({
    provider: "google",
    callbackURL: "/",
  });
  if (error) {
    throw new Error(error.message ?? "Google sign-in failed");
  }
}

/**
 * Is the currently-authenticated user on the ADMIN_EMAILS allowlist?
 *
 * Runs a one-shot server call (`checkAdminFn`) when auth flips to
 * `authenticated`. Returns:
 *   - `undefined` while the check is pending (including while auth is
 *     still loading) — lets callers render nothing rather than flash a
 *     link that might vanish.
 *   - `false` for anonymous users or non-admin authenticated users.
 *   - `true` only for users whose session email matches the allowlist.
 *
 * The admin status is cached in local component state; sign-out triggers
 * the effect to re-resolve (and reset to `false`). We don't cache globally
 * because the Header is the only consumer today, and admin status changes
 * are rare + operator-driven (env var edit + redeploy).
 */
export function useIsAdmin(): boolean | undefined {
  const { status } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (status === "loading") return;
    if (status === "anonymous") {
      setIsAdmin(false);
      return;
    }
    let cancelled = false;
    setIsAdmin(undefined);
    checkAdminFn()
      .then((r) => {
        if (!cancelled) setIsAdmin(r.isAdmin);
      })
      .catch(() => {
        // Fail closed — if the probe errors, treat as non-admin. The
        // ingest page itself re-checks server-side so this can't leak
        // access; it only affects whether the nav link is shown.
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  return isAdmin;
}
