/**
 * Server functions for the editorial pack + user collection.
 *
 * These run on the server only (TanStack Start strips the `"use server"`
 * body from client bundles). They are the single write path into the
 * `collection_cards` table, so business rules (dupe → shards, first-pack
 * attribution) live here rather than scattered across the UI.
 *
 * Authentication: `getSessionUser()` reads the Supabase session from
 * request cookies. Every function that writes requires a user; reads
 * return `null` for anonymous callers so the UI can render a sign-in CTA.
 */

import { createServerFn } from '@tanstack/react-start'
import { and, eq, inArray, sql } from 'drizzle-orm'

import { getDb } from '@/db/client'
import {
  books,
  collectionCards,
  packBooks,
  packRips,
  packs,
  shardBalances,
  users,
} from '@/db/schema'
import { getSessionUser } from '@/lib/supabase/server'
import { SHARD_YIELDS } from '@/lib/cards/pull'
import type { BookRow } from '@/lib/cards/book-to-card'

/**
 * Wrap a handler so that any thrown error is logged with its full cause
 * chain before being rethrown. Drizzle's "Failed query: …" errors keep
 * the real postgres error on `.cause`, which TanStack Start's serializer
 * drops on the way to the client — logging here is the only way to see
 * the actual SQLSTATE / message in Worker tail.
 */
function withErrorLogging<Args extends unknown[], R>(
  label: string,
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    try {
      return await fn(...args)
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause
      // eslint-disable-next-line no-console
      console.error(
        `[${label}]`,
        err instanceof Error ? err.message : err,
        cause instanceof Error ? `\n  cause: ${cause.message}` : cause ? `\n  cause: ${JSON.stringify(cause)}` : '',
        err instanceof Error && err.stack ? `\n${err.stack}` : '',
      )
      throw err
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export interface PackPayload {
  packId: string
  slug: string
  name: string
  description: string | null
  books: ReadonlyArray<BookRow>
}

export interface AcquisitionEntry {
  bookId: string
  packName: string
  acquiredAt: number // epoch ms
}

export interface CollectionPayload {
  ownedBookIds: ReadonlyArray<string>
  acquisitions: ReadonlyArray<AcquisitionEntry>
  shardBalance: number
}

export interface RecordRipInput {
  packId: string
  pulledBookIds: ReadonlyArray<string>
}

export interface RecordRipResult {
  /** Book IDs the user didn't already own (first-time acquisitions). */
  newBookIds: ReadonlyArray<string>
  /** Book IDs already in the collection — converted to shards. */
  duplicateBookIds: ReadonlyArray<string>
  shardsAwarded: number
  newShardBalance: number
}

// Shard economy lives server-side so we can evolve it without a client
// redeploy. The canonical yield table is `SHARD_YIELDS` in `lib/cards/pull`
// (shared with the client so the post-rip animation can preview the award).
const SHARD_VALUE_BY_RARITY: Record<string, number> = SHARD_YIELDS

// Hard-coded for now — the editorial pack is the only pack that exists. When
// packs become data-driven (deck packs, themed drops) we'll thread the slug
// through from the route.
export const DEFAULT_PACK_SLUG = 'booker-shortlist-2024'

// ─────────────────────────────────────────────────────────────────────────────
// Read: editorial pack
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the books belonging to the default editorial pack. Public — no auth
 * required so the anonymous landing animation can still roll a visual pack.
 */
export const getEditorialPackFn = createServerFn({ method: 'GET' }).handler(
  withErrorLogging('getEditorialPackFn', async (): Promise<PackPayload> => {
    const database = await getDb()

    const [pack] = await database
      .select({
        id: packs.id,
        slug: packs.slug,
        name: packs.name,
        description: packs.description,
      })
      .from(packs)
      .where(eq(packs.slug, DEFAULT_PACK_SLUG))
      .limit(1)

    if (!pack) {
      throw new Error(
        `[server/collection] pack "${DEFAULT_PACK_SLUG}" not found. Run \`pnpm db:seed\`.`,
      )
    }

    const rows = await database
      .select({
        id: books.id,
        title: books.title,
        authors: books.authors,
        coverUrl: books.coverUrl,
        description: books.description,
        pageCount: books.pageCount,
        publishedYear: books.publishedYear,
        genre: books.genre,
        rarity: books.rarity,
        moodTags: books.moodTags,
      })
      .from(packBooks)
      .innerJoin(books, eq(packBooks.bookId, books.id))
      .where(eq(packBooks.packId, pack.id))

    return {
      packId: pack.id,
      slug: pack.slug,
      name: pack.name,
      description: pack.description,
      books: rows,
    }
  }),
)

// ─────────────────────────────────────────────────────────────────────────────
// Read: user collection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the signed-in user's collection. Returns `null` for anonymous
 * callers so the UI can render a sign-in prompt instead of an empty state.
 */
export const getCollectionFn = createServerFn({ method: 'GET' }).handler(
  withErrorLogging('getCollectionFn', async (): Promise<CollectionPayload | null> => {
    const user = await getSessionUser()
    if (!user) return null

    const database = await getDb()

    // Pull collection rows + the pack-name snapshot used for "Found in pack: …".
    // LEFT JOIN because `first_acquired_from_pack_id` is nullable (rows
    // inserted manually, future imports, etc).
    const rows = await database
      .select({
        bookId: collectionCards.bookId,
        firstAcquiredAt: collectionCards.firstAcquiredAt,
        packName: packs.name,
      })
      .from(collectionCards)
      .leftJoin(packs, eq(collectionCards.firstAcquiredFromPackId, packs.id))
      .where(eq(collectionCards.userId, user.id))

    const [balance] = await database
      .select({ shards: shardBalances.shards })
      .from(shardBalances)
      .where(eq(shardBalances.userId, user.id))
      .limit(1)

    return {
      ownedBookIds: rows.map((r) => r.bookId),
      acquisitions: rows.map((r) => ({
        bookId: r.bookId,
        packName: r.packName ?? 'Editorial pack',
        acquiredAt: r.firstAcquiredAt.getTime(),
      })),
      shardBalance: balance?.shards ?? 0,
    }
  }),
)

// ─────────────────────────────────────────────────────────────────────────────
// Write: record a pack rip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a rip's outcome.
 *
 * Responsibilities:
 *   • INSERT new `collection_cards` rows for first-time pulls.
 *   • Increment `quantity` for duplicates (ON CONFLICT).
 *   • Award shards for duplicates based on rarity.
 *   • Write a `pack_rips` audit row so we can replay / analyse later.
 *
 * Everything happens inside a single transaction so a mid-rip crash can't
 * leave the economy in an inconsistent state.
 */
export const recordRipFn = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown): RecordRipInput => {
    // Hand-rolled validation to avoid a zod dependency for one call site.
    if (typeof data !== 'object' || data === null) {
      throw new Error('recordRip: body must be an object')
    }
    const { packId, pulledBookIds } = data as Record<string, unknown>
    if (typeof packId !== 'string') {
      throw new Error('recordRip: packId must be a string')
    }
    if (!Array.isArray(pulledBookIds) || pulledBookIds.some((id) => typeof id !== 'string')) {
      throw new Error('recordRip: pulledBookIds must be an array of strings')
    }
    if (pulledBookIds.length === 0) {
      throw new Error('recordRip: pulledBookIds must be non-empty')
    }
    return { packId, pulledBookIds: pulledBookIds as string[] }
  })
  .handler(withErrorLogging('recordRipFn', async ({ data }): Promise<RecordRipResult> => {
    const user = await getSessionUser()
    if (!user) {
      throw new Error('recordRip: not authenticated')
    }

    const database = await getDb()
    const { packId, pulledBookIds } = data

    return await database.transaction(async (tx) => {
      // 0. Defensive: ensure a `public.users` row exists for this auth user.
      //    The Postgres trigger normally takes care of this on signup, but
      //    seeding it here means we never 23503 (FK violation) if the trigger
      //    was ever disabled or the user predates it.
      const metadata = (user.user_metadata ?? {}) as Record<string, unknown>
      const emailLocal = user.email?.split('@')[0] ?? null
      const fallbackUsername =
        (typeof metadata.username === 'string' && metadata.username) ||
        (typeof metadata.preferred_username === 'string' && metadata.preferred_username) ||
        emailLocal ||
        user.id.slice(0, 8)
      await tx
        .insert(users)
        .values({
          id: user.id,
          username: fallbackUsername,
          displayName:
            (typeof metadata.full_name === 'string' && metadata.full_name) ||
            (typeof metadata.name === 'string' && metadata.name) ||
            fallbackUsername,
          avatarUrl:
            typeof metadata.avatar_url === 'string' ? metadata.avatar_url : null,
        })
        .onConflictDoNothing({ target: users.id })

      // 1. Load the rarity for each pulled book so we can compute shards.
      //    Also serves as a validity check — referring to a book that doesn't
      //    exist errors here instead of failing the collection insert later.
      const bookRows = await tx
        .select({ id: books.id, rarity: books.rarity })
        .from(books)
        .where(inArray(books.id, pulledBookIds as string[]))

      const rarityById = new Map(bookRows.map((b) => [b.id, b.rarity]))
      for (const id of pulledBookIds) {
        if (!rarityById.has(id)) {
          throw new Error(`recordRip: unknown book id ${id}`)
        }
      }

      // 2. Find which of the pulled books the user already owns.
      const existing = await tx
        .select({ bookId: collectionCards.bookId })
        .from(collectionCards)
        .where(
          and(
            eq(collectionCards.userId, user.id),
            inArray(collectionCards.bookId, pulledBookIds as string[]),
          ),
        )
      const ownedSet = new Set(existing.map((e) => e.bookId))

      const newBookIds = pulledBookIds.filter((id) => !ownedSet.has(id))
      // Dedupe within the same rip — a single pack can roll the same book
      // twice; the second copy is a dupe even if the first is new.
      const dedupedNewIds: string[] = []
      const seenInRip = new Set<string>()
      for (const id of newBookIds) {
        if (seenInRip.has(id)) continue
        seenInRip.add(id)
        dedupedNewIds.push(id)
      }
      const duplicateBookIds = pulledBookIds.filter(
        (id, idx) => ownedSet.has(id) || newBookIds.indexOf(id) !== idx,
      )

      // 3. Shard payout: every duplicate pays out its rarity value.
      let shardsAwarded = 0
      for (const id of duplicateBookIds) {
        shardsAwarded += SHARD_VALUE_BY_RARITY[rarityById.get(id)!] ?? 0
      }

      // 4. Insert fresh collection rows. ON CONFLICT handles the
      //    theoretical race where a concurrent rip inserts the same row.
      if (dedupedNewIds.length > 0) {
        await tx
          .insert(collectionCards)
          .values(
            dedupedNewIds.map((bookId) => ({
              userId: user.id,
              bookId,
              quantity: 1,
              firstAcquiredFromPackId: packId,
            })),
          )
          .onConflictDoNothing({
            target: [collectionCards.userId, collectionCards.bookId],
          })
      }

      // 5. Bump quantities for duplicates. A single SQL update per unique
      //    dupe id; quantity is +N where N is how many times the id appeared.
      const dupeCounts = new Map<string, number>()
      for (const id of duplicateBookIds) {
        dupeCounts.set(id, (dupeCounts.get(id) ?? 0) + 1)
      }
      for (const [bookId, count] of dupeCounts) {
        await tx
          .update(collectionCards)
          .set({
            quantity: sql`${collectionCards.quantity} + ${count}`,
            updatedAt: sql`now()`,
          })
          .where(
            and(eq(collectionCards.userId, user.id), eq(collectionCards.bookId, bookId)),
          )
      }

      // 6. Shard balance — upsert row, add shards.
      const [newBalance] = await tx
        .insert(shardBalances)
        .values({ userId: user.id, shards: shardsAwarded })
        .onConflictDoUpdate({
          target: shardBalances.userId,
          set: {
            shards: sql`${shardBalances.shards} + ${shardsAwarded}`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ shards: shardBalances.shards })

      // 7. Audit log. `duplicates` stores the COUNT of dupes, not the ids,
      //    matching the schema's integer column.
      await tx.insert(packRips).values({
        userId: user.id,
        packId,
        pulledBookIds: pulledBookIds as string[],
        duplicates: duplicateBookIds.length,
        shardsAwarded,
      })

      return {
        newBookIds: dedupedNewIds,
        duplicateBookIds,
        shardsAwarded,
        newShardBalance: newBalance.shards,
      }
    })
  }))
