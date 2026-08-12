import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration for the Cloudflare D1 database.
 *
 * Migrations are generated from src/db/schema.ts into ./drizzle, then applied
 * to D1 with wrangler (which tracks applied migrations in its own
 * d1_migrations table — drizzle-kit does not apply them here):
 *
 *   bun run db:generate        # drizzle-kit generate
 *   bun run db:migrate:local   # wrangler d1 migrations apply tome-db --local
 *   bun run db:migrate:remote  # wrangler d1 migrations apply tome-db --remote
 *
 * The output directory is ./drizzle rather than the old
 * ./src/db/migrations because wrangler reads `migrations_dir` from
 * wrangler.jsonc, and keeping SQL out of src/ stops it being swept up by
 * tsconfig's include glob.
 *
 * `driver: "d1-http"` is only needed by `drizzle-kit studio` / `push`, which
 * talk to D1 over the Cloudflare API and require CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_DATABASE_ID and CLOUDFLARE_D1_TOKEN in the environment.
 * `generate` needs none of them — it only reads the schema file.
 */
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  strict: true,
  verbose: true,
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? "",
    token: process.env.CLOUDFLARE_D1_TOKEN ?? "",
  },
});
