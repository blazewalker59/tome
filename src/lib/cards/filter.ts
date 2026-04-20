/**
 * Pure filtering, grouping, and sorting for the collection view.
 *
 * Kept separate from the React layer so the logic is trivially testable
 * and reusable from server functions later (e.g. paginated collection
 * queries).
 */

import type { CardData, Genre, Rarity } from "./types";

export type SortMode = "title" | "author" | "rarity" | "newest";

const RARITY_ORDER: Record<Rarity, number> = {
  legendary: 0,
  foil: 1,
  rare: 2,
  uncommon: 3,
  common: 4,
};

export interface CollectionFilter {
  /** If non-empty, only cards whose genre is in this set pass. */
  genres?: ReadonlySet<Genre>;
  /** If non-empty, only cards whose rarity is in this set pass. */
  rarities?: ReadonlySet<Rarity>;
  /** If non-empty, a card passes if it has AT LEAST ONE matching mood tag. */
  moods?: ReadonlySet<string>;
  /** Substring match on title or author (case-insensitive). */
  search?: string;
}

export function filterCards(cards: ReadonlyArray<CardData>, filter: CollectionFilter): CardData[] {
  const search = filter.search?.trim().toLowerCase() ?? "";
  return cards.filter((c) => {
    if (filter.genres && filter.genres.size > 0 && !filter.genres.has(c.genre)) {
      return false;
    }
    if (filter.rarities && filter.rarities.size > 0 && !filter.rarities.has(c.rarity)) {
      return false;
    }
    if (filter.moods && filter.moods.size > 0) {
      const hit = c.moodTags.some((t) => filter.moods?.has(t));
      if (!hit) return false;
    }
    if (search) {
      const hay = `${c.title} ${c.authors.join(" ")}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

export interface SortContext {
  /** Acquisition timestamps keyed by bookId; required only for `newest`. */
  acquiredAt?: ReadonlyMap<string, number>;
}

export function sortCards(
  cards: ReadonlyArray<CardData>,
  mode: SortMode,
  ctx: SortContext = {},
): CardData[] {
  const sorted = [...cards];
  switch (mode) {
    case "title":
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "author":
      sorted.sort((a, b) => {
        const aa = a.authors[0] ?? "";
        const bb = b.authors[0] ?? "";
        return aa.localeCompare(bb) || a.title.localeCompare(b.title);
      });
      break;
    case "rarity":
      sorted.sort(
        (a, b) => RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity] || a.title.localeCompare(b.title),
      );
      break;
    case "newest": {
      const at = ctx.acquiredAt;
      sorted.sort((a, b) => {
        const ta = at?.get(a.id) ?? 0;
        const tb = at?.get(b.id) ?? 0;
        return tb - ta || a.title.localeCompare(b.title);
      });
      break;
    }
  }
  return sorted;
}

/**
 * Group cards by genre, preserving input order within each group. Groups
 * are returned ordered by descending count, with ties broken alphabetically
 * by genre slug so output is deterministic.
 */
export function groupByGenre(
  cards: ReadonlyArray<CardData>,
): Array<{ genre: Genre; cards: CardData[] }> {
  const buckets = new Map<Genre, CardData[]>();
  for (const c of cards) {
    const list = buckets.get(c.genre);
    if (list) list.push(c);
    else buckets.set(c.genre, [c]);
  }
  return [...buckets.entries()]
    .map(([genre, cs]) => ({ genre, cards: cs }))
    .sort((a, b) => b.cards.length - a.cards.length || a.genre.localeCompare(b.genre));
}

/** Per-rarity counts across the supplied cards. */
export function rarityCounts(cards: ReadonlyArray<CardData>): Record<Rarity, number> {
  const counts: Record<Rarity, number> = {
    common: 0,
    uncommon: 0,
    rare: 0,
    foil: 0,
    legendary: 0,
  };
  for (const c of cards) counts[c.rarity]++;
  return counts;
}

/** Distinct mood tags appearing across the supplied cards, alphabetized. */
export function uniqueMoods(cards: ReadonlyArray<CardData>): string[] {
  const set = new Set<string>();
  for (const c of cards) for (const t of c.moodTags) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Distinct genres appearing across the supplied cards, alphabetized. */
export function uniqueGenres(cards: ReadonlyArray<CardData>): Genre[] {
  const set = new Set<Genre>();
  for (const c of cards) set.add(c.genre);
  return [...set].sort((a, b) => a.localeCompare(b));
}
