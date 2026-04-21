/**
 * Seed `public.books` + the default editorial pack from MOCK_POOL.
 *
 * Each mock book gets a deterministic NEGATIVE synthetic `hardcover_id`
 * derived from its mock string id. Real Hardcover IDs are positive, so
 * the two namespaces never collide.
 *
 * Re-runnable: uses ON CONFLICT clauses so you can tweak mock data and
 * re-seed without duplicate rows.
 */
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env.local' })
loadEnv()

import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { MOCK_POOL } from '../src/lib/cards/mock'
import { books, packBooks, packs } from '../src/db/schema'

const url = process.env.DATABASE_URL

if (!url) {
  console.error('[seed] Missing DATABASE_URL. Set it in .env.local.')
  process.exit(1)
}

const EDITORIAL_PACK = {
  slug: 'booker-shortlist-2024',
  name: 'Booker Shortlist 2024',
  description: 'A curated mix of literary, speculative, and memoir titles for the visual prototype.',
  coverImageUrl: null as string | null,
}

/**
 * djb2 string hash → stable 32-bit signed int. Prefixed with a minus so the
 * synthetic id can never collide with a real (positive) Hardcover id.
 */
function syntheticHardcoverId(mockId: string): number {
  let h = 5381
  for (let i = 0; i < mockId.length; i++) {
    h = (h * 33) ^ mockId.charCodeAt(i)
  }
  return -(Math.abs(h | 0) || 1)
}

const client = postgres(url, { max: 1 })
const db = drizzle(client, { schema: { books, packs, packBooks } })

try {
  console.log(`[seed] upserting ${MOCK_POOL.length} mock books…`)

  const bookIdByMockId = new Map<string, string>()

  for (const card of MOCK_POOL) {
    const hardcoverId = syntheticHardcoverId(card.id)
    const [row] = await db
      .insert(books)
      .values({
        hardcoverId,
        title: card.title,
        authors: [...card.authors],
        coverUrl: card.coverUrl,
        description: card.description,
        pageCount: card.pageCount,
        publishedYear: card.publishedYear,
        genre: card.genre,
        rarity: card.rarity,
        moodTags: [...card.moodTags],
        ratingsCount: 0,
        rawMetadata: { source: 'mock', mockId: card.id },
      })
      .onConflictDoUpdate({
        target: books.hardcoverId,
        set: {
          title: card.title,
          authors: [...card.authors],
          coverUrl: card.coverUrl,
          description: card.description,
          pageCount: card.pageCount,
          publishedYear: card.publishedYear,
          genre: card.genre,
          rarity: card.rarity,
          moodTags: [...card.moodTags],
          rawMetadata: { source: 'mock', mockId: card.id },
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: books.id })

    bookIdByMockId.set(card.id, row.id)
  }

  console.log(`[seed] upserting editorial pack "${EDITORIAL_PACK.slug}"…`)

  const [pack] = await db
    .insert(packs)
    .values({
      slug: EDITORIAL_PACK.slug,
      name: EDITORIAL_PACK.name,
      description: EDITORIAL_PACK.description,
      kind: 'editorial',
      coverImageUrl: EDITORIAL_PACK.coverImageUrl,
    })
    .onConflictDoUpdate({
      target: packs.slug,
      set: {
        name: EDITORIAL_PACK.name,
        description: EDITORIAL_PACK.description,
        coverImageUrl: EDITORIAL_PACK.coverImageUrl,
      },
    })
    .returning({ id: packs.id })

  // Reset membership so re-seeds stay in sync with MOCK_POOL (drops books
  // that were removed from the pool, adds any new ones).
  await db.delete(packBooks).where(eq(packBooks.packId, pack.id))
  await db.insert(packBooks).values(
    Array.from(bookIdByMockId.values()).map((bookId) => ({
      packId: pack.id,
      bookId,
    })),
  )

  const [{ bookCount }] = await db
    .select({ bookCount: sql<number>`count(*)::int` })
    .from(books)

  console.log(
    `[seed] ✓ ${bookCount} book(s) total · pack "${EDITORIAL_PACK.slug}" has ${bookIdByMockId.size} book(s)`,
  )
} catch (err) {
  console.error('[seed] ✗ failed:', err)
  process.exitCode = 1
} finally {
  await client.end()
}
