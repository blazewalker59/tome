/**
 * Tiny admin-auth probe, split out from `src/server/ingest.ts` so that
 * client code (`src/lib/auth/hooks.ts`) can import `checkAdminFn` without
 * transitively pulling in the DB client, Hardcover GraphQL client, or
 * their dynamic `cloudflare:workers` imports — any of which would blow
 * up Vitest's jsdom loader when tests import the auth hooks.
 *
 * Server functions are stripped from the client bundle by TanStack Start
 * at build time; the *imports* around them still have to resolve in the
 * client graph, which is why this module deliberately imports nothing
 * beyond the session helpers.
 */
import { createServerFn } from "@tanstack/react-start";

import { getAdminEmails, getSessionUser } from "@/lib/auth/session";

/**
 * Read-only probe: is the current session user an admin?
 *
 * Returns a discriminated union so the UI can branch cleanly:
 *   - `{ signedIn: false }` → redirect to sign-in
 *   - `{ signedIn: true, isAdmin: false }` → render 403 panel
 *   - `{ signedIn: true, isAdmin: true }` → render admin UI
 *
 * Never throws for "not an admin" — thrown errors are for exceptional
 * failures (e.g. auth subsystem down), not for routine branching.
 */
export const checkAdminFn = createServerFn({ method: "GET" }).handler(async () => {
  const user = await getSessionUser();
  if (!user) return { signedIn: false as const, isAdmin: false as const };
  const allowed = await getAdminEmails();
  const email = user.email?.toLowerCase();
  const isAdmin = Boolean(email && allowed.has(email));
  return { signedIn: true as const, isAdmin, email: user.email ?? null };
});

/**
 * Read-only probe for the current session's lightweight profile.
 * Returns `null` for anonymous callers so route loaders can branch
 * between "render public view" and "redirect to sign-in" without
 * throwing. Lives alongside `checkAdminFn` so client-side imports stay
 * behind the same lean import boundary (no db / workers pulls into the
 * client graph).
 */
export const getMeFn = createServerFn({ method: "GET" }).handler(async () => {
  const user = await getSessionUser();
  if (!user) return null;
  // Narrow shape: pass only what routes actually need (id, username for
  // profile links, email for the header). Extra fields would force us
  // to keep the `user` type in sync across the client.
  return {
    id: user.id,
    email: user.email ?? null,
    username: (user as { username?: string }).username ?? null,
  };
});
