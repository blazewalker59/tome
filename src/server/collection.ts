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
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

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
import { getSessionUser } from '@/lib/auth/session'
import { getEconomy } from '@/lib/economy/config'
import { grantShards, spendShards } from '@/lib/economy/ledger'
import type { BookRow } from '@/lib/cards/book-to-card'
import { withErrorLogging } from './_shared'

/**
 * Wrapper removed — moved to `./_shared` so both `collection.ts` and
 * `user-packs.ts` (and any future server module) share one definition.
 */

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

/**
 * Lightweight summary row for the pack-picker carousel on /rip.
 * Omits the book list — the carousel only needs identity + art + a
 * book count so it can render a cover thumbnail. The full book list is
 * fetched lazily when the user drills into /rip/$slug.
 */
export interface PackSummary {
  id: string
  slug: string
  name: string
  description: string | null
  coverImageUrl: string | null
  bookCount: number
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

export interface RecentPullEntry {
  bookId: string
  title: string
  /** Nullable because `books.cover_url` is nullable (not every imported
   *  book has art yet). UI renders a rarity-tinted placeholder when
   *  missing rather than a broken `<img>`. */
  coverUrl: string | null
  rarity: string
  acquiredAt: number
}

export interface CollectionPayload {
  ownedBookIds: ReadonlyArray<string>
  acquisitions: ReadonlyArray<AcquisitionEntry>
  shardBalance: number
  /** Newest-first snapshot of the last 5 unique books the user pulled.
   *  Enough metadata (title + cover + rarity) so the Home "recent rips"
   *  row can render without an extra query. Kept short — the Home card
   *  just needs a glance, and more rows would crowd the viewport. */
  recentPulls: ReadonlyArray<RecentPullEntry>
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
  /**
   * Total shards credited by this rip — sum of dupe refunds only.
   * Does NOT include the pack cost debit (which reduces balance).
   * UI can compute net change as `shardsAwarded - packCost` if it
   * wants to show "-25 net" on a bad rip.
   */
  shardsAwarded: number
  /** Shards deducted for the rip itself. */
  packCost: number
  /** User's balance after the entire rip (debit + refunds). */
  newShardBalance: number
}

/**
 * Thrown by `recordRipFn` when the user can't afford the pack cost.
 * The client checks `err.message.startsWith('INSUFFICIENT_SHARDS:')`
 * to render a "need N more shards" state instead of a generic error.
 * Kept as a string-prefix convention rather than a discriminated
 * union result so existing callers don't have to change their
 * throw/catch shape.
 */
export const INSUFFICIENT_SHARDS_PREFIX = 'INSUFFICIENT_SHARDS:'

// Shard payout is derived from the economy config (CORE_LOOP_PLAN §1).
// Flat per-dupe in v1; the config shape allows per-rarity overrides
// later without touching this file.

// Hard-coded for now — the editorial pack is the only pack that exists. When
// packs become data-driven (deck packs, themed drops) we'll thread the slug
// through from the route.
export const DEFAULT_PACK_SLUG = 'booker-shortlist-2024'

// ─────────────────────────────────────────────────────────────────────────────
// Read: editorial pack
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal: load a pack + its books by slug. Used by both the
 * default-pack fetcher (home/landing animation) and the slug-param
 * fetcher (/rip/$slug) — both of which only ever serve editorial
 * (Tome-authored) packs. User-built packs live under `/u/$username/$slug`
 * and use `loadUserPack` below so their slug is resolved within the
 * creator's namespace.
 */
async function loadPackBySlug(slug: string): Promise<PackPayload> {
  const database = await getDb()

  const [pack] = await database
    .select({
      id: packs.id,
      slug: packs.slug,
      name: packs.name,
      description: packs.description,
    })
    .from(packs)
    // Editorial namespace only: creator_id IS NULL.
    .where(and(eq(packs.slug, slug), isNull(packs.creatorId)))
    .limit(1)

  if (!pack) {
    throw new Error(`[server/collection] pack "${slug}" not found.`)
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
}

/**
 * Internal: load a published user pack by (username, slug). Mirrors
 * `loadPackBySlug` but resolves through the user namespace so both
 * rip flows (editorial vs creator-authored) return the same
 * `PackPayload` shape and can share the `/rip/…` component tree.
 * Drafts (`is_public = false`) are rejected — only published packs
 * are rippable.
 */
async function loadUserPack(username: string, slug: string): Promise<PackPayload> {
  const database = await getDb()

  const [pack] = await database
    .select({
      id: packs.id,
      slug: packs.slug,
      name: packs.name,
      description: packs.description,
    })
    .from(packs)
    .innerJoin(users, eq(packs.creatorId, users.id))
    .where(
      and(
        eq(users.username, username),
        eq(packs.slug, slug),
        eq(packs.isPublic, true),
      ),
    )
    .limit(1)

  if (!pack) {
    throw new Error(`[server/collection] user pack @${username}/${slug} not found.`)
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
    .orderBy(desc(packBooks.packId)) // stable order — actual position sort
    // handled in the rip roller via its own pool weighting

  return {
    packId: pack.id,
    slug: pack.slug,
    name: pack.name,
    description: pack.description,
    books: rows,
  }
}

/**
 * Return the books belonging to the default editorial pack. Public — no auth
 * required so the anonymous landing animation can still roll a visual pack.
 */
export const getEditorialPackFn = createServerFn({ method: 'GET' }).handler(
  withErrorLogging('getEditorialPackFn', async (): Promise<PackPayload> => {
    return loadPackBySlug(DEFAULT_PACK_SLUG)
  }),
)

/**
 * Fetch a specific pack by slug — used by `/rip/$slug` when the user
 * picks a pack from the carousel. Public so anonymous users can
 * preview; auth is enforced only when they actually commit a rip.
 */
export const getPackBySlugFn = createServerFn({ method: 'GET' })
  .inputValidator((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('getPackBySlugFn: expected { slug: string }')
    }
    const { slug } = raw as { slug?: unknown }
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new Error('getPackBySlugFn: slug must be a non-empty string')
    }
    return { slug }
  })
  .handler(
    withErrorLogging('getPackBySlugFn', async ({ data }): Promise<PackPayload> => {
      return loadPackBySlug(data.slug)
    }),
  )

/**
 * Shape returned by `getPackBooksByIdsFn`. A flat map keyed by pack
 * ID so the collection page can cheaply look up any pack group's
 * manifest without scanning. Packs not found (deleted, private) are
 * simply omitted — callers treat the lookup as advisory and fall
 * back to owned-only listings. The `books` array is the same
 * `BookRow` shape the /rip flow uses so the `PackContentsSheet`
 * component works uniformly across both surfaces.
 */
export interface PackManifestEntry {
  name: string
  books: ReadonlyArray<BookRow>
}

export type PackManifestMap = ReadonlyMap<string, PackManifestEntry>

/**
 * Batch-fetch the book manifests for a set of packs. Used by
 * `/collection` so the per-pack "in this pack" bottom sheet can
 * render the full contents (not just what the user owns) identically
 * to /rip. Taking a batch of IDs instead of one-at-a-time means the
 * page adds a single round-trip regardless of how many packs the user
 * has rolled from.
 *
 * Public — pack contents aren't secret; `is_public = false` draft
 * packs are intentionally excluded so unlisted drafts don't leak.
 * Editorial packs (creator_id IS NULL) are always visible.
 *
 * Returns a plain object (not a Map) because server-fn serialization
 * doesn't round-trip Map values cleanly; the client rehydrates into
 * a Map on arrival.
 */
export const getPackBooksByIdsFn = createServerFn({ method: 'GET' })
  .inputValidator((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('getPackBooksByIdsFn: expected { packIds: string[] }')
    }
    const { packIds } = raw as { packIds?: unknown }
    if (!Array.isArray(packIds) || !packIds.every((id) => typeof id === 'string')) {
      throw new Error('getPackBooksByIdsFn: packIds must be string[]')
    }
    // Dedup up-front so we don't send redundant IDs to the DB and
    // also so the map we return has a predictable size regardless of
    // caller hygiene.
    return { packIds: Array.from(new Set(packIds as string[])) }
  })
  .handler(
    withErrorLogging(
      'getPackBooksByIdsFn',
      async ({ data }): Promise<Record<string, PackManifestEntry>> => {
        const { packIds } = data
        // Short-circuit on empty input — otherwise `inArray(col, [])`
        // generates `col IN ()` on some drivers which is a syntax
        // error. Also saves a round-trip.
        if (packIds.length === 0) return {}

        const database = await getDb()

        // One query that pulls every (pack, book) pair. Filtering by
        // `isPublic = true OR creator_id IS NULL` permits editorial
        // packs (no creator) alongside published user packs while
        // excluding unpublished drafts.
        const rows = await database
          .select({
            packId: packBooks.packId,
            packName: packs.name,
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
          .innerJoin(packs, eq(packBooks.packId, packs.id))
          .where(
            and(
              inArray(packBooks.packId, packIds),
              // Editorial (null creator) or explicitly published.
              sql`${packs.creatorId} is null or ${packs.isPublic} = true`,
            ),
          )

        // Bucket by packId. We keep the pack's name alongside the
        // books so the sheet can render its header without a separate
        // lookup.
        const out: Record<string, PackManifestEntry> = {}
        for (const r of rows) {
          let entry = out[r.packId]
          if (!entry) {
            entry = { name: r.packName, books: [] }
            out[r.packId] = entry
          }
          ;(entry.books as BookRow[]).push({
            id: r.id,
            title: r.title,
            authors: r.authors,
            coverUrl: r.coverUrl,
            description: r.description,
            pageCount: r.pageCount,
            publishedYear: r.publishedYear,
            genre: r.genre,
            rarity: r.rarity,
            moodTags: r.moodTags,
          })
        }
        return out
      },
    ),
  )

/**
 * Fetch a published user pack by (username, slug). Used by the
 * `/rip/u/$username/$slug` route so creator-authored packs get the
 * same tear-open experience as editorial ones. Returns a `PackPayload`
 * identical in shape to `getPackBySlugFn`'s — callers downstream
 * (`rollRip`, `applyRip`) don't care whether a pack is editorial or
 * user-made.
 */
export const getUserPackFn = createServerFn({ method: 'GET' })
  .inputValidator((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('getUserPackFn: expected { username, slug }')
    }
    const { username, slug } = raw as { username?: unknown; slug?: unknown }
    if (typeof username !== 'string' || username.length === 0) {
      throw new Error('getUserPackFn: username must be a non-empty string')
    }
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new Error('getUserPackFn: slug must be a non-empty string')
    }
    return { username, slug }
  })
  .handler(
    withErrorLogging('getUserPackFn', async ({ data }): Promise<PackPayload> => {
      return loadUserPack(data.username, data.slug)
    }),
  )

/**
 * List every editorial pack in the catalog, newest first, with a book
 * count. Drives the /rip picker carousel. Kept separate from
 * `getPackBySlugFn` so the carousel doesn't pay the cost of pulling
 * every book in every pack just to show cover thumbnails. Public.
 */
export const getRipPacksFn = createServerFn({ method: 'GET' }).handler(
  withErrorLogging('getRipPacksFn', async (): Promise<ReadonlyArray<PackSummary>> => {
    const database = await getDb()
    const rows = await database
      .select({
        id: packs.id,
        slug: packs.slug,
        name: packs.name,
        description: packs.description,
        coverImageUrl: packs.coverImageUrl,
        // Per-pack book count via a correlated aggregate. Avoids a
        // separate N+1 pass and keeps the payload compact for the
        // carousel.
        bookCount: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${packBooks}
          WHERE ${packBooks.packId} = ${packs.id}
        )`,
      })
      .from(packs)
      // Editorial packs are defined by a NULL creator_id. They share the
      // global "Tome-authored" namespace; user-built packs have creator_id
      // set and surface on user profiles instead.
      .where(and(isNull(packs.creatorId), eq(packs.isPublic, true)))
      .orderBy(desc(packs.createdAt))

    return rows
  }),
)

// ─────────────────────────────────────────────────────────────────────────────
// Read: user collection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight shard-balance read. Lives separately from
 * `getCollectionFn` so chrome like the header dropdown can fetch just
 * the number without pulling every owned book. Returns `null` for
 * anonymous callers so the caller can decide whether to render a
 * placeholder or skip rendering entirely.
 */
export const getShardBalanceFn = createServerFn({ method: 'GET' }).handler(
  withErrorLogging('getShardBalanceFn', async (): Promise<{ shards: number } | null> => {
    const user = await getSessionUser()
    if (!user) return null

    const database = await getDb()
    const [row] = await database
      .select({ shards: shardBalances.shards })
      .from(shardBalances)
      .where(eq(shardBalances.userId, user.id))
      .limit(1)

    return { shards: row?.shards ?? 0 }
  }),
)

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

    // Recent pulls: 5 newest unique books by first-acquisition time.
    // Separate query (rather than shaping from `rows`) so we can INNER
    // JOIN `books` for the card preview metadata and cap server-side
    // via LIMIT — pulling every row to slice in JS wouldn't scale once
    // collections grow past a few hundred books.
    const recentRows = await database
      .select({
        bookId: collectionCards.bookId,
        firstAcquiredAt: collectionCards.firstAcquiredAt,
        title: books.title,
        coverUrl: books.coverUrl,
        rarity: books.rarity,
      })
      .from(collectionCards)
      .innerJoin(books, eq(collectionCards.bookId, books.id))
      .where(eq(collectionCards.userId, user.id))
      .orderBy(sql`${collectionCards.firstAcquiredAt} desc`)
      .limit(5)

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
      recentPulls: recentRows.map((r) => ({
        bookId: r.bookId,
        title: r.title,
        coverUrl: r.coverUrl,
        rarity: r.rarity,
        acquiredAt: r.firstAcquiredAt.getTime(),
      })),
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

    const cfg = await getEconomy()
    const packCost = cfg.packCost
    const perDupe = cfg.dupeRefund.shardsPerDupe

    return await database.transaction(async (tx) => {
      // 1. Charge the pack cost first. If the user can't afford it we
      //    bail before touching anything else — no collection insert,
      //    no audit row, no dupe refunds. `spendShards` row-locks the
      //    balance so two concurrent rips can't both drain the account
      //    below zero.
      //
      //    Note: we used to defensively upsert a `users` row here to cover
      //    the case where the Supabase-era `handle_new_user` trigger hadn't
      //    fired. That's no longer needed: Better Auth's
      //    `databaseHooks.user.create.before` (see `src/lib/auth/server.ts`)
      //    runs synchronously inside the OAuth callback and guarantees the
      //    `users` row exists before any server fn can be called.
      const debit = await spendShards(tx, user.id, packCost, { packId })
      if (!debit.applied) {
        throw new Error(
          `${INSUFFICIENT_SHARDS_PREFIX}have=${debit.newBalance} need=${packCost}`,
        )
      }

      // 2. Validate each pulled id exists. Failing here rolls back the
      //    debit cleanly via the surrounding transaction.
      const bookRows = await tx
        .select({ id: books.id })
        .from(books)
        .where(inArray(books.id, pulledBookIds as string[]))

      const knownIds = new Set(bookRows.map((b) => b.id))
      for (const id of pulledBookIds) {
        if (!knownIds.has(id)) {
          throw new Error(`recordRip: unknown book id ${id}`)
        }
      }

      // 3. Find which of the pulled books the user already owns.
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

      // 6. Insert the audit row first so the dupe refunds can reference
      //    it. `duplicates` stores the COUNT of dupes, not the ids.
      //    `shardsAwarded` is filled in after the refunds; initial 0
      //    is replaced below.
      const [rip] = await tx
        .insert(packRips)
        .values({
          userId: user.id,
          packId,
          pulledBookIds: pulledBookIds as string[],
          duplicates: duplicateBookIds.length,
          shardsAwarded: 0,
        })
        .returning({ id: packRips.id })

      // 7. Grant flat dupe refunds via the ledger — one `dupe_refund`
      //    row per dupe instance, each tied back to the rip id so we
      //    can reconstruct "this rip yielded 2 dupes worth 10 shards"
      //    later. `grantShards` updates the balance cache for us.
      let shardsAwarded = 0
      let newShardBalance = debit.newBalance
      for (const bookId of duplicateBookIds) {
        if (perDupe <= 0) break
        const r = await grantShards(tx, user.id, 'dupe_refund', perDupe, {
          bookId,
          packId,
          ripId: rip.id,
        })
        if (r.applied) {
          shardsAwarded += r.delta
          newShardBalance = r.newBalance
        }
      }

      // 8. Backfill the rip row's shardsAwarded now that we know the
      //    total. Keeping it denormalized on pack_rips makes "biggest
      //    rip ever" and similar queries cheap.
      if (shardsAwarded > 0) {
        await tx
          .update(packRips)
          .set({ shardsAwarded })
          .where(eq(packRips.id, rip.id))
      }

      // 9. Bump the pack's denormalized weekly-rip counter. Used as a
      //    trending signal on the discovery surface. The reset job that
      //    decays stale counters is not built yet (TODO) — for now this
      //    grows monotonically, which still gives a working "most-ripped"
      //    sort even if the 7-day semantics aren't enforced.
      await tx
        .update(packs)
        .set({ ripCountWeek: sql`${packs.ripCountWeek} + 1` })
        .where(eq(packs.id, packId))

      return {
        newBookIds: dedupedNewIds,
        duplicateBookIds,
        shardsAwarded,
        packCost,
        newShardBalance,
      }
    })
  }))

// ─────────────────────────────────────────────────────────────────────────────
// Read: single book detail
// ─────────────────────────────────────────────────────────────────────────────

export interface BookDetailPayload {
  /** Full public book metadata — same shape as `BookRow` with the id. */
  book: BookRow
  /** Packs this book appears in, for "Found in" breadcrumbs. Unordered;
   *  the UI can sort by name if we ever ship many packs per book. */
  packs: ReadonlyArray<{ id: string; slug: string; name: string }>
  /** The signed-in user's card-ownership state for this book, or null
   *  when anonymous. This is ownership only — reading-log state (status
   *  / rating / note) lives on `reading_entries` and is fetched via
   *  `getReadingEntryFn` in `src/server/reading.ts`. Keeping the two
   *  domains separate in the payload mirrors how they're separate in
   *  the schema. */
  ownership: {
    owned: boolean
    quantity: number
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
      // Reading-log overlay (status / rating / note) is NOT loaded here;
      // the book detail page fetches that separately via
      // `getReadingEntryFn` so non-owners can still log books they
      // haven't ripped.
      const user = await getSessionUser()
      let ownership: BookDetailPayload['ownership'] = null
      if (user) {
        const [entry] = await database
          .select({
            quantity: collectionCards.quantity,
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
              firstAcquiredAt: entry.firstAcquiredAt.getTime(),
              firstAcquiredFromPackId: entry.firstAcquiredFromPackId ?? null,
            }
          : {
              owned: false,
              quantity: 0,
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

