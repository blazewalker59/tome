# Migration Plan: Supabase → Neon + Better Auth

## Goals & constraints

- **Keep:** TanStack Start, Cloudflare Workers, Drizzle, the domain schema, Google OAuth as the only sign-in method, the `getSessionUser()` gate pattern in server functions, session-via-cookies.
- **Replace:** Supabase-hosted Postgres → Neon; `@supabase/ssr` + `@supabase/supabase-js` → Better Auth.
- **Drop:** The `auth.users → public.users` trigger (Better Auth writes directly to tables we own).
- **Data loss tolerance:** Pre-launch. We'll still do a clean `pg_dump` of `public.*` as a safety net, but treat user accounts as **re-creatable** (they re-sign-in with Google post-migration; `users.id` becomes a Better Auth-generated id, not the old Supabase UUID).
- **Downtime:** ~30-minute cutover window. Rollback = point `DATABASE_URL` back + revert commit.

## Key design decisions

1. **Neon HTTP driver, not postgres-js.** Swap `drizzle-orm/postgres-js` → `drizzle-orm/neon-http` with `@neondatabase/serverless`. Kills the `prepare: false, max: 1, idle_timeout` dance in `src/db/client.ts` — the HTTP driver has no sockets to manage on Workers.
2. **Better Auth owns `users`.** Rather than the "mirror `auth.users` into `public.users`" indirection, Better Auth's `user` table **becomes** our `users` table (rename to Better Auth's defaults: `user`, `session`, `account`, `verification`). All existing FKs (`decks.user_id`, `collection_cards.user_id`, etc.) continue to reference `user.id` — just a table name change. Keep `username`, `display_name`, `avatar_url` on the `user` table via Better Auth's `additionalFields`.
3. **One database URL.** Neon doesn't need the session-pooler/transaction-pooler split. `DATABASE_URL` is enough; delete `DATABASE_MIGRATION_URL`.
4. **Sign-in UX unchanged.** `/sign-in` and the callback flow keep working; only their guts change. Better Auth's `authClient.signIn.social({ provider: 'google' })` replaces `supabase.auth.signInWithOAuth`, and Better Auth's server handler replaces the manual PKCE exchange on `/auth/callback`.
5. **No RLS, ever.** Same authz model as today: server functions call `getSessionUser()` and gate access in TS.

## Phases & tasks

### Phase 0 — Prep (no code changes)

- [ ] Create Neon project; grab `DATABASE_URL` (pooled).
- [ ] In Google Cloud Console, add Better Auth redirect URIs: `https://<prod-domain>/api/auth/callback/google` and `http://localhost:3000/api/auth/callback/google`. Keep the old Supabase URIs until cutover is confirmed.
- [ ] Take a `pg_dump --schema=public --data-only` of Supabase as a safety net.

### Phase 1 — Dependencies & env

- [ ] Create branch `feat/neon-better-auth`.
- [ ] Add deps:
  ```
  pnpm add @neondatabase/serverless better-auth
  pnpm remove @supabase/ssr @supabase/supabase-js postgres
  ```
- [ ] Update `.env.local` + `.env.example`:
  - Add `DATABASE_URL=` (Neon)
  - Add `BETTER_AUTH_SECRET=` (generate: `openssl rand -base64 32`)
  - Add `BETTER_AUTH_URL=http://localhost:3000`
  - Add `GOOGLE_CLIENT_ID=` / `GOOGLE_CLIENT_SECRET=`
  - Remove all `SUPABASE_*` / `VITE_SUPABASE_*` / `DATABASE_MIGRATION_URL`.
- [ ] Set Worker secrets with `wrangler secret put` for each; remove the old Supabase ones.

### Phase 2 — Drizzle client swap

- [ ] Rewrite `src/db/client.ts` to use `neon-http`:
  ```ts
  import { drizzle } from 'drizzle-orm/neon-http'
  import { neon } from '@neondatabase/serverless'
  import * as schema from './schema'
  import { getEnv } from '@/lib/env'

  export async function getDb() {
    const url = await getEnv('DATABASE_URL')
    if (!url) throw new Error('[tome/db] DATABASE_URL not set')
    return drizzle(neon(url), { schema })
  }
  export { schema }
  ```
- [ ] Update `drizzle.config.ts`: drop `DATABASE_MIGRATION_URL` fallback.
- [ ] Update `scripts/migrate.ts` to use `neon-http` (or keep `postgres-js` just for migrations if the migrator API demands it).

### Phase 3 — Schema changes for Better Auth

- [ ] Add Better Auth's required tables to `src/db/schema.ts`: `user`, `session`, `account`, `verification`.
  - **Rename** existing `users` table → `user` (Better Auth convention).
  - **Merge** custom columns (`username`, `display_name`, `avatar_url`) onto `user` as `additionalFields`.
  - Use `text` for `user.id` (Better Auth default). Flip every FK currently typed `uuid('user_id')` to `text('user_id')`.
- [ ] Update every `relations()` block referencing `users` (~8 spots).
- [ ] Squash migrations: delete `src/db/migrations/*` + `meta/`, run `pnpm db:generate` against a fresh Neon DB to produce a single clean `0000_initial.sql`.
- [ ] **Delete** `src/db/migrations/0001_auth_user_sync_trigger.sql` (no longer needed).

### Phase 4 — Better Auth server setup

- [ ] Create `src/lib/auth/server.ts`:
  ```ts
  import { betterAuth } from 'better-auth'
  import { drizzleAdapter } from 'better-auth/adapters/drizzle'
  import { getDb } from '@/db/client'
  import { getEnv } from '@/lib/env'

  export async function getAuth() {
    const db = await getDb()
    return betterAuth({
      database: drizzleAdapter(db, { provider: 'pg' }),
      secret: await getEnv('BETTER_AUTH_SECRET'),
      baseURL: await getEnv('BETTER_AUTH_URL'),
      socialProviders: {
        google: {
          clientId: (await getEnv('GOOGLE_CLIENT_ID'))!,
          clientSecret: (await getEnv('GOOGLE_CLIENT_SECRET'))!,
        },
      },
      user: {
        additionalFields: {
          username: { type: 'string', required: true, unique: true },
          displayName: { type: 'string', required: false },
          avatarUrl: { type: 'string', required: false },
        },
      },
      databaseHooks: {
        user: {
          create: {
            before: async (user) => ({
              data: { ...user, username: await deriveUsername(user) },
            }),
          },
        },
      },
    })
  }
  ```
- [ ] Port username derivation from `handle_new_user()` (old trigger lines 33-55) into a TS helper: metadata → email local-part → uuid prefix, collision suffix.

### Phase 5 — Better Auth route handler

- [ ] Create `src/routes/api/auth/$.ts` (TanStack Start catch-all):
  ```ts
  import { createServerFileRoute } from '@tanstack/react-start/server'
  import { getAuth } from '@/lib/auth/server'

  async function handle({ request }: { request: Request }) {
    const auth = await getAuth()
    return auth.handler(request)
  }

  export const ServerRoute = createServerFileRoute('/api/auth/$').methods({
    GET: handle, POST: handle,
  })
  ```
- [ ] **Delete** `src/routes/auth/callback.tsx` — Better Auth handles `/api/auth/callback/google`.

### Phase 6 — Client auth surface

- [ ] Create `src/lib/auth/client.ts`:
  ```ts
  import { createAuthClient } from 'better-auth/react'
  export const authClient = createAuthClient({
    baseURL: import.meta.env.VITE_APP_URL ?? (typeof window !== 'undefined' ? window.location.origin : ''),
  })
  export const { useSession, signIn, signOut } = authClient
  ```
- [ ] Rewrite `src/lib/supabase/auth.ts` → `src/lib/auth/hooks.ts` preserving the public API (`useAuth`, `useUser`, `signOut`, `signInWithGoogle`). Import path changes in:
  - `src/components/Header.tsx`
  - `src/routes/sign-in.tsx`
- [ ] **Delete** `src/lib/supabase/{client,server,auth}.ts`.

### Phase 7 — Server-side session reader

- [ ] `src/lib/auth/session.ts`:
  ```ts
  import { getAuth } from './server'
  import { getRequestHeaders } from '@tanstack/react-start/server'

  export async function getSessionUser() {
    const auth = await getAuth()
    const session = await auth.api.getSession({
      headers: new Headers(getRequestHeaders() as Record<string, string>),
    })
    return session?.user ?? null
  }
  ```
- [ ] Update `src/server/collection.ts` import from `@/lib/supabase/server` → `@/lib/auth/session`. Callers unchanged.

### Phase 8 — Tests

- [ ] Replace Supabase mock in `src/__tests__/lib/supabase/auth.test.tsx` with Better Auth client mock. Move to `src/__tests__/lib/auth/hooks.test.tsx`.
- [ ] Update MSW handlers (if any) for Better Auth endpoints.
- [ ] Add test: server-side `getSessionUser()` returns `null` when no cookie present.

### Phase 9 — Cutover

- [ ] Point `DATABASE_URL` at Neon; run `pnpm db:migrate`.
- [ ] Run `pnpm db:seed`.
- [ ] `pnpm cf:preview` → smoke test:
  - Google sign-in round trip
  - New `user` row created with derived username
  - `/collection` loads for signed-in user
  - Pack rip still gates on auth
- [ ] `pnpm cf:deploy`.
- [ ] Remove old Supabase OAuth redirect URIs in Google Console.
- [ ] Pause (don't delete) the Supabase project for 1–2 weeks.

### Phase 10 — Cleanup

- [ ] Remove `VITE_SUPABASE_*` refs from `.env.example`, `README.md`, `SPEC.md`.
- [ ] Update comment in `src/db/client.ts`.
- [ ] Delete empty `src/lib/supabase/` directory.

## Files changed at a glance

| Action | File |
|---|---|
| Rewrite | `src/db/client.ts` |
| Rewrite | `src/db/schema.ts` |
| Delete | `src/db/migrations/*` (regenerate squashed) |
| Delete | `src/lib/supabase/{client,server,auth}.ts` |
| Delete | `src/routes/auth/callback.tsx` |
| New | `src/lib/auth/{server,client,hooks,session}.ts` |
| New | `src/routes/api/auth/$.ts` |
| Edit | `src/server/collection.ts` (import path) |
| Edit | `src/components/Header.tsx` (import path) |
| Edit | `src/routes/sign-in.tsx` (import path) |
| Edit | `drizzle.config.ts` |
| Edit | `package.json` |
| Move | `src/__tests__/lib/supabase/auth.test.tsx` → `lib/auth/hooks.test.tsx` |

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **TanStack Start catch-all route shape** may differ across versions. | Verify `createServerFileRoute('/api/auth/$')` against installed version. Fallback: mount Hono sub-app at `/api/auth`. |
| **Neon HTTP driver + Drizzle relational queries** — `neon-http` is per-roundtrip; multi-statement transactions need `sql.transaction([...])`. | Audit `src/server/` for multi-step writes that need atomicity; convert those explicitly. |
| **Username collisions on migration** — re-signing-in generates new `user.id`; pre-migration rows orphan. | Pre-launch, ~0 real users. Truncate before cutover; accept re-sign-in. |
| **CF Workers + Better Auth cookies** | Standard `Set-Cookie` via `Response`; works OOB. Verify in Phase 9 smoke test. |
| **Async DB check in create hook** — collision-suffix path issues a query mid-hook. | Neon HTTP is stateless; no deadlock. Same algorithm as old SQL trigger. |

## Estimated effort

- **Phases 1–4:** 3–4 hrs
- **Phases 5–7:** 3–4 hrs
- **Phase 8:** 1–2 hrs
- **Phases 9–10:** 1 hr
- **Total:** ~1 focused day.
