import { useSyncExternalStore } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabase } from "./client";

/**
 * Auth state store. Subscribes once to Supabase's onAuthStateChange and
 * exposes a useSyncExternalStore-compatible snapshot so any component can
 * read the current user without a context provider.
 *
 * State shape:
 *   - status: "loading" until the initial getSession() resolves, then
 *     "authenticated" or "anonymous".
 *   - user: the Supabase user, or null if anonymous.
 *   - session: the full session (with access_token), or null.
 */

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthState {
  status: AuthStatus;
  user: User | null;
  session: Session | null;
}

const INITIAL: AuthState = { status: "loading", user: null, session: null };
const ANONYMOUS: AuthState = { status: "anonymous", user: null, session: null };

let state: AuthState = INITIAL;
const listeners = new Set<() => void>();
let initialized = false;

function setState(next: AuthState) {
  state = next;
  for (const l of listeners) l();
}

function fromSession(session: Session | null): AuthState {
  if (!session) return ANONYMOUS;
  return { status: "authenticated", user: session.user, session };
}

function ensureInitialized() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  let supabase;
  try {
    supabase = getSupabase();
  } catch {
    // Env vars missing — surface as anonymous so the UI still renders.
    setState(ANONYMOUS);
    return;
  }
  void supabase.auth
    .getSession()
    .then(({ data }) => {
      setState(fromSession(data.session));
    })
    .catch((err) => {
      // Never hang in "loading" — if getSession throws, treat as anonymous
      // and let the user retry. Surface the error for debugging.
      // eslint-disable-next-line no-console
      console.error("[supabase] getSession failed:", err);
      setState(ANONYMOUS);
    });
  supabase.auth.onAuthStateChange((_event, session) => {
    setState(fromSession(session));
  });
}

function subscribe(listener: () => void) {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AuthState {
  return state;
}

// SSR snapshot — always "loading" on the server so hydration matches the
// pre-init client state.
function getServerSnapshot(): AuthState {
  return INITIAL;
}

/** Returns the current auth state and re-renders on changes. */
export function useAuth(): AuthState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Convenience: returns just the user, or null. */
export function useUser(): User | null {
  return useAuth().user;
}

/** Sign out the current user. */
export async function signOut(): Promise<void> {
  const supabase = getSupabase();
  await supabase.auth.signOut();
}

/**
 * Kick off Google OAuth. Supabase will redirect to Google, then back to
 * `${VITE_SITE_URL}/auth/callback`, which finishes the exchange.
 *
 * We pass `skipBrowserRedirect: true` so we can log what supabase-js wrote
 * to cookies (the PKCE code_verifier) BEFORE we navigate away. Without this
 * step it's impossible to tell whether a "verifier missing" error on the
 * callback is because we never wrote it or because the browser dropped it
 * during the redirect chain.
 */
export async function signInWithGoogle(): Promise<void> {
  const supabase = getSupabase();
  const siteUrl = (import.meta.env.VITE_SITE_URL as string | undefined) ?? window.location.origin;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${siteUrl}/auth/callback`,
      skipBrowserRedirect: true,
    },
  });
  if (error) throw error;
  if (!data?.url) throw new Error("Supabase did not return an OAuth URL");

  // Diagnostic: list every cookie currently on the page so we can verify
  // the code_verifier got stored. In dev this shows up right before the
  // redirect so you can catch it even with "preserve log" off.
  // eslint-disable-next-line no-console
  console.log(
    "[auth] pre-redirect cookies:",
    document.cookie
      .split(";")
      .map((c) => c.trim().split("=")[0])
      .filter(Boolean),
  );
  // eslint-disable-next-line no-console
  console.log("[auth] redirecting to provider:", data.url);

  window.location.assign(data.url);
}

/** Test-only: reset the store so each test starts fresh. */
export function __resetAuthForTests() {
  state = INITIAL;
  listeners.clear();
  initialized = false;
}
