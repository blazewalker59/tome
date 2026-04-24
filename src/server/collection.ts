/**
 * Server functions for the editorial pack + user collection.
 *
 * These run on the server only (TanStack Start strips the `"use server"`
 * body from client bundles). They are the single write path into the
 * `collection_cards` table, so business rules (dupe → shards, first-pack
 * attribution) live here rather than scattered across the UI.
 *
 * Authentication: `getSessionUser()` reads the Better Auth session from
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
} from '@/db/schema'
import { getSessionUser } from '@/lib/auth/session'
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
  /** ID of the pack this book was first acquired from, or null if
   *  attribution is missing (legacy rows, manual imports). Stable key
   *  suitable for grouping in the UI. */
  packId: string | null
  /** URL-safe pack identifier; same nullability as `packId`. */
  packSlug: string | null
  /** Human label — e.g. "Booker Shortlist 2024" — falls back to
   *  "Editorial pack" when attribution is missing so the UI never has
   *  to render an empty string. */
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
        packId: packs.id,
        packSlug: packs.slug,
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
        packId: r.packId ?? null,
        packSlug: r.packSlug ?? null,
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
      // 1. Load the rarity for each pulled book so we can compute shards.
      //    Also serves as a validity check — referring to a book that doesn't
      //    exist errors here instead of failing the collection insert later.
      //
      //    Note: we used to defensively upsert a `users` row here to cover
      //    the case where the Supabase-era `handle_new_user` trigger hadn't
      //    fired. That's no longer needed: Better Auth's
      //    `databaseHooks.user.create.before` (see `src/lib/auth/server.ts`)
      //    runs synchronously inside the OAuth callback and guarantees the
      //    `users` row exists before any server fn can be called.
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

// ─────────────────────────────────────────────────────────────────────────────
// Read: single book detail
// ─────────────────────────────────────────────────────────────────────────────

export type ReadStatus = 'unread' | 'reading' | 'read'

export interface BookDetailPayload {
  /** Full public book metadata — same shape as `BookRow` with the id. */
  book: BookRow
  /** Packs this book appears in, for "Found in" breadcrumbs. Unordered;
   *  the UI can sort by name if we ever ship many packs per book. */
  packs: ReadonlyArray<{ id: string; slug: string; name: string }>
  /** The signed-in user's collection entry for this book, or null when
   *  anonymous or not-yet-owned. Lets the page show a read CTA for
   *  owners and a "rip to unlock" state for everyone else. */
  ownership: {
    owned: boolean
    quantity: number
    status: ReadStatus
    rating: number | null
    note: string | null
    firstAcquiredAt: number | null
    firstAcquiredFromPackId: string | null
  } | null
}

/**
 * Fetch one book's full detail. Public — anonymous callers get the
 * book + pack list but `ownership` is always null. This mirrors how
 * `getEditorialPackFn` is public: the catalog itself is never secret,
 * only the per-user overlay is.
 */
export const getBookFn = createServerFn({ method: 'GET' })
  .inputValidator((raw: unknown): { bookId: string } => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('getBookFn: input must be an object')
    }
    const { bookId } = raw as Record<string, unknown>
    if (typeof bookId !== 'string' || bookId.length === 0) {
      throw new Error('getBookFn: bookId is required')
    }
    return { bookId }
  })
  .handler(
    withErrorLogging('getBookFn', async ({ data }): Promise<BookDetailPayload | null> => {
      const database = await getDb()

      const [row] = await database
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
        .from(books)
        .where(eq(books.id, data.bookId))
        .limit(1)

      if (!row) return null

      // Pack memberships — used for "Found in: Booker 2024". Safe to
      // expose publicly since packs themselves are public.
      const packRows = await database
        .select({ id: packs.id, slug: packs.slug, name: packs.name })
        .from(packBooks)
        .innerJoin(packs, eq(packBooks.packId, packs.id))
        .where(eq(packBooks.bookId, data.bookId))

      // Owner overlay — only present when signed in AND the row exists.
      const user = await getSessionUser()
      let ownership: BookDetailPayload['ownership'] = null
      if (user) {
        const [entry] = await database
          .select({
            quantity: collectionCards.quantity,
            status: collectionCards.status,
            rating: collectionCards.rating,
            note: collectionCards.note,
            firstAcquiredAt: collectionCards.firstAcquiredAt,
            firstAcquiredFromPackId: collectionCards.firstAcquiredFromPackId,
          })
          .from(collectionCards)
          .where(
            and(
              eq(collectionCards.userId, user.id),
              eq(collectionCards.bookId, data.bookId),
            ),
          )
          .limit(1)

        ownership = entry
          ? {
              owned: true,
              quantity: entry.quantity,
              status: entry.status as ReadStatus,
              rating: entry.rating ?? null,
              note: entry.note ?? null,
              firstAcquiredAt: entry.firstAcquiredAt.getTime(),
              firstAcquiredFromPackId: entry.firstAcquiredFromPackId ?? null,
            }
          : {
              owned: false,
              quantity: 0,
              status: 'unread',
              rating: null,
              note: null,
              firstAcquiredAt: null,
              firstAcquiredFromPackId: null,
            }
      }

      return {
        book: row,
        packs: packRows,
        ownership,
      }
    }),
  )

// ─────────────────────────────────────────────────────────────────────────────
// Write: update the user's collection entry (status / rating / note)
// ─────────────────────────────────────────────────────────────────────────────

const READ_STATUSES: ReadonlyArray<ReadStatus> = ['unread', 'reading', 'read']

export interface UpdateCollectionCardInput {
  bookId: string
  /** Undefined fields are left untouched; explicit null clears the
   *  rating / note. Missing vs explicit-null matters because a blank
   *  note field in the UI should clear the stored value, not be
   *  indistinguishable from "don't change it". */
  status?: ReadStatus
  rating?: number | null
  note?: string | null
}

export interface UpdateCollectionCardResult {
  bookId: string
  status: ReadStatus
  rating: number | null
  note: string | null
}

/**
 * Patch the user's collection entry for a single book. Owner-only by
 * construction: the UPDATE's WHERE clause includes `userId`, so a user
 * can only touch their own rows even if they guessed another user's
 * bookId. Returns a 0-row update (= error) if the user doesn't own the
 * book yet — you can't rate a book you haven't pulled.
 */
export const updateCollectionCardFn = createServerFn({ method: 'POST' })
  .inputValidator((raw: unknown): UpdateCollectionCardInput => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('updateCollectionCardFn: input must be an object')
    }
    const r = raw as Record<string, unknown>
    const bookId = r.bookId
    if (typeof bookId !== 'string' || bookId.length === 0) {
      throw new Error('updateCollectionCardFn: bookId is required')
    }

    const out: UpdateCollectionCardInput = { bookId }

    if (r.status !== undefined) {
      if (
        typeof r.status !== 'string' ||
        !(READ_STATUSES as readonly string[]).includes(r.status)
      ) {
        throw new Error('updateCollectionCardFn: invalid status')
      }
      out.status = r.status as ReadStatus
    }

    if (r.rating !== undefined) {
      if (r.rating === null) {
        out.rating = null
      } else if (
        typeof r.rating === 'number' &&
        Number.isInteger(r.rating) &&
        r.rating >= 1 &&
        r.rating <= 5
      ) {
        out.rating = r.rating
      } else {
        throw new Error('updateCollectionCardFn: rating must be an integer 1..5 or null')
      }
    }

    if (r.note !== undefined) {
      if (r.note === null) {
        out.note = null
      } else if (typeof r.note === 'string') {
        // Cap to a reasonable length so a user can't store novels in
        // the DB. 2000 chars ≈ a long diary entry and fits a single
        // text column comfortably.
        out.note = r.note.slice(0, 2000)
      } else {
        throw new Error('updateCollectionCardFn: note must be a string or null')
      }
    }

    return out
  })
  .handler(
    withErrorLogging(
      'updateCollectionCardFn',
      async ({ data }): Promise<UpdateCollectionCardResult> => {
        const user = await getSessionUser()
        if (!user) {
          throw new Error('updateCollectionCardFn: not authenticated')
        }

        const database = await getDb()

        // Build the SET clause dynamically so unspecified fields truly
        // aren't touched. Drizzle requires at least one field; we also
        // always bump updatedAt so downstream observers can notice.
        const set: Record<string, unknown> = { updatedAt: sql`now()` }
        if (data.status !== undefined) set.status = data.status
        if (data.rating !== undefined) set.rating = data.rating
        if (data.note !== undefined) set.note = data.note

        // Only status / rating / note and updatedAt matter; if none of
        // the three were passed, there's nothing to do.
        if (
          data.status === undefined &&
          data.rating === undefined &&
          data.note === undefined
        ) {
          throw new Error('updateCollectionCardFn: no fields to update')
        }

        const [updated] = await database
          .update(collectionCards)
          .set(set)
          .where(
            and(
              eq(collectionCards.userId, user.id),
              eq(collectionCards.bookId, data.bookId),
            ),
          )
          .returning({
            bookId: collectionCards.bookId,
            status: collectionCards.status,
            rating: collectionCards.rating,
            note: collectionCards.note,
          })

        if (!updated) {
          // The user doesn't own this book. The client-side form only
          // renders for owners, so this is a defensive check, not a
          // normal flow.
          throw new Error('updateCollectionCardFn: book not in your collection')
        }

        return {
          bookId: updated.bookId,
          status: updated.status as ReadStatus,
          rating: updated.rating ?? null,
          note: updated.note ?? null,
        }
      },
    ),
  )

