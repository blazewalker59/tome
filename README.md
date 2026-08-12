# Tome

> A trading-card app for readers. Rip themed packs, discover books, build decks to share.

See **[SPEC.md](./SPEC.md)** for the full v1 product specification.

## Stack

- **Framework:** [TanStack Start](https://tanstack.com/start) (Vite + Router + server functions)
- **DB:** [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) + [Drizzle ORM](https://orm.drizzle.team)
- **Auth:** [Better Auth](https://better-auth.com) (Google OAuth)
- **Books data:** [Hardcover GraphQL API](https://hardcover.app) (not yet wired)
- **UI:** React 19 + Tailwind v4 + Motion
- **Tests:** Vitest + MSW
- **Deploy:** Cloudflare Workers via [@cloudflare/vite-plugin](https://developers.cloudflare.com/workers/vite-plugin/)

## Setup

```bash
bun install
cp .dev.vars.example .dev.vars   # fill in BETTER_AUTH_*, GOOGLE_*, HARDCOVER_*
bun run db:migrate:local         # create the local D1 database
bun run db:seed-editor-packs     # ingest the editorial starter packs
```

`bun run dev` runs inside workerd via `@cloudflare/vite-plugin`, so it gets a
real local D1 (miniflare-backed, stored under `.wrangler/state/`) rather than
a stub. Dev and production hit the same binding.

## Common commands

```bash
bun run dev             # dev server on http://localhost:3000 (real D1 binding)
bun run test            # watch the unit suite
bun run test:run        # run it once
bun run test:integration # run the real-D1 integration suite
bun run check           # prettier --check + eslint
bun run typecheck       # tsc --noEmit
bun run build           # production Cloudflare Workers build
bun run ci              # everything CI runs, in one command
bun run ship            # ci + deploy
```

## Database

```bash
bun run db:generate     # create a migration from schema changes
bun run db:migrate:local   # apply migrations to the local D1
bun run db:migrate:remote  # apply migrations to production D1
bun run db:studio       # browse the DB in a browser UI
bun run db:seed-editor-packs  # ingest 5 real-Hardcover editorial starter packs
bun run db:rebucket     # recompute rarity buckets across the catalog
```

Schema lives at [`src/db/schema.ts`](./src/db/schema.ts). Migrations are SQL
files in `drizzle/`, applied by wrangler (which tracks what it has run in D1's
own `d1_migrations` table) — not by drizzle-kit.

### Tests

Two suites, deliberately separate:

| | runtime | covers |
| --- | --- | --- |
| `bun run test:run` | node / jsdom | pure logic, components, server-fn branch behaviour against fakes |
| `bun run test:integration` | workerd + real D1 | anything that touches the database |

The split exists because two bugs shipped that no amount of unit testing could
have caught. Both type-checked, both passed unit tests against a hand-written
fake, and neither could execute:

- `spendShards` batched a statement built with ``db.run(sql`...`)``. Drizzle's
  D1 batch reaches for a `.stmt` that raw statements never have, so every pack
  rip threw `Cannot read properties of undefined (reading 'bind')`.
- `grantShards` targeted the partial unique index with
  `onConflictDoNothing({ target, where })`. Drizzle emits the index predicate
  *after* `DO NOTHING`; SQLite requires it before, and rejects the statement.

The integration suite applies the same `./drizzle` migrations wrangler applies
to production, so schema drift surfaces there too. It needs no Cloudflare
credentials — miniflare runs D1 locally.

### Things D1 does not have

The app moved off Neon Postgres, and three differences shape the code:

- **No interactive transactions.** `db.transaction()` on the D1 driver runs
  the callback with *no* `BEGIN` — it gives no atomicity while looking like it
  does. Use `db.batch([...])`, which D1 executes atomically.
- **No `SELECT ... FOR UPDATE`.** The shard ledger debits with a
  compare-and-swap (`WHERE shards >= amount`, checking rows affected) instead
  of a row lock. See [`src/lib/economy/ledger.ts`](./src/lib/economy/ledger.ts).
- **No arrays.** `books.authors` and friends are JSON columns. Since no index
  can serve a predicate inside a JSON array, `books.authors_text` carries a
  flattened copy for search. Both are written through one helper —
  [`src/db/authors.ts`](./src/db/authors.ts) — and never separately.

Node scripts in `scripts/` cannot use the binding (it only exists inside a
Worker), so they reach D1 over its HTTP API via `scripts/_db.ts`. That is what
the `CLOUDFLARE_*` variables in `.env.example` are for; the app itself needs
none of them.

## Auth

Better Auth mounts at `/api/auth/*`. The Worker entry (`src/server.ts`) pre-dispatches those paths to Better Auth's handler before falling through to the TanStack Start stream handler. Sessions are cookie-based (no client-side token storage).

Google OAuth redirect URIs (set in Google Cloud Console):

- `http://localhost:3000/api/auth/callback/google` (vite dev)
- `http://localhost:8787/api/auth/callback/google` (`wrangler dev`)
- `https://<prod-domain>/api/auth/callback/google`

`BETTER_AUTH_URL` must match the origin you're actually serving from — it's used to build the Google redirect URL. It lives in `wrangler.jsonc`'s `vars` (dev default `http://localhost:3000`, production `https://tome.blazewalker59.workers.dev`), not in Worker secrets: it's the site's own address, not a credential. `trustedOrigins` in `src/lib/auth/server.ts` whitelists the two localhost ports so dev works on either.

## Deploy to Cloudflare Workers

First time:

```bash
bunx wrangler login
bunx wrangler secret put BETTER_AUTH_SECRET --name tome   # openssl rand -base64 32
bunx wrangler secret put GOOGLE_CLIENT_ID --name tome
bunx wrangler secret put GOOGLE_CLIENT_SECRET --name tome
bunx wrangler secret put HARDCOVER_API_TOKEN --name tome
bunx wrangler secret put ADMIN_EMAILS --name tome
bun run ship                                              # ci + deploy
```

There is no `DATABASE_URL`. The database is the `DB` binding declared in
[`wrangler.jsonc`](./wrangler.jsonc), which is also the single source of truth
for dev, build, and deploy.

All runtime secrets live in Worker secrets, not in the `vars` block of `wrangler.json`. No `VITE_*` public env vars are baked into the client bundle — Better Auth's client discovers its base URL from `window.location.origin` at runtime, so the same bundle works across dev/preview/prod.

| Variable               | Where it's used | How it's set |
| ---------------------- | --------------- | ------------ |
| `BETTER_AUTH_SECRET`   | Server (Worker) | `wrangler secret put` (prod) / `.dev.vars` (dev) |
| `BETTER_AUTH_URL`      | Server (Worker) | plain `vars` in `wrangler.jsonc` — not a secret |
| `GOOGLE_CLIENT_ID`     | Server (Worker) | `wrangler secret put` (prod) / `.dev.vars` (dev) |
| `GOOGLE_CLIENT_SECRET` | Server (Worker) | `wrangler secret put` (prod) / `.dev.vars` (dev) |
| `HARDCOVER_API_TOKEN`  | Server (Worker) | `wrangler secret put` (prod) / `.dev.vars` (dev) |
| `ADMIN_EMAILS`         | Server (Worker) | `wrangler secret put` (prod) / `.dev.vars` (dev) |

### CI deploys

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs on every PR and
on pushes to `main`:

```
PR:        checks ─┐
           test   ─┴─ gate only

push main: checks(+artifact) ─┬─ migrate ─ deploy
           test              ─┘
```

`checks` folds lint, typecheck, and build into one job; `test` shards 3 ways
(the runners, not the suite, are the bottleneck). `migrate` applies pending D1
migrations **before** `deploy`, so new code never meets an old schema — and a
failed migration blocks the deploy rather than half-landing it. `deploy`
downloads the `dist/` artifact from `checks` instead of rebuilding, so the
bytes that passed the gate are the bytes that ship.

Required repo secrets:

- `CLOUDFLARE_API_TOKEN` — Workers + D1 edit permission
- `CLOUDFLARE_ACCOUNT_ID` — from Cloudflare dashboard sidebar

No build-time public env vars are needed — the client bundle has no embedded auth/DB config.

## Project layout

```
src/
├── db/                    # Drizzle schema, client, migrations
├── lib/                   # Pure logic (rarity bucketing, deck rules, etc.)
│   └── auth/              # Better Auth server + client + session helpers
├── components/            # React components
├── routes/                # TanStack Router file-based routes
├── server/                # Server-only modules (createServerFn targets)
├── server.ts              # Worker fetch entry (pre-dispatches /api/auth/*)
├── styles.css             # Tailwind + theme tokens
└── __tests__/             # All tests (mirror source paths)
    ├── _setup/            # vitest setup, MSW handlers, factories
    ├── components/
    └── lib/
```

## Path aliases

- `@/*` → `src/*`
- `@test/*` → `src/__tests__/_setup/*`
- `#/*` → `src/*` (legacy from scaffold)

## Testing rules

See [`/Users/blazewalker/AGENTS.md`](file:///Users/blazewalker/AGENTS.md) for the full agent rules. Short version:

- All tests live under `src/__tests__/`, mirroring source paths.
- Default test environment is **node**. Component tests opt into jsdom with `// @vitest-environment jsdom` at the top of the file.
- HTTP is mocked with **MSW** (`src/__tests__/_setup/msw/handlers.ts`).
- Domain mocks come from **factories** (`src/__tests__/_setup/factories/`).
