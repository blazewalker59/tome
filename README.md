# Tome

> A trading-card app for readers. Rip themed packs, discover books, build decks to share.

See **[SPEC.md](./SPEC.md)** for the full v1 product specification.

## Stack

- **Framework:** [TanStack Start](https://tanstack.com/start) (Vite + Router + server functions)
- **DB:** [Neon](https://neon.tech) Postgres + [Drizzle ORM](https://orm.drizzle.team)
- **Auth:** [Better Auth](https://better-auth.com) (Google OAuth)
- **Books data:** [Hardcover GraphQL API](https://hardcover.app) (not yet wired)
- **UI:** React 19 + Tailwind v4 + Motion
- **Tests:** Vitest + MSW
- **Deploy:** Cloudflare Workers via Nitro `cloudflare-module` preset

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in DATABASE_URL, BETTER_AUTH_*, GOOGLE_*
pnpm db:migrate              # apply migrations to your Neon project
pnpm db:seed                 # seed 12 mock books + editorial pack
```

## Common commands

```bash
pnpm dev                # start dev server on http://localhost:3000
pnpm test               # run the test suite
pnpm build              # production Node build
pnpm build:cf           # production Cloudflare Workers build
pnpm cf:preview         # build + `wrangler dev` on http://localhost:8787
```

## Database

```bash
pnpm db:generate        # create a migration from schema changes
pnpm db:migrate         # apply migrations
pnpm db:studio          # browse the DB in a browser UI
pnpm db:seed            # seed mock data
```

Schema lives at [`src/db/schema.ts`](./src/db/schema.ts). Migrations are in `src/db/migrations/`.

Use Neon's **pooled** connection string (host contains `-pooler`) for `DATABASE_URL`. The runtime driver is `drizzle-orm/neon-serverless` + `@neondatabase/serverless` `Pool` (WebSocket transport), which supports interactive transactions — required by the pack-rip server function.

## Auth

Better Auth mounts at `/api/auth/*`. The Worker entry (`src/server.ts`) pre-dispatches those paths to Better Auth's handler before falling through to the TanStack Start stream handler. Sessions are cookie-based (no client-side token storage).

Google OAuth redirect URIs (set in Google Cloud Console):

- `http://localhost:3000/api/auth/callback/google` (vite dev)
- `http://localhost:8787/api/auth/callback/google` (`pnpm cf:preview`)
- `https://<prod-domain>/api/auth/callback/google`

`BETTER_AUTH_URL` must match the origin you're actually serving from — it's used to build the Google redirect URL. `trustedOrigins` in `src/lib/auth/server.ts` whitelists the two localhost ports so dev works on either.

## Deploy to Cloudflare Workers

First time:

```bash
pnpm wrangler login
pnpm cf:secret DATABASE_URL            # Neon pooled URL
pnpm cf:secret BETTER_AUTH_SECRET      # openssl rand -base64 32
pnpm cf:secret BETTER_AUTH_URL         # https://<prod-domain>
pnpm cf:secret GOOGLE_CLIENT_ID
pnpm cf:secret GOOGLE_CLIENT_SECRET
pnpm cf:deploy                         # build + deploy
```

All runtime secrets live in Worker secrets, not in the `vars` block of `wrangler.json`. No `VITE_*` public env vars are baked into the client bundle — Better Auth's client discovers its base URL from `window.location.origin` at runtime, so the same bundle works across dev/preview/prod.

| Variable               | Where it's used | How it's set |
| ---------------------- | --------------- | ------------ |
| `DATABASE_URL`         | Server (Worker) | `wrangler secret put` (prod) / `.env.local` (dev) |
| `BETTER_AUTH_SECRET`   | Server (Worker) | `wrangler secret put` (prod) / `.env.local` (dev) |
| `BETTER_AUTH_URL`      | Server (Worker) | `wrangler secret put` (prod) / `.env.local` (dev) |
| `GOOGLE_CLIENT_ID`     | Server (Worker) | `wrangler secret put` (prod) / `.env.local` (dev) |
| `GOOGLE_CLIENT_SECRET` | Server (Worker) | `wrangler secret put` (prod) / `.env.local` (dev) |
| `HARDCOVER_API_TOKEN`  | Server (Worker) | `wrangler secret put` (prod) / `.env.local` (dev) |

### CI deploys

`.github/workflows/deploy.yml` deploys on push to `main`. Required repo secrets:

- `CLOUDFLARE_API_TOKEN` — Workers edit permission
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
