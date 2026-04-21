import type { BookRanking } from "@/lib/cards/rarity";

let nextId = 1;
function id() {
  return `book-${String(nextId++).padStart(4, "0")}`;
}

export function createBookRanking(overrides: Partial<BookRanking> = {}): BookRanking {
  // Default: 1000 ratings at 4.0 — comfortably above the top-tier floor
  // (see MIN_RATINGS_FOR_TOP_TIER) so tests that care about ordering
  // aren't accidentally capped at `rare` by the floor rule.
  return { id: id(), ratingsCount: 1000, averageRating: 4.0, ...overrides };
}

export function resetFactoryIds() {
  nextId = 1;
}
