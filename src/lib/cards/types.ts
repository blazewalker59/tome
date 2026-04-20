/**
 * UI-facing Card type. Decoupled from the Drizzle row shape so components
 * don't pull in DB types. Mapper from `books` row → `CardData` will live
 * alongside the data layer once it exists.
 */

/**
 * Open-ended genre slug. Stored as a kebab-case string (e.g. `science-fiction`,
 * `historical-fiction`, `biography`). Display formatting is handled by
 * `formatGenre` in `style.ts`.
 *
 * Kept as `string` rather than a closed union so editorial curators can
 * introduce new genres without code changes.
 */
export type Genre = string;
export type Rarity = "common" | "uncommon" | "rare" | "foil" | "legendary";

export interface CardData {
  id: string;
  title: string;
  authors: ReadonlyArray<string>;
  coverUrl: string;
  description: string;
  pageCount: number;
  publishedYear: number;
  genre: Genre;
  rarity: Rarity;
  /** Max 3 in production. */
  moodTags: ReadonlyArray<string>;
}
