/**
 * Pure filtering, grouping, and sorting for the collection view.
 *
 * Kept separate from the React layer so the logic is trivially testable
 * and reusable from server functions later (e.g. paginated collection
 * queries).
 */

import type { CardData, Genre, Rarity } from "./types";

export type SortMode = "title" | "author" | "rarity" | "newest";

/**
 * The top-level pivot the collection UI is currently displaying. `all`
 * means no grouping — a single flat grid — and is the default.
 */
export type GroupBy = "all" | "pack" | "author" | "rarity" | "genre";

const RARITY_ORDER: Record<Rarity, number> = {
  legendary: 0,
  foil: 1,
  rare: 2,
  uncommon: 3,
  common: 4,
};

const ALL_RARITIES: ReadonlyArray<Rarity> = [
  "common",
  "uncommon",
  "rare",
  "foil",
  "legendary",
];

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

// ─────────────────────────────────────────────────────────────────────────────
// Grouping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A normalised group shape used by every pivot (pack / author / rarity /
 * genre). The `key` is a stable machine identifier suitable for React
 * keys and URL state; `label` is what the UI renders. Consumers iterate
 * the returned array in order — upstream ordering is deterministic.
 */
export interface CardGroup {
  key: string;
  label: string;
  cards: CardData[];
}

export interface GroupContext {
  /** Map bookId → { packId, packName } used by `pack` grouping. Entries
   *  without an attribution can omit `packId` — the book will fall into
   *  an "Unknown" bucket keyed by label. */
  acquisitions?: ReadonlyMap<string, { packId: string | null; packName: string }>;
}

/**
 * Split `cards` into groups according to the requested pivot. Returns
 * `[{ key: 'all', label: 'All books', cards }]` for `all` so the UI can
 * render a single loop regardless of view.
 *
 * Ordering:
 *  • `rarity` — legendary → foil → rare → uncommon → common (the
 *    conventional direction for collection games).
 *  • `pack` / `author` / `genre` — largest group first, ties broken
 *    alphabetically by label. Matches `groupByGenre`'s existing behaviour.
 *
 * Author grouping explodes co-authored books so the same card appears
 * under every author. This matches the "show me everything by X" mental
 * model the user opted for over the alternative (first-author-only).
 */
export function groupCards(
  cards: ReadonlyArray<CardData>,
  groupBy: GroupBy,
  ctx: GroupContext = {},
): CardGroup[] {
  if (groupBy === "all") {
    return [{ key: "all", label: "All books", cards: [...cards] }];
  }

  if (groupBy === "rarity") {
    // Deterministic order + always include the five buckets so the
    // result is easy to reason about; empty buckets are filtered at the
    // end so the UI doesn't render dead sections.
    const buckets = new Map<Rarity, CardData[]>(
      ALL_RARITIES.map((r) => [r, []]),
    );
    for (const c of cards) {
      buckets.get(c.rarity)!.push(c);
    }
    return ALL_RARITIES
      .slice()
      .sort((a, b) => RARITY_ORDER[a] - RARITY_ORDER[b])
      .map((r) => ({
        key: `rarity:${r}`,
        label: r.charAt(0).toUpperCase() + r.slice(1),
        cards: buckets.get(r)!,
      }))
      .filter((g) => g.cards.length > 0);
  }

  if (groupBy === "genre") {
    return bucketBy(cards, (c) => [[c.genre, formatGenreLocal(c.genre)]]).map(
      (g) => ({ key: `genre:${g.key}`, label: g.label, cards: g.cards }),
    );
  }

  if (groupBy === "author") {
    return bucketBy(cards, (c) =>
      (c.authors.length > 0 ? c.authors : ["Unknown"]).map(
        (a) => [a, a] as [string, string],
      ),
    ).map((g) => ({ key: `author:${g.key}`, label: g.label, cards: g.cards }));
  }

  if (groupBy === "pack") {
    const acq = ctx.acquisitions;
    return bucketBy(cards, (c) => {
      const entry = acq?.get(c.id);
      if (entry && entry.packId) {
        return [[entry.packId, entry.packName]];
      }
      // Fall back to whatever label we have so books with no packId
      // still cluster together sensibly rather than each owning a group.
      const label = entry?.packName ?? "Unknown";
      return [[`label:${label}`, label]];
    }).map((g) => ({ key: `pack:${g.key}`, label: g.label, cards: g.cards }));
  }

  // Exhaustiveness guard — if a new GroupBy variant is added, TS will
  // flag this as unreachable and force an update above.
  const _exhaustive: never = groupBy;
  return _exhaustive;
}

/**
 * Generic "explode and bucket" used by the multi-key group modes. The
 * `keysFor` callback returns an array of `[key, label]` pairs so a
 * single card can land in multiple buckets (authors) or exactly one
 * (pack, genre). Label from the first occurrence wins — keys are
 * stable identifiers, labels are cosmetic.
 */
function bucketBy(
  cards: ReadonlyArray<CardData>,
  keysFor: (c: CardData) => ReadonlyArray<readonly [string, string]>,
): Array<{ key: string; label: string; cards: CardData[] }> {
  const buckets = new Map<string, { label: string; cards: CardData[] }>();
  for (const c of cards) {
    for (const [key, label] of keysFor(c)) {
      const existing = buckets.get(key);
      if (existing) existing.cards.push(c);
      else buckets.set(key, { label, cards: [c] });
    }
  }
  return [...buckets.entries()]
    .map(([key, v]) => ({ key, label: v.label, cards: v.cards }))
    .sort(
      (a, b) => b.cards.length - a.cards.length || a.label.localeCompare(b.label),
    );
}

/**
 * Local, dependency-free genre formatter used by grouping so `filter.ts`
 * stays importable from the server without dragging in UI style helpers.
 */
function formatGenreLocal(genre: string): string {
  if (!genre) return "";
  return genre
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * @deprecated Prefer `groupCards(cards, 'genre')`. Kept as a thin
 * adapter so any lingering callers keep working while the route is
 * migrated.
 */
export function groupByGenre(
  cards: ReadonlyArray<CardData>,
): Array<{ genre: Genre; cards: CardData[] }> {
  return groupCards(cards, "genre").map((g) => ({
    // Strip the `genre:` prefix applied by `groupCards` so legacy
    // callers see the raw slug they expect.
    genre: g.key.replace(/^genre:/, "") as Genre,
    cards: g.cards,
  }));
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
