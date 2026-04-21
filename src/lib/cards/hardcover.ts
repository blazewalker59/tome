/**
 * Pure mapper: Hardcover GraphQL book response → row for `books` table insert.
 *
 * Kept separate from the network client (`src/server/hardcover.ts`) so we
 * can unit-test the transform without touching the API. The shape here is
 * the one we request in our single `bookByIdQuery` — NOT the full
 * Hardcover books schema. If you add fields to the query, extend this
 * type and the mapper.
 *
 * Hardcover's `rating` field is numeric 0–5; our DB column is `text` to
 * preserve precision (`src/db/schema.ts` → `books.averageRating`). We
 * stringify it on the way in and parse back only when computing rarity.
 */

import type { InferInsertModel } from "drizzle-orm";
import type { books } from "@/db/schema";

/**
 * Minimal shape of a book object as returned by our ingestion query
 * against `api.hardcover.app/v1/graphql`. Fields we don't use are
 * intentionally omitted — keeping the surface narrow makes it obvious
 * when the query needs to change.
 */
export interface HardcoverBook {
  id: number;
  title: string | null;
  subtitle?: string | null;
  description?: string | null;
  pages?: number | null;
  release_year?: number | null;
  rating?: number | string | null;
  ratings_count?: number | null;
  /**
   * `cached_image` is `jsonb` upstream — Hardcover stores the derived
   * best-fit cover URL here so we don't need to join `images`. Shape is
   * not strictly documented; in practice it has at least `{ url }`.
   */
  cached_image?: { url?: string | null } | null;
  /**
   * Fallback if `cached_image` is null — the `images` relation. We only
   * use the first one. Ignored when `cached_image.url` is present.
   */
  image?: { url?: string | null } | null;
  contributions?: Array<{
    contribution?: string | null;
    author?: { name?: string | null } | null;
  }> | null;
}

/**
 * Editorial curation inputs that live alongside the API-derived fields.
 * The admin ingest form supplies these; they're not derivable from
 * Hardcover alone (mood tags don't exist upstream, and genre requires
 * editorial judgment per SPEC §2).
 */
export interface IngestCuration {
  genre: string;
  moodTags: ReadonlyArray<string>;
}

/** Row shape for `drizzle.insert(books).values(...)`. */
type BookInsertRow = InferInsertModel<typeof books>;

/**
 * Pick primary authors from the contributions array. Hardcover marks the
 * primary author with `contribution === "Author"` or (historically)
 * `contribution === null`. We keep both to be defensive. Deduped and
 * ordered as the API returns them — editorial order.
 */
export function extractAuthors(
  contributions: HardcoverBook["contributions"],
): string[] {
  if (!contributions) return [];
  const seen = new Set<string>();
  const authors: string[] = [];
  for (const c of contributions) {
    const role = c.contribution ?? "Author";
    if (role !== "Author") continue;
    const name = c.author?.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    authors.push(name);
  }
  return authors;
}

/**
 * Pick a cover URL. Prefers `cached_image.url` (already resolved by
 * Hardcover), falls back to the `image` relation, otherwise null.
 */
export function extractCoverUrl(book: HardcoverBook): string | null {
  return book.cached_image?.url ?? book.image?.url ?? null;
}

/**
 * Normalize the average rating to a `string | null` matching our DB
 * column type. Hardcover returns either `number`, `string` (via
 * GraphQL's numeric serialization), or null.
 */
export function normalizeAverageRating(
  rating: HardcoverBook["rating"],
): string | null {
  if (rating === null || rating === undefined) return null;
  const n = typeof rating === "string" ? Number.parseFloat(rating) : rating;
  if (!Number.isFinite(n) || n <= 0) return null;
  // Clamp to [0, 5] defensively — upstream shouldn't violate this but
  // we'd rather store a sensible value than surface weirdness.
  const clamped = Math.min(5, Math.max(0, n));
  return clamped.toFixed(2);
}

/**
 * Transform a Hardcover response + curation inputs into a row ready for
 * `drizzle.insert(books).onConflictDoUpdate(...)`. The caller supplies
 * the `rarity` (temporary; the rebucket script will overwrite it) —
 * we default to `common` so a newly-ingested book shows up immediately
 * even if you forget to rebucket.
 */
export function bookResponseToRow(
  book: HardcoverBook,
  curation: IngestCuration,
  opts: { initialRarity?: BookInsertRow["rarity"] } = {},
): BookInsertRow {
  if (!book.title || book.title.trim().length === 0) {
    throw new Error(
      `[tome/hardcover] Book ${book.id} has no title; refusing to ingest.`,
    );
  }
  if (!Number.isInteger(book.id) || book.id <= 0) {
    throw new Error(`[tome/hardcover] Invalid Hardcover book id: ${book.id}`);
  }
  if (curation.moodTags.length > 3) {
    throw new Error(
      `[tome/hardcover] At most 3 mood tags allowed (SPEC §2); got ${curation.moodTags.length}.`,
    );
  }

  return {
    hardcoverId: book.id,
    title: book.title.trim(),
    authors: extractAuthors(book.contributions),
    coverUrl: extractCoverUrl(book),
    description: book.description ?? null,
    pageCount: book.pages ?? null,
    publishedYear: book.release_year ?? null,
    genre: curation.genre,
    rarity: opts.initialRarity ?? "common",
    moodTags: [...curation.moodTags],
    ratingsCount: book.ratings_count ?? 0,
    averageRating: normalizeAverageRating(book.rating ?? null),
    // Full original payload for debugging / future reprocessing without
    // re-hitting the API. Bounded in practice (a book record is < 4KB).
    rawMetadata: { source: "hardcover", fetchedAt: new Date().toISOString(), book },
  };
}
