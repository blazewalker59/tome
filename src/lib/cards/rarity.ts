/**
 * Pure rarity-bucketing helper. Takes a list of
 * `{ id, ratingsCount, averageRating }` for ALL books in the catalog and
 * returns the rarity to assign each one.
 *
 * **Direction (v1): beloved-heavy, not obscurity-heavy.** A legendary card
 * is a book people *really love* — you want to pull Tolkien or Le Guin,
 * not something nobody's read. This inverts the popularity-descending
 * scheme from the MVP sketch.
 *
 * ## Scoring
 *
 * We combine rating with volume via a simple product:
 *
 *   score = averageRating × ratingsCount
 *
 * This prevents two small-sample failure modes:
 *   - a book with 3 ratings averaging 5.0 (would win on pure rating)
 *   - a mediocre bestseller with 1M ratings averaging 3.0 (would win on
 *     pure volume)
 *
 * Both get beaten by a widely-loved book with a solid 4.4 × 50k.
 *
 * ## Eligibility floor
 *
 * Books with fewer than `MIN_RATINGS_FOR_TOP_TIER` (default 100) ratings
 * cannot be assigned `legendary` or `foil` regardless of score — their
 * sample size is too small to trust. They're capped at `rare` (still a
 * nice pull, but not a "this is The One" moment). Books with no rating
 * at all (`averageRating === null`) score 0 and fall to `common`.
 *
 * ## Buckets (tighter top tiers than the SPEC default)
 *
 * Top of the score distribution → legendary; bottom → common.
 *
 *   legendary  top 1%
 *   foil       next 5%
 *   rare       next 15%
 *   uncommon   next 30%
 *   common     bottom 49%
 *
 * A "legendary" pull should feel genuinely special, so we went tighter
 * than SPEC §2's 5/15/30/30/20. Tune with real catalog data later.
 *
 * Ties are broken by id (lexicographic ascending) for deterministic output.
 */

export type Rarity = "common" | "uncommon" | "rare" | "foil" | "legendary";

/**
 * Cumulative percentile cutoffs from the TOP of the score distribution.
 * A book at rank-percentile p (where p is its fraction from the top,
 * 0 = best, 1 = worst) gets the first bucket whose cutoff >= p.
 */
const BUCKET_THRESHOLDS: ReadonlyArray<{ rarity: Rarity; cutoff: number }> = [
  { rarity: "legendary", cutoff: 0.01 },
  { rarity: "foil", cutoff: 0.06 },
  { rarity: "rare", cutoff: 0.21 },
  { rarity: "uncommon", cutoff: 0.51 },
  { rarity: "common", cutoff: 1 },
];

/**
 * Minimum `ratingsCount` a book needs to be eligible for `foil` or
 * `legendary`. Below this it's capped at `rare`. Exported for tests and
 * for any future admin override UI.
 */
export const MIN_RATINGS_FOR_TOP_TIER = 100;

export interface BookRanking {
  id: string;
  ratingsCount: number;
  /**
   * Hardcover average rating 0–5, or null if the book has no ratings yet.
   * Accepts a string (the shape we store in the DB) OR number so callers
   * don't have to parse first.
   */
  averageRating: string | number | null;
}

/** Score a single book. Exported for tests + debugging. */
export function scoreBook(book: BookRanking): number {
  const avg =
    typeof book.averageRating === "string"
      ? Number.parseFloat(book.averageRating)
      : (book.averageRating ?? 0);
  if (!Number.isFinite(avg) || avg <= 0) return 0;
  return avg * book.ratingsCount;
}

/**
 * Assign a rarity to every book in the input list. Returns a `Map` keyed
 * by book id for easy `UPDATE books SET rarity = ? WHERE id = ?` loops.
 * Pure function; no I/O.
 */
export function assignRarities(books: ReadonlyArray<BookRanking>): Map<string, Rarity> {
  const result = new Map<string, Rarity>();
  if (books.length === 0) return result;

  // Best score first; ties broken by id ascending for determinism.
  const ranked = [...books].sort((a, b) => {
    const sa = scoreBook(a);
    const sb = scoreBook(b);
    if (sb !== sa) return sb - sa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const total = ranked.length;
  ranked.forEach((book, idx) => {
    // (idx + 1) / total is the fraction-from-top position: rank 1 → 1/N,
    // rank N → 1. Using (idx+1) rather than idx ensures the very top
    // book always clears the legendary cutoff even when total * 0.01 < 1.
    const percentile = (idx + 1) / total;
    const bucket =
      BUCKET_THRESHOLDS.find((b) => percentile <= b.cutoff) ??
      BUCKET_THRESHOLDS[BUCKET_THRESHOLDS.length - 1];

    let rarity: Rarity = bucket.rarity;
    // Eligibility floor: small-sample books can't be foil/legendary.
    if (
      (rarity === "legendary" || rarity === "foil") &&
      book.ratingsCount < MIN_RATINGS_FOR_TOP_TIER
    ) {
      rarity = "rare";
    }
    result.set(book.id, rarity);
  });

  return result;
}
