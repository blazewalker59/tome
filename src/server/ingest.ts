/**
 * Admin-only server functions for ingesting books from Hardcover into
 * our catalog.
 *
 * Gate: `requireAdmin()` (session user's email ∈ ADMIN_EMAILS). Failing
 * that the server function throws before ever contacting Hardcover, so
 * unauthorized callers don't consume rate-limit budget.
 *
 * Flow:
 *   1. Validate input (handled by the pure mapper's invariants).
 *   2. Call `fetchBookById()` — rate-limited HTTP to Hardcover.
 *   3. Map the response to a `books` row via `bookResponseToRow`.
 *   4. Upsert on `hardcover_id` — never create duplicates if an admin
 *      ingests the same book twice. Editorial fields (genre, mood tags)
 *      from the new input always win so re-ingesting is the mechanism
 *      for editing curation metadata.
 *   5. Optionally link into a pack (`pack_books`) when a pack slug is
 *      supplied. Missing pack → throw; admins see the error and either
 *      pick a different slug or seed the pack first.
 *
 * The `rarity` column is written as `common` initially; the operator
 * runs `pnpm db:rebucket` after a batch of ingests to recompute rarities
 * globally from `ratings_count × average_rating`. See Phase E.
 */

import { createServerFn } from "@tanstack/react-start";
import { eq, inArray, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { books, packBooks, packs } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/session";
import { bookResponseToRow } from "@/lib/cards/hardcover";
import { fetchBookById, searchBooks, type HardcoverSearchResult } from "./hardcover";

/**
 * Cheap read-only probe used by the admin route loader to decide whether
 * to render the form or redirect. Kept separate from `requireAdmin()` so
 * the loader can branch (redirect vs 403 UI) without catching thrown
 * errors as control flow.
 *
 * Re-exported from `./admin` so existing imports keep working; the real
 * implementation lives there to avoid pulling this ingest module (with
 * its DB + Hardcover-client imports) into the client bundle graph.
 */
export { checkAdminFn } from "./admin";

export interface SearchHardcoverInput {
  query: string;
  page?: number;
  perPage?: number;
}

/**
 * Admin-only search across Hardcover's Typesense book index. Used by
 * the ingest UI's search pane so operators can find + queue books
 * without pre-knowing their ids. Gated by `requireAdmin()` because
 * every call consumes a slot of our 60 req/min rate budget; we don't
 * want anonymous traffic burning it.
 *
 * Already-ingested books (by `hardcover_id`) are tagged in the result
 * so the UI can render an "Already in catalog" badge and disable the
 * "Add to queue" button. One DB round trip per search, capped to the
 * returned hit set so it's O(per_page).
 */
export const searchHardcoverFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): SearchHardcoverInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("searchHardcoverFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    return {
      query: String(r.query ?? ""),
      page: r.page === undefined ? undefined : Number(r.page),
      perPage: r.perPage === undefined ? undefined : Number(r.perPage),
    };
  })
  .handler(
    async ({
      data,
    }): Promise<
      HardcoverSearchResult & {
        /** Map of hardcover_id → book id already in our catalog. */
        existingByHardcoverId: Record<number, string>;
      }
    > => {
      await requireAdmin();
      const result = await searchBooks(data.query, {
        page: data.page,
        perPage: data.perPage,
      });

      if (result.hits.length === 0) {
        return { ...result, existingByHardcoverId: {} };
      }

      // Single IN-list lookup: which of these hardcover_ids already exist?
      const database = await getDb();
      const ids = result.hits.map((h) => h.id);
      const existingRows = await database
        .select({ id: books.id, hardcoverId: books.hardcoverId })
        .from(books)
        .where(inArray(books.hardcoverId, ids));
      const existingByHardcoverId: Record<number, string> = {};
      for (const r of existingRows) {
        existingByHardcoverId[r.hardcoverId] = r.id;
      }

      return { ...result, existingByHardcoverId };
    },
  );

export interface IngestBookInput {
  hardcoverId: number;
  genre: string;
  /** Up to 3 kebab-case tags. Validated in the mapper. */
  moodTags: ReadonlyArray<string>;
  /** When set, the book is linked to `packs.slug = packSlug`. */
  packSlug?: string;
}

export interface IngestBookResult {
  bookId: string;
  title: string;
  authors: ReadonlyArray<string>;
  hardcoverId: number;
  /** `true` if the book was newly inserted; `false` if we updated an existing row. */
  created: boolean;
  /** Resolved when `packSlug` was set and the link was recorded. */
  linkedToPackId: string | null;
}

/**
 * Validate + normalize the admin form input before we spend a Hardcover
 * request on it. Cheap checks first: things that can fail without I/O.
 */
function normalizeInput(input: IngestBookInput): IngestBookInput {
  if (!Number.isInteger(input.hardcoverId) || input.hardcoverId <= 0) {
    throw new Error(`Invalid Hardcover id: ${input.hardcoverId}`);
  }
  const genre = input.genre.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(genre)) {
    throw new Error(
      `Genre must be kebab-case (lowercase letters, digits, hyphens): got "${input.genre}"`,
    );
  }
  const moodTags = input.moodTags
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (moodTags.some((t) => !/^[a-z0-9][a-z0-9-]*$/.test(t))) {
    throw new Error(`Mood tags must be kebab-case; got ${JSON.stringify(input.moodTags)}`);
  }
  const packSlug = input.packSlug?.trim() || undefined;
  return { hardcoverId: input.hardcoverId, genre, moodTags, packSlug };
}

export const ingestBookFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): IngestBookInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("ingestBookFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    return {
      hardcoverId: Number(r.hardcoverId),
      genre: String(r.genre ?? ""),
      moodTags: Array.isArray(r.moodTags) ? (r.moodTags as string[]) : [],
      packSlug: typeof r.packSlug === "string" ? r.packSlug : undefined,
    };
  })
  .handler(async ({ data }): Promise<IngestBookResult> => {
    await requireAdmin();
    const input = normalizeInput(data);

    const hardcoverBook = await fetchBookById(input.hardcoverId);
    if (!hardcoverBook) {
      throw new Error(
        `Hardcover book ${input.hardcoverId} not found. Check the id at ` +
          `https://hardcover.app/books.`,
      );
    }

    const row = bookResponseToRow(hardcoverBook, {
      genre: input.genre,
      moodTags: input.moodTags,
    });

    const database = await getDb();

    // Upsert on the unique hardcover_id. `created` tells the UI whether
    // this was a new row or a re-curation. We use `xmax = 0` (a well-
    // known postgres trick) to detect inserts vs updates in a single
    // round trip: on fresh inserts xmax is the null xid 0, on updates
    // it's the originating txid.
    const [upserted] = await database
      .insert(books)
      .values(row)
      .onConflictDoUpdate({
        target: books.hardcoverId,
        set: {
          title: row.title,
          authors: row.authors,
          coverUrl: row.coverUrl,
          description: row.description,
          pageCount: row.pageCount,
          publishedYear: row.publishedYear,
          genre: row.genre,
          moodTags: row.moodTags,
          ratingsCount: row.ratingsCount,
          averageRating: row.averageRating,
          rawMetadata: row.rawMetadata,
          updatedAt: sql`now()`,
          // NOTE: deliberately do NOT overwrite `rarity` here. The
          // rebucket script is the single authority for rarity.
        },
      })
      .returning({
        id: books.id,
        title: books.title,
        authors: books.authors,
        hardcoverId: books.hardcoverId,
        created: sql<boolean>`(xmax = 0)`,
      });

    if (!upserted) {
      // Defensive — returning() should always yield a row on insert or
      // update. Being explicit helps surface driver weirdness.
      throw new Error(`Upsert of hardcoverId=${input.hardcoverId} returned no row`);
    }

    let linkedToPackId: string | null = null;
    if (input.packSlug) {
      const [pack] = await database
        .select({ id: packs.id })
        .from(packs)
        .where(eq(packs.slug, input.packSlug))
        .limit(1);
      if (!pack) {
        throw new Error(
          `Pack "${input.packSlug}" not found. Create it via seed or admin UI first.`,
        );
      }
      // Composite PK makes this naturally idempotent — re-linking the
      // same book to the same pack is a no-op.
      await database
        .insert(packBooks)
        .values({ packId: pack.id, bookId: upserted.id })
        .onConflictDoNothing();
      linkedToPackId = pack.id;
    }

    return {
      bookId: upserted.id,
      title: upserted.title,
      authors: upserted.authors,
      hardcoverId: upserted.hardcoverId,
      created: Boolean(upserted.created),
      linkedToPackId,
    };
  });
