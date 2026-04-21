/**
 * Browser-side Better Auth client.
 *
 * The single place we wire `createAuthClient` so every consumer (hooks,
 * sign-in button, sign-out button) talks to the same underlying store. The
 * React adapter gives us a `useSession()` hook backed by a nanostores atom
 * — that's what powers the `useAuth`/`useUser` convenience hooks in
 * `./hooks`.
 *
 * `baseURL` resolution: the catch-all server route lives at `/api/auth/*`
 * on whatever origin the client loaded from, so we only need to hand Better
 * Auth the origin. On the server (during SSR) `window` is undefined — we
 * fall back to `VITE_APP_URL` if set, otherwise an empty string (Better
 * Auth then uses relative paths, which is fine because SSR never actually
 * fires network requests through this client).
 *
 * `inferAdditionalFields` plumbs the extra columns we declared on the
 * server (`username`, `displayName`, `avatarUrl`) through to the client's
 * `Session['user']` type so `session.user.username` is statically typed.
 * We pass `typeof getAuth` here; the call is type-only (never evaluated
 * in the browser bundle) so importing the server module's type is safe.
 */

import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";
import type { getAuth } from "./server";

function resolveBaseURL(): string {
  // Build-time override, useful for previews or when the CF Worker
  // serves under a non-origin path.
  const fromEnv = import.meta.env.VITE_APP_URL as string | undefined;
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

export const authClient = createAuthClient({
  baseURL: resolveBaseURL(),
  plugins: [inferAdditionalFields<Awaited<ReturnType<typeof getAuth>>>()],
});

export const { useSession, signIn, signOut } = authClient;
