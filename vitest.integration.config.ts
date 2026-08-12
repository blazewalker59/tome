import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

/**
 * Integration tests: real code against a real D1, in-process.
 *
 * Separate from vitest.config.ts because the two need different runtimes. The
 * unit suite runs on node/jsdom with hand-written fakes; this one runs inside
 * workerd with an actual D1 binding, so `db.batch()`, prepared statements,
 * SQLite's own JSON functions, and column type affinity all behave the way
 * they do in production instead of the way a fake was written to behave.
 *
 * This exists because of a specific bug. `spendShards` built a statement with
 * `db.run(sql\`...\`)` and batched it. That type-checked (SQLiteRaw is a legal
 * BatchItem), the SQL was verified by hand against D1, and the unit tests
 * passed against a fake whose `batch()` accepted anything — and it still threw
 * on every call in production, because drizzle's batch reaches for a `.stmt`
 * that raw statements never have. Three layers of checking all passed a
 * statement that could not run. The only thing that would have caught it is
 * executing it.
 *
 * Migrations are read from ./drizzle and applied per test file (see
 * _setup.ts), so the schema under test is the same SQL wrangler applies to
 * production — not a hand-maintained copy that can drift.
 *
 * Note the API here is @cloudflare/vitest-pool-workers 0.21+, which replaced
 * the older `defineWorkersConfig` / `"…/config"` subpath with a plain Vite
 * plugin. Older docs and examples still show the previous form.
 */
const migrations = await readD1Migrations("./drizzle");

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Storage is isolated per test FILE, not per test — tests reset the
      // database themselves via `resetDb()` in _helpers.ts.
      miniflare: {
        // Match wrangler.jsonc. nodejs_compat is required — Drizzle and
        // Better Auth both reach for node builtins.
        compatibilityDate: "2025-01-04",
        compatibilityFlags: ["nodejs_compat"],
        // Binding name matches production (`env.DB`), so src/db/client.ts
        // works unmodified.
        d1Databases: { DB: "tome-test" },
        // Handed to applyD1Migrations in the setup file.
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "@test": new URL("./src/__tests__/_setup", import.meta.url).pathname,
      "#": new URL("./src", import.meta.url).pathname,
      // See _tanstack-stub.ts: server modules import createServerFn, which
      // resolves virtual entry specifiers that only exist in the real
      // dev/build pipeline.
      "#tanstack-router-entry": new URL(
        "./src/__tests__/integration/_tanstack-stub.ts",
        import.meta.url,
      ).pathname,
      "#tanstack-start-entry": new URL(
        "./src/__tests__/integration/_tanstack-stub.ts",
        import.meta.url,
      ).pathname,
      "#tanstack-start-plugin-adapters": new URL(
        "./src/__tests__/integration/_tanstack-stub.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    setupFiles: ["./src/__tests__/integration/_setup.ts"],
  },
});
