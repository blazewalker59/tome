/**
 * Better Auth server instance.
 *
 * Why a factory (and not a module-level `const auth = betterAuth(...)`)?
 * On Cloudflare Workers, env bindings — including Better Auth's secret
 * and Google's client id/secret — are only populated after the first
 * `fetch` handler invocation. Reading them at module eval gives you
 * undefined. We resolve lazily on every call; the DB instance is itself
 * per-request (see `src/db/client.ts`) so there's nothing to cache here
 * anyway.
 *
 * The returned object is what you hand to Better Auth's route handler and
 * the Drizzle adapter. It exposes `auth.handler(request)` for the HTTP
 * endpoint and `auth.api.getSession(...)` for reading the current session
 * inside server functions.
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { getEconomy } from "@/lib/economy/config";
import { grantShards } from "@/lib/economy/ledger";
import { deriveUsername } from "./username";

async function requireEnv(name: string): Promise<string> {
  const v = await getEnv(name);
  if (!v) {
    throw new Error(
      `[tome/auth] Missing ${name}. On Cloudflare Workers set it as a ` +
        `secret (\`wrangler secret put ${name} --name tome\`). Locally put ` +
        `it in .env.local — see .env.example.`,
    );
  }
  return v;
}

export async function getAuth() {
  const db = await getDb();
  const [secret, baseURL, googleClientId, googleClientSecret] = await Promise.all([
    requireEnv("BETTER_AUTH_SECRET"),
    requireEnv("BETTER_AUTH_URL"),
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
  ]);

  return betterAuth({
    // Our Drizzle schema uses plural table names (users, sessions, …).
    // The adapter maps Better Auth's singular model names to those tables
    // via `usePlural: true`. This is preferred over renaming our tables
    // because every FK in the app already points at `users.id`.
    database: drizzleAdapter(db, {
      provider: "pg",
      usePlural: true,
    }),
    secret,
    baseURL,
    // `baseURL` is the canonical origin used to build OAuth callback URLs.
    // `trustedOrigins` additionally whitelists origins that may send auth
    // requests (CSRF check). In local dev `wrangler dev` serves on :8787
    // while `vite dev` serves on :3000 — we allow both so either entry
    // point works without editing env between runs. Production only ever
    // hits `BETTER_AUTH_URL`, so the extra localhost entries are harmless.
    trustedOrigins: [
      "http://localhost:3000",
      "http://localhost:8787",
    ],
    socialProviders: {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
      },
    },
    user: {
      additionalFields: {
        // These three columns live on our `users` table alongside Better
        // Auth's core fields. `input: false` means they can't be set by
        // the client at sign-up time — the create hook populates them
        // from the Google profile instead.
        username: {
          type: "string",
          required: true,
          input: false,
        },
        displayName: {
          type: "string",
          required: false,
          input: false,
        },
        avatarUrl: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Derive a unique username and populate our app fields. This
            // replaces the old `handle_new_user()` SQL trigger from the
            // Supabase era — now executed atomically in the same request
            // as the Google OAuth callback, so no window where a user
            // exists in `users` without a username.
            const username = await deriveUsername(db, {
              id: user.id,
              email: user.email,
              name: user.name,
            });
            return {
              data: {
                ...user,
                username,
                displayName: user.name ?? username,
                avatarUrl: user.image ?? null,
              },
            };
          },
          // Runs after the user row has been committed. Idempotent by
          // design — grantShards writes to the uncapped `welcome_grant`
          // reason which has no uniqueness guard, so in the exotic case
          // where Better Auth retried the hook we'd double-grant. Guard
          // with a read of existing welcome_grant rows? Not yet; the
          // `create.after` hook is documented as firing exactly once per
          // successful create and there's no retry path inside Better
          // Auth that would fire it twice.
          after: async (user) => {
            const cfg = await getEconomy();
            if (cfg.welcomeGrant <= 0) return;
            // Grants happen on their own mini-transaction since Better
            // Auth doesn't hand us the user-create transaction. Failure
            // here MUST NOT roll back the user — log and continue. A
            // missing welcome grant is recoverable (admin can top them
            // up); a failed user create because of a grant error is not.
            try {
              await db.transaction(async (tx) => {
                await grantShards(tx, user.id, "welcome_grant", cfg.welcomeGrant);
              });
            } catch (err) {
              console.error("[tome/auth] welcome grant failed", {
                userId: user.id,
                cause: (err as Error)?.cause ?? err,
              });
            }
          },
        },
      },
    },
    advanced: {
      database: {
        // Stay on Postgres `uuid` primary keys to match the rest of the
        // schema. Without this Better Auth would generate its own string
        // ids and our FK column types (all `uuid`) would mismatch.
        generateId: () => crypto.randomUUID(),
      },
    },
  });
}

/** Typed handle to `auth.api` — convenience for server-function callers. */
export type Auth = Awaited<ReturnType<typeof getAuth>>;
