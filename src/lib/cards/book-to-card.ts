/**
 * Mapper: Drizzle `books` row → UI `CardData`.
 *
 * Keeps the component layer free of DB types. The row shape returned by
 * Drizzle uses camelCase because we configured `casing: 'snake_case'` in
 * drizzle.config.ts (column names stay snake_case in SQL, but the TS types
 * are camelCase).
 */

import type { Rarity } from './types'
import type { CardData } from './types'

export interface BookRow {
  id: string
  title: string
  authors: ReadonlyArray<string>
  coverUrl: string | null
  description: string | null
  pageCount: number | null
  publishedYear: number | null
  genre: string
  rarity: Rarity
  moodTags: ReadonlyArray<string>
}

export function bookRowToCardData(row: BookRow): CardData {
  return {
    id: row.id,
    title: row.title,
    authors: row.authors,
    // The UI component requires a string — fall back to a tiny data-URI pixel
    // so missing covers render a blank tile instead of crashing. Shouldn't
    // happen in practice because the seed always sets coverUrl.
    coverUrl:
      row.coverUrl ??
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
    description: row.description ?? '',
    pageCount: row.pageCount ?? 0,
    publishedYear: row.publishedYear ?? 0,
    genre: row.genre,
    rarity: row.rarity,
    moodTags: row.moodTags,
  }
}
