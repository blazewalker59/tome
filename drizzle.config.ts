import { config as loadEnv } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// Load `.env.local` first (gitignored), then `.env`. First-set wins.
loadEnv({ path: '.env.local' })
loadEnv()

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Prefer the session-pooler URL for DDL (drizzle-kit generate/push/migrate).
    // Falls back to DATABASE_URL so local/dev setups with a single URL still work.
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? '',
  },
  casing: 'snake_case',
  strict: true,
  verbose: true,
})
