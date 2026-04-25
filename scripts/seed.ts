/**
 * Legacy mock-data seeder — intentionally a no-op.
 *
 * The canonical seed is `pnpm db:seed-editor-packs`, which pulls real
 * catalog metadata from Hardcover and builds the five Modern <Genre>
 * Starter packs. The mock pool and the "Booker Shortlist 2024" demo
 * pack it produced have been removed from the codebase; this script
 * stays only so existing `pnpm db:seed` invocations (in CI, scripts,
 * README instructions) don't error out.
 *
 * Delete this file once there are no external references left.
 */

console.log(
  '[seed] This script is a no-op. The catalog is seeded from real data via `pnpm db:seed-editor-packs`.',
)
