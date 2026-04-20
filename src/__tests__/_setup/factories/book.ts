import type { BookRanking } from "@/lib/cards/rarity";

let nextId = 1;
function id() {
  return `book-${String(nextId++).padStart(4, "0")}`;
}

export function createBookRanking(overrides: Partial<BookRanking> = {}): BookRanking {
  return { id: id(), ratingsCount: 1000, ...overrides };
}

export function resetFactoryIds() {
  nextId = 1;
}
