/**
 * Pure rarity-bucketing helper. Takes a list of `{ id, ratingsCount }`
 * for ALL books in the catalog and returns the rarity to assign each one.
 *
 * Buckets, by rank from most-rated → least-rated:
 *   common    top 20%
 *   uncommon  next 30%
 *   rare      next 30%
 *   foil      next 15%
 *   legendary bottom 5%
 *
 * Ties broken by id (lexicographic) for deterministic output.
 */

export type Rarity = "common" | "uncommon" | "rare" | "foil" | "legendary";

const BUCKET_THRESHOLDS: Array<{ rarity: Rarity; cutoff: number }> = [
  { rarity: "common", cutoff: 0.2 },
  { rarity: "uncommon", cutoff: 0.5 },
  { rarity: "rare", cutoff: 0.8 },
  { rarity: "foil", cutoff: 0.95 },
  { rarity: "legendary", cutoff: 1 },
];

export interface BookRanking {
  id: string;
  ratingsCount: number;
}

export function assignRarities(books: ReadonlyArray<BookRanking>): Map<string, Rarity> {
  const result = new Map<string, Rarity>();
  if (books.length === 0) return result;

  // Most-rated first; ties broken by id ascending for determinism.
  const ranked = [...books].sort((a, b) => {
    if (b.ratingsCount !== a.ratingsCount) {
      return b.ratingsCount - a.ratingsCount;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const total = ranked.length;
  ranked.forEach((book, idx) => {
    const percentile = (idx + 1) / total; // 0 < p <= 1
    const bucket =
      BUCKET_THRESHOLDS.find((b) => percentile <= b.cutoff) ??
      BUCKET_THRESHOLDS[BUCKET_THRESHOLDS.length - 1];
    result.set(book.id, bucket.rarity);
  });

  return result;
}
