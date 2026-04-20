/**
 * Apply pending Drizzle migrations to the configured Postgres database.
 *
 * Reads env from `.env.local` (via dotenv) — in particular DATABASE_MIGRATION_URL
 * (preferred) or DATABASE_URL as a fallback. Use the Supabase SESSION pooler
 * (port 5432) here; DDL does not work reliably through the transaction pooler.
 */
import { config as loadEnv } from 'dotenv'

// Load `.env.local` first (Vite convention, gitignored), then `.env`.
// dotenv does not overwrite existing env vars, so the first file wins.
loadEnv({ path: '.env.local' })
loadEnv()

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL

if (!url) {
  console.error(
    '[migrate] Missing DATABASE_MIGRATION_URL (or DATABASE_URL). ' +
      'Set it in .env.local — see .env.example for the Supabase connection-string format.',
  )
  process.exit(1)
}

// `max: 1` — migrations must run on a single, dedicated session so advisory
// locks and transactional DDL behave correctly.
const client = postgres(url, { max: 1 })
const db = drizzle(client)

try {
  console.log('[migrate] applying migrations…')
  await migrate(db, { migrationsFolder: './src/db/migrations' })
  console.log('[migrate] ✓ up to date')
} catch (err) {
  console.error('[migrate] ✗ failed:', err)
  process.exitCode = 1
} finally {
  await client.end()
}
