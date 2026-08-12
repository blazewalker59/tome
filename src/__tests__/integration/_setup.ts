import { applyD1Migrations, env } from "cloudflare:test";

/**
 * Bring the test database up to the current schema before each test file.
 *
 * The migrations come from ./drizzle — the same SQL `wrangler d1 migrations
 * apply` runs against production — so a schema change that breaks a query
 * fails here rather than after deploy. Nothing is hand-maintained.
 *
 * Storage is isolated per test file by vitest-pool-workers, so each file gets
 * a clean database and files can't leak rows into each other.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
