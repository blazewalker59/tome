# Tome

> A trading-card app for readers. Rip themed packs, discover books, build decks to share.

See **[SPEC.md](./SPEC.md)** for the full v1 product specification.

## Stack

- **Framework:** [TanStack Start](https://tanstack.com/start) (Vite + Router + server functions)
- **DB:** Supabase Postgres + [Drizzle ORM](https://orm.drizzle.team)
- **Auth:** Supabase Auth (Google OAuth via PKCE)
- **Books data:** [Hardcover GraphQL API](https://hardcover.app) (not yet wired)
- **UI:** React 19 + Tailwind v4 + Motion
- **Tests:** Vitest + MSW
- **Deploy:** Cloudflare Workers via Nitro `cloudflare-module` preset

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in Supabase + DATABASE_URL
pnpm db:migrate              # apply migrations to your Supabase project
pnpm db:seed                 # seed 12 mock books + editorial pack
```

## Common commands

```bash
pnpm dev                # start dev server on http://localhost:3000
pnpm test               # run the test suite
pnpm build              # production Node build
pnpm build:cf           # production Cloudflare Workers build
```

## Database

```bash
pnpm db:generate        # create a migration from schema changes
pnpm db:migrate         # apply migrations (uses DATABASE_MIGRATION_URL)
pnpm db:studio          # browse the DB in a browser UI
pnpm db:seed            # seed mock data
```

Schema lives at [`src/db/schema.ts`](./src/db/schema.ts). Migrations are in `src/db/migrations/`.

`DATABASE_URL` should point at the Supabase **transaction pooler** (port 6543). `DATABASE_MIGRATION_URL` should point at the **session pooler** (port 5432) for DDL and advisory locks.

## Deploy to Cloudflare Workers

First time:

```bash
pnpm wrangler login                              # OAuth once
pnpm cf:secret DATABASE_URL                      # transaction-pooler URL (port 6543)
pnpm cf:secret SUPABASE_URL                      # https://<ref>.supabase.co
pnpm cf:secret SUPABASE_PUBLISHABLE_KEY          # sb_publishable_…
pnpm cf:deploy                                   # build + deploy
```

Env vars split into two categories — important to keep straight:

| Variable                         | Where it's used | How it's set |
| -------------------------------- | --------------- | ------------ |
| `VITE_SUPABASE_URL`              | Client bundle   | `.env.local` (dev) / GitHub secret (CI). Baked in at `vite build` time. |
| `VITE_SUPABASE_PUBLISHABLE_KEY`  | Client bundle   | same as above |
| `SUPABASE_URL`                   | Server (Worker) | `wrangler secret put SUPABASE_URL` (prod) / `.dev.vars` (local `wrangler dev`). Falls back to `VITE_SUPABASE_URL` so `pnpm dev` keeps working off `.env.local` alone. |
| `SUPABASE_PUBLISHABLE_KEY`       | Server (Worker) | same pattern |
| `DATABASE_URL`                   | Server (Worker) | `wrangler secret put DATABASE_URL` (prod) / `.env.local` (dev via `pnpm dev`) / `.dev.vars` (local `wrangler dev`) |
| `DATABASE_MIGRATION_URL`         | Dev machine only (migrations) | `.env.local` |

The OAuth redirect URL is derived at runtime from `window.location.origin`, so the same bundle works across dev, preview, and production without a rebuild. Supabase's **Redirect URLs** allow-list must include every origin you deploy to (localhost + every preview/prod URL).

Put non-`VITE_` server vars in **Worker secrets**, not in the `vars` block of `wrangler.json`.

### CI deploys

`.github/workflows/deploy.yml` deploys on push to `main`. Required repo secrets:

- `CLOUDFLARE_API_TOKEN` — Workers edit permission
- `CLOUDFLARE_ACCOUNT_ID` — from Cloudflare dashboard sidebar
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` — baked into the client bundle during CI build

## Project layout

```
src/
├── db/                    # Drizzle schema, client, migrations
├── lib/                   # Pure logic (rarity bucketing, deck rules, etc.)
├── components/            # React components
├── routes/                # TanStack Router file-based routes
├── server/                # Server-only modules (createServerFn targets)
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
