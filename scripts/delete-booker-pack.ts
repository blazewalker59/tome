/**
 * One-off: delete the legacy "booker-shortlist-2024" editorial pack.
 *
 * The Booker pack was a visual-prototype stand-in from before the
 * catalog had real data. The five "Modern <Genre> Starter" packs
 * (seeded from Hardcover) now cover every user-facing surface, so the
 * Booker pack is dead weight — it still appears in the /rip carousel
 * and in any acquisition attributions from early testing. This script
 * removes it idempotently:
 *
 *   1. Look up the pack row by `(slug, creator_id IS NULL)`. Editorial
 *      namespace only — we'd never delete a user pack that happened to
 *      share the slug.
 *   2. Delete its `pack_rips` rows. This table's FK to `packs` is
 *      `ON DELETE RESTRICT` (the audit log isn't supposed to lose
 *      rows casually), so we have to clear it explicitly before the
 *      pack row itself is deletable. The shard ledger survives this:
 *      `shard_events.ref_rip_id` is `ON DELETE SET NULL`, so any
 *      refunds earned from Booker rips stay in the user's balance
 *      history with a null rip pointer.
 *   3. Delete its `pack_books` rows (FK dependency; the membership
 *      table is `ON DELETE CASCADE` so this is belt-and-braces).
 *   4. Delete the `packs` row. `collection_cards.first_acquired_from_pack_id`
 *      is `ON DELETE SET NULL` so any card attribution degrades to
 *      "Editorial pack" rather than disappearing.
 *
 * Books themselves stay. The starter packs don't overlap with the
 * Booker pool today, but if they ever do we don't want to nuke a
 * real catalog entry; orphaned books are harmless (they just aren't
 * reachable via rip), and a separate catalog-prune script can collect
 * them later if it matters.
 *
 * Re-runnable: if the pack has already been deleted the script logs
 * and exits cleanly.
 *
 * Same runtime posture as `migrate.ts` / `rebucket.ts`: Node +
 * `postgres-js` against the pooled Neon URL.
 *
 * Exit codes:
 *   0 — pack deleted OR already gone
 *   1 — missing DATABASE_URL or a query failed
 */
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env.local' })
loadEnv()

import { and, eq, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { packBooks, packRips, packs } from '../src/db/schema'

const BOOKER_SLUG = 'booker-shortlist-2024'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('[delete-booker-pack] Missing DATABASE_URL. Set it in .env.local.')
  process.exit(1)
}

const client = postgres(url, { max: 1 })
const db = drizzle(client, { schema: { packs, packBooks, packRips } })

try {
  // Editorial namespace: creator_id IS NULL. The partial unique index
  // `packs_editorial_slug_uq` guarantees at most one matching row.
  const [pack] = await db
    .select({ id: packs.id, name: packs.name })
    .from(packs)
    .where(and(eq(packs.slug, BOOKER_SLUG), isNull(packs.creatorId)))
    .limit(1)

  if (!pack) {
    console.log(`[delete-booker-pack] ✓ pack "${BOOKER_SLUG}" not found — already gone.`)
  } else {
    // `pack_rips` first: the FK is `ON DELETE RESTRICT`, so any
    // historical rip against this pack blocks the delete. Clearing
    // these drops audit rows but preserves the ledger — shard events
    // reference rips via `ON DELETE SET NULL`, so the earned-shard
    // rows stay with a null rip pointer.
    const deletedRips = await db
      .delete(packRips)
      .where(eq(packRips.packId, pack.id))
      .returning({ id: packRips.id })

    // `pack_books` next: FK is `ON DELETE CASCADE` so this is
    // redundant in principle, but doing it explicitly means we can
    // log how many membership rows were detached.
    const deletedMembership = await db
      .delete(packBooks)
      .where(eq(packBooks.packId, pack.id))
      .returning({ bookId: packBooks.bookId })

    await db.delete(packs).where(eq(packs.id, pack.id))

    console.log(
      `[delete-booker-pack] ✓ removed pack "${pack.name}" (${pack.id}); cleared ${deletedRips.length} rip audit row(s) and ${deletedMembership.length} membership row(s).`,
    )
  }
} catch (err) {
  console.error('[delete-booker-pack] ✗ failed:', err)
  process.exitCode = 1
} finally {
  await client.end()
}
