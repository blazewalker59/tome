/**
 * One-off: wipe a user's entire `collection_cards` state by email.
 *
 * Intended for development/testing — resets the in-game shelf so you
 * can verify empty-state flows, re-rip starter packs from scratch, or
 * reproduce a first-pack bug on an account that's already ripped.
 *
 * Scope is intentionally narrow: `collection_cards` only. The reading
 * log (`reading_entries`), shard balance (`shard_balances`), shard
 * ledger (`shard_events`), and rip audit log (`pack_rips`) all stay
 * intact so you can see "I had X shards and Y rips before the reset"
 * in history. If you want a deeper wipe, extend this or write a
 * sibling script — don't quietly broaden this one.
 *
 * `collection_cards` has no inbound FKs, so a plain DELETE by user_id
 * is sufficient — no cascade ordering to worry about.
 *
 * Re-runnable: logs 0 when there's nothing to delete.
 *
 * Same runtime posture as `migrate.ts` / `rebucket.ts`: Node +
 * `postgres-js` against the pooled Neon URL.
 *
 * Exit codes:
 *   0 — deleted N rows (including N=0)
 *   1 — missing DATABASE_URL, user not found, or a query failed
 */
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env.local' })
loadEnv()

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { collectionCards, users } from '../src/db/schema'

// Hard-coded rather than argv-driven on purpose: this is a one-off
// dev aid, not a general admin tool. Flip the literal below if you
// need to point it at a different account.
const TARGET_EMAIL = 'blazewalker59@gmail.com'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('[reset-collection] Missing DATABASE_URL. Set it in .env.local.')
  process.exit(1)
}

const client = postgres(url, { max: 1 })
const db = drizzle(client, { schema: { users, collectionCards } })

try {
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, TARGET_EMAIL))
    .limit(1)

  if (!user) {
    console.error(`[reset-collection] ✗ no user with email "${TARGET_EMAIL}".`)
    process.exit(1)
  }

  const deleted = await db
    .delete(collectionCards)
    .where(eq(collectionCards.userId, user.id))
    .returning({ bookId: collectionCards.bookId })

  console.log(
    `[reset-collection] ✓ cleared ${deleted.length} collection row(s) for ${user.email} (${user.id}).`,
  )
} catch (err) {
  console.error('[reset-collection] ✗ failed:', err)
  process.exitCode = 1
} finally {
  await client.end()
}
