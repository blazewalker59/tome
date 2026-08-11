/**
 * Author list <-> search key.
 *
 * `books.authors` was a Postgres `text[]`, which let author search run
 * entirely in SQL:
 *
 *   EXISTS (SELECT 1 FROM unnest(authors) AS a WHERE a ILIKE '%needle%')
 *
 * SQLite has neither arrays nor `unnest`, and while `json_each` can walk a
 * JSON array, no index can serve a predicate over it — every author search
 * would become a full table scan plus a JSON parse per row.
 *
 * So `authors` stays the display data (a JSON array) and `authors_text`
 * carries a flattened, lowercased copy that a plain `LIKE` can search and an
 * index can narrow. That is a denormalization, and denormalizations rot the
 * moment two writers disagree — hence this module. Both columns are written
 * through `setAuthors()` and nowhere else.
 */

/**
 * Build the `{ authors, authorsText }` column pair from an author list.
 * Spread it into any insert/update that touches authors:
 *
 *   await db.insert(books).values({ title, ...setAuthors(names) })
 *   await db.update(books).set({ ...setAuthors(names) }).where(...)
 */
export function setAuthors(authors: Array<string>): {
  authors: Array<string>;
  authorsText: string;
} {
  const clean = authors.map((a) => a.trim()).filter((a) => a.length > 0);
  return { authors: clean, authorsText: toAuthorsText(clean) };
}

/**
 * The search-key projection on its own. Lowercased because SQLite's `LIKE` is
 * only case-insensitive for unquoted ASCII by default — folding both the
 * column and the needle sidesteps that and makes non-ASCII author names
 * (Kobayashi, Ferrante, Solzhenitsyn transliterations) behave consistently.
 */
export function toAuthorsText(authors: Array<string>): string {
  return authors.join(" ").toLowerCase();
}

/**
 * Normalize a user-supplied search term the same way `authors_text` was
 * built, so the comparison is apples-to-apples.
 */
export function toAuthorsNeedle(search: string): string {
  return search.trim().toLowerCase();
}
