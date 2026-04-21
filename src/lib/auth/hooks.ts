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

import { authClient, useSession } from "./client";

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
