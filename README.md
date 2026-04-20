# Tome

> A trading-card app for readers. Rip themed packs, discover books, build decks to share.

See **[SPEC.md](./SPEC.md)** for the full v1 product specification.

## Stack

- **Toolchain:** [Vite+](https://viteplus.dev) (`vp` CLI)
- **Framework:** [TanStack Start](https://tanstack.com/start) (Vite + Router + server functions)
- **DB:** Supabase Postgres + [Drizzle ORM](https://orm.drizzle.team)
- **Books data:** [Hardcover GraphQL API](https://hardcover.app)
- **UI:** React 19 + Tailwind v4 + Motion
- **Tests:** Vitest + MSW

## Setup

```bash
vp install
cp .env.example .env  # fill in DATABASE_URL, Supabase, Hardcover keys
```

## Common commands

```bash
vp dev                # start dev server on http://localhost:3000
vp test               # run the test suite (required before any commit)
vp check              # format + lint + typecheck
vp check --fix        # auto-fix formatting/lint
vp build              # production build
```

## Database

```bash
vp exec drizzle-kit generate    # create a migration from schema changes
vp exec drizzle-kit migrate     # apply migrations to DATABASE_URL
vp exec drizzle-kit studio      # browse the DB
```

Schema lives at [`src/db/schema.ts`](./src/db/schema.ts). Migrations are in `src/db/migrations/`.

## Project layout

```
src/
├── db/                    # Drizzle schema, client, migrations
├── lib/                   # Pure logic (rarity bucketing, deck rules, etc.)
├── components/            # React components
├── routes/                # TanStack Router file-based routes
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
