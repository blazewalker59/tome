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
    // Neon's pooled connection string handles both DDL and runtime queries,
    // so there is no session-vs-transaction-pooler split like we had with
    // Supabase. One URL rules them all.
    url: process.env.DATABASE_URL ?? '',
  },
  casing: 'snake_case',
  strict: true,
  verbose: true,
})
