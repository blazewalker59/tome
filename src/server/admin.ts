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
