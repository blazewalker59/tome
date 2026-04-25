/**
 * Admin-only server functions for curating the catalog and packs.
 *
 * Scope:
 *   • Browse all ingested books with pack memberships (admin library view).
 *   • Edit a book's editorial fields (genre, mood tags) in place.
 *   • List + create editorial packs.
 *   • Add, remove, and bulk-set a book's pack memberships.
 *
 * All writes gate on `requireAdmin()` before touching the DB. The `rarity`
 * column is intentionally never written here — rarity is recomputed
 * globally by `pnpm db:rebucket` (see `scripts/rebucket.ts`). This module
 * does not touch Hardcover; it's a pure curation surface on top of already
 * ingested rows.
 *
 * Hardcover ingest lives in `src/server/ingest.ts`; we share the same
 * slug / genre / mood-tag format invariants (kebab-case) with the
 * validators below so data stays consistent across entry points.
 */

import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { books, packBooks, packs } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/session";
import { bookResponseToRow } from "@/lib/cards/hardcover";
import type { Rarity } from "@/lib/cards/rarity";
import { fetchBookById } from "./hardcover";
import { withErrorLogging } from "./_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Error-logging wrapper (mirrors src/server/collection.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `withErrorLogging` moved to `./_shared` — one definition shared
 * across every server module so the log format stays consistent.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators (format: kebab-case for slugs, genres, mood tags)
// ─────────────────────────────────────────────────────────────────────────────

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Exported for unit testing; also reused across every pack/book server fn
 * here so "what counts as a slug" has a single definition.
 */
export function normalizeKebab(value: string, label: string): string {
  const v = value.trim().toLowerCase();
  if (!KEBAB.test(v)) {
    throw new Error(
      `${label} must be kebab-case (lowercase letters, digits, hyphens): got "${value}"`,
    );
  }
  return v;
}

export function normalizeMoodTags(raw: ReadonlyArray<unknown>): string[] {
  const tags = raw
    .map((t) => String(t ?? "").trim().toLowerCase())
    .filter((t) => t.length > 0);
  for (const t of tags) {
    if (!KEBAB.test(t)) {
      throw new Error(`Mood tags must be kebab-case; got "${t}"`);
    }
  }
  if (tags.length > 3) {
    throw new Error(`At most 3 mood tags allowed; got ${tags.length}`);
  }
  // Dedupe preserving first occurrence.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Same shape as `normalizeMoodTags` but for `packs.genre_tags`. Mirrors
 * the validator in `src/server/user-packs.ts` so the editorial admin
 * surface and the user pack-builder enforce the exact same rules
 * (kebab-case, ≤3 tags, dedupe). Inlined rather than imported across
 * server modules to keep `catalog.ts` independent of user-pack code
 * paths — both validators are tiny and unlikely to drift.
 */
export function normalizePackGenreTags(raw: ReadonlyArray<unknown>): string[] {
  const tags = raw
    .map((t) => String(t ?? "").trim().toLowerCase())
    .filter((t) => t.length > 0);
  for (const t of tags) {
    if (!KEBAB.test(t)) {
      throw new Error(`Genre tag must be kebab-case; got "${t}"`);
    }
  }
  if (tags.length > 3) {
    throw new Error(`At most 3 genre tags allowed; got ${tags.length}`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  // Loose UUID check — we let postgres do final validation on the cast,
  // but reject obviously-wrong values before a round trip.
  if (!/^[0-9a-fA-F-]{16,64}$/.test(value)) {
    throw new Error(`${label} is not a valid id: "${value}"`);
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Books — list + update editorial fields
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminBookRow {
  id: string;
  hardcoverId: number;
  title: string;
  authors: ReadonlyArray<string>;
  coverUrl: string | null;
  genre: string;
  rarity: string;
  moodTags: ReadonlyArray<string>;
  ratingsCount: number;
  averageRating: string | null;
  publishedYear: number | null;
  /** Epoch ms when the row was first inserted. Drives the default
   * "most recently ingested" sort in the admin table. */
  createdAt: number;
  /** Packs this book belongs to, slug-keyed for display. */
  packs: ReadonlyArray<{ id: string; slug: string; name: string }>;
}

export type AdminBooksSortKey = "ingested" | "author" | "title";
export type SortDir = "asc" | "desc";

export interface ListBooksInput {
  /** Optional case-insensitive substring match over title + author array. */
  search?: string;
  limit?: number;
  offset?: number;
  /** Column to sort by. Default: `ingested` (newest first). */
  sort?: AdminBooksSortKey;
  /** Sort direction. Default: `desc` for ingested, `asc` for author/title. */
  dir?: SortDir;
}

export interface ListBooksResult {
  items: ReadonlyArray<AdminBookRow>;
  total: number;
}

/**
 * Admin browse of every book in the catalog. Supports a lightweight
 * title/author substring search and simple offset paging so the admin
 * UI doesn't have to ship the entire catalog to the client.
 *
 * Pack memberships are fetched in a single follow-up IN-list query and
 * joined in memory; with at most `limit` books per page that's cheap and
 * keeps the top-level query flat.
 */
export const listBooksFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): ListBooksInput => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const sortRaw = typeof r.sort === "string" ? r.sort : undefined;
    const sort: AdminBooksSortKey | undefined =
      sortRaw === "ingested" || sortRaw === "author" || sortRaw === "title"
        ? sortRaw
        : undefined;
    const dirRaw = typeof r.dir === "string" ? r.dir : undefined;
    const dir: SortDir | undefined =
      dirRaw === "asc" || dirRaw === "desc" ? dirRaw : undefined;
    return {
      search: typeof r.search === "string" ? r.search : undefined,
      limit: r.limit === undefined ? undefined : Number(r.limit),
      offset: r.offset === undefined ? undefined : Number(r.offset),
      sort,
      dir,
    };
  })
  .handler(
    withErrorLogging("listBooksFn", async ({ data }): Promise<ListBooksResult> => {
      await requireAdmin();
      const database = await getDb();

      const limit = Math.min(Math.max(data.limit ?? 50, 1), 200);
      const offset = Math.max(data.offset ?? 0, 0);
      const search = data.search?.trim() ?? "";
      const sort: AdminBooksSortKey = data.sort ?? "ingested";
      // Sensible default direction per column: newest-first for ingested,
      // A→Z for the alphabetical columns.
      const dir: SortDir =
        data.dir ?? (sort === "ingested" ? "desc" : "asc");

      // `authors` is `text[]`; we search it by unnesting into a single
      // whitespace-separated string via `array_to_string` + `ilike`. Not
      // index-friendly but fine at our scale (a few hundred books).
      const searchClause = search
        ? or(
            ilike(books.title, `%${search}%`),
            sql`array_to_string(${books.authors}, ' ') ilike ${"%" + search + "%"}`,
          )
        : undefined;

      // Sorting.
      //
      //   * `ingested` → `books.created_at`. Straightforward timestamp sort.
      //   * `title`    → plain text sort on `books.title`.
      //   * `author`   → sort on the *first* author only. `authors` is a
      //     `text[]`; `authors[1]` in SQL (1-indexed) collapses the array
      //     to a single sortable text value. Books with no authors (empty
      //     array) get NULL there; `NULLS LAST` pushes them to the bottom
      //     regardless of direction so they don't hog the top of A→Z.
      //
      // We always add `books.id` as a secondary tiebreaker so paging is
      // stable across calls even when primary-sort values collide.
      const primary =
        sort === "ingested"
          ? books.createdAt
          : sort === "title"
          ? books.title
          : sql`${books.authors}[1]`;
      const orderExpr =
        sort === "author"
          ? dir === "asc"
            ? sql`${primary} asc nulls last, ${books.id} asc`
            : sql`${primary} desc nulls last, ${books.id} desc`
          : dir === "asc"
          ? sql`${primary} asc, ${books.id} asc`
          : sql`${primary} desc, ${books.id} desc`;

      const baseQuery = database
        .select({
          id: books.id,
          hardcoverId: books.hardcoverId,
          title: books.title,
          authors: books.authors,
          coverUrl: books.coverUrl,
          genre: books.genre,
          rarity: books.rarity,
          moodTags: books.moodTags,
          ratingsCount: books.ratingsCount,
          averageRating: books.averageRating,
          publishedYear: books.publishedYear,
          createdAt: books.createdAt,
        })
        .from(books);

      const rows = await (searchClause ? baseQuery.where(searchClause) : baseQuery)
        .orderBy(orderExpr)
        .limit(limit)
        .offset(offset);

      const [{ total }] = search
        ? await database
            .select({ total: sql<number>`count(*)::int` })
            .from(books)
            .where(searchClause!)
        : await database.select({ total: sql<number>`count(*)::int` }).from(books);

      // Pack memberships for the returned page only.
      const bookIds = rows.map((r) => r.id);
      const memberships =
        bookIds.length === 0
          ? []
          : await database
              .select({
                bookId: packBooks.bookId,
                packId: packs.id,
                slug: packs.slug,
                name: packs.name,
              })
              .from(packBooks)
              .innerJoin(packs, eq(packBooks.packId, packs.id))
              .where(inArray(packBooks.bookId, bookIds));

      const packsByBook = new Map<string, AdminBookRow["packs"][number][]>();
      for (const m of memberships) {
        const list = packsByBook.get(m.bookId) ?? [];
        list.push({ id: m.packId, slug: m.slug, name: m.name });
        packsByBook.set(m.bookId, list);
      }

      return {
        items: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.getTime(),
          packs: packsByBook.get(r.id) ?? [],
        })),
        total,
      };
    }),
  );

export interface UpdateBookCurationInput {
  bookId: string;
  genre?: string;
  moodTags?: ReadonlyArray<string>;
}

export interface UpdateBookCurationResult {
  bookId: string;
  genre: string;
  moodTags: ReadonlyArray<string>;
}

/**
 * Update editorial metadata on a single book. `rarity` is deliberately
 * not writable here — it's owned by the rebucket script. Other catalog
 * metadata (title, cover, ratings) comes from Hardcover and is refreshed
 * by re-ingesting, so we don't expose manual overrides for those either.
 */
export const updateBookCurationFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): UpdateBookCurationInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("updateBookCurationFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    return {
      bookId: requireUuid(r.bookId, "bookId"),
      genre: typeof r.genre === "string" ? r.genre : undefined,
      moodTags: Array.isArray(r.moodTags) ? (r.moodTags as string[]) : undefined,
    };
  })
  .handler(
    withErrorLogging(
      "updateBookCurationFn",
      async ({ data }): Promise<UpdateBookCurationResult> => {
        await requireAdmin();
        const database = await getDb();

        const patch: Record<string, unknown> = { updatedAt: sql`now()` };
        if (data.genre !== undefined) {
          patch.genre = normalizeKebab(data.genre, "Genre");
        }
        if (data.moodTags !== undefined) {
          patch.moodTags = normalizeMoodTags(data.moodTags);
        }

        const [updated] = await database
          .update(books)
          .set(patch)
          .where(eq(books.id, data.bookId))
          .returning({
            id: books.id,
            genre: books.genre,
            moodTags: books.moodTags,
          });

        if (!updated) {
          throw new Error(`Book ${data.bookId} not found`);
        }
        return {
          bookId: updated.id,
          genre: updated.genre,
          moodTags: updated.moodTags,
        };
      },
    ),
  );

const RARITY_VALUES: ReadonlyArray<Rarity> = [
  "common",
  "uncommon",
  "rare",
  "foil",
  "legendary",
];

export interface UpdateBookRarityInput {
  bookId: string;
  rarity: Rarity;
}

export interface UpdateBookRarityResult {
  bookId: string;
  rarity: Rarity;
}

/**
 * Manual rarity override on a single book.
 *
 * Rarity is normally owned by the rebucket script (`pnpm db:rebucket`,
 * see `scripts/rebucket.ts`) which derives buckets from a global
 * score distribution. This fn lets an admin pin a specific book's
 * rarity for editorial reasons — e.g. "this title is a flagship for
 * the Modern Fantasy Starter pack, force it to legendary regardless
 * of its Hardcover ratings count".
 *
 * Important caveat: rarity lives on `books`, not `pack_books`. A
 * change here is global — the book gets the new rarity in every pack
 * it appears in, in the user's existing collection cards, and in
 * future rolls. The admin UI surfaces this via a warning chip; this
 * fn doesn't try to scope the change.
 *
 * Re-running rebucket will overwrite manual overrides. That's
 * intentional for now (rebucket is the source of truth); if we need
 * sticky overrides we can add a `rarity_overridden` boolean column
 * later.
 */
export const updateBookRarityFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): UpdateBookRarityInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("updateBookRarityFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    const bookId = requireUuid(r.bookId, "bookId");
    const rarity = String(r.rarity ?? "");
    if (!RARITY_VALUES.includes(rarity as Rarity)) {
      throw new Error(
        `rarity must be one of ${RARITY_VALUES.join(", ")}; got "${rarity}"`,
      );
    }
    return { bookId, rarity: rarity as Rarity };
  })
  .handler(
    withErrorLogging(
      "updateBookRarityFn",
      async ({ data }): Promise<UpdateBookRarityResult> => {
        await requireAdmin();
        const database = await getDb();

        const [updated] = await database
          .update(books)
          .set({ rarity: data.rarity, updatedAt: sql`now()` })
          .where(eq(books.id, data.bookId))
          .returning({ id: books.id, rarity: books.rarity });

        if (!updated) {
          throw new Error(`Book ${data.bookId} not found`);
        }
        return { bookId: updated.id, rarity: updated.rarity as Rarity };
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Packs — list, create, read one
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminPackSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /**
   * NULL = editorial (Tome-authored). Admin UI lists all packs so
   * moderators can see user-built ones too, but the editorial/create flow
   * only touches creator_id IS NULL rows.
   */
  creatorId: string | null;
  isPublic: boolean;
  coverImageUrl: string | null;
  createdAt: number;
  bookCount: number;
}

export const listPacksFn = createServerFn({ method: "GET" }).handler(
  withErrorLogging("listPacksFn", async (): Promise<ReadonlyArray<AdminPackSummary>> => {
    await requireAdmin();
    const database = await getDb();

    // One query with LEFT JOIN + GROUP BY so packs with zero books still
    // appear. `count(pack_id)` (not `count(*)`) correctly returns 0 for
    // packs that LEFT JOIN produces a single NULL row for.
    const rows = await database
      .select({
        id: packs.id,
        slug: packs.slug,
        name: packs.name,
        description: packs.description,
        creatorId: packs.creatorId,
        isPublic: packs.isPublic,
        coverImageUrl: packs.coverImageUrl,
        createdAt: packs.createdAt,
        bookCount: sql<number>`count(${packBooks.packId})::int`,
      })
      .from(packs)
      .leftJoin(packBooks, eq(packBooks.packId, packs.id))
      .groupBy(packs.id)
      .orderBy(desc(packs.createdAt));

    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.getTime(),
    }));
    }),
  );

export interface UpdatePackInput {
  packId: string;
  name?: string;
  /** Empty string clears the description; `undefined` leaves it
   *  unchanged. The two need to be distinguishable so the form can
   *  patch a single field without erasing siblings. */
  description?: string | null;
  /** Same null/undefined contract as `description`. */
  coverImageUrl?: string | null;
  /** Full replacement (validator dedupes + caps at 3). Pass an empty
   *  array to clear every tag. `undefined` leaves the column alone. */
  genreTags?: ReadonlyArray<string>;
}

export interface UpdatePackResult {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  coverImageUrl: string | null;
  genreTags: ReadonlyArray<string>;
}

/**
 * Edit an editorial pack's metadata in place. Slug is intentionally
 * NOT editable — it's part of public URLs (e.g. `/rip/$slug`),
 * referenced by the gradient lookup, and embedded in users' rip
 * history; a rename would invalidate every shared link without any
 * meaningful upside. If renaming becomes necessary, do it as a
 * deliberate one-off script with a redirect, not a per-request
 * mutation.
 *
 * Membership and rarity are owned by separate fns
 * (`addBookToPackFn` / `removeBookFromPackFn` / `updateBookRarityFn`)
 * so this surface stays focused on pack-level fields.
 */
export const updatePackFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): UpdatePackInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("updatePackFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    const out: UpdatePackInput = { packId: requireUuid(r.packId, "packId") };

    if ("name" in r) {
      const name = String(r.name ?? "").trim();
      if (name.length === 0) throw new Error("Pack name cannot be empty");
      if (name.length > 120) throw new Error("Pack name must be ≤120 characters");
      out.name = name;
    }
    // Treat present-but-empty as an explicit clear (null), mirroring how
    // the user-pack edit flow handles optional text fields.
    if ("description" in r) {
      const v = typeof r.description === "string" ? r.description.trim() : "";
      out.description = v.length > 0 ? v : null;
    }
    if ("coverImageUrl" in r) {
      const v = typeof r.coverImageUrl === "string" ? r.coverImageUrl.trim() : "";
      out.coverImageUrl = v.length > 0 ? v : null;
    }
    if ("genreTags" in r) {
      out.genreTags = normalizePackGenreTags(
        Array.isArray(r.genreTags) ? (r.genreTags as unknown[]) : [],
      );
    }
    return out;
  })
  .handler(
    withErrorLogging("updatePackFn", async ({ data }): Promise<UpdatePackResult> => {
      await requireAdmin();
      const database = await getDb();

      // Build the patch incrementally so absent fields stay untouched.
      // `updatedAt` isn't a column on `packs` (the schema only tracks
      // `createdAt` + `publishedAt`), so we don't bump anything beyond
      // the user-visible fields.
      const patch: Record<string, unknown> = {};
      if (data.name !== undefined) patch.name = data.name;
      if (data.description !== undefined) patch.description = data.description;
      if (data.coverImageUrl !== undefined) patch.coverImageUrl = data.coverImageUrl;
      if (data.genreTags !== undefined) patch.genreTags = [...data.genreTags];

      if (Object.keys(patch).length === 0) {
        // Nothing to write — re-fetch and return current state so the UI
        // sees a stable shape regardless of whether anything changed.
        const [row] = await database
          .select({
            id: packs.id,
            slug: packs.slug,
            name: packs.name,
            description: packs.description,
            coverImageUrl: packs.coverImageUrl,
            genreTags: packs.genreTags,
          })
          .from(packs)
          .where(and(eq(packs.id, data.packId), isNull(packs.creatorId)))
          .limit(1);
        if (!row) throw new Error(`Editorial pack ${data.packId} not found`);
        return row;
      }

      // Scope the update to the editorial namespace — admin must not be
      // able to mutate user-built packs through this fn even if a
      // packId leaks across surfaces.
      const [updated] = await database
        .update(packs)
        .set(patch)
        .where(and(eq(packs.id, data.packId), isNull(packs.creatorId)))
        .returning({
          id: packs.id,
          slug: packs.slug,
          name: packs.name,
          description: packs.description,
          coverImageUrl: packs.coverImageUrl,
          genreTags: packs.genreTags,
        });

      if (!updated) {
        throw new Error(`Editorial pack ${data.packId} not found`);
      }
      return updated;
    }),
  );


export interface CreatePackInput {
  slug: string;
  name: string;
  description?: string;
  coverImageUrl?: string;
}

export interface CreatePackResult {
  id: string;
  slug: string;
  name: string;
}

/**
 * Create a new editorial pack. Editorial packs have `creator_id = NULL`
 * and auto-publish (they are curated by Tome, not drafts). Slug
 * uniqueness is scoped to the editorial namespace by a partial unique
 * index (`packs_editorial_slug_uq`); we pre-check so the user-facing
 * error is friendlier than the raw constraint violation.
 */
export const createPackFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): CreatePackInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("createPackFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    const name = String(r.name ?? "").trim();
    if (name.length === 0) throw new Error("Pack name is required");
    if (name.length > 120) throw new Error("Pack name must be ≤120 characters");

    const description =
      typeof r.description === "string" && r.description.trim().length > 0
        ? r.description.trim()
        : undefined;
    const coverImageUrl =
      typeof r.coverImageUrl === "string" && r.coverImageUrl.trim().length > 0
        ? r.coverImageUrl.trim()
        : undefined;

    return {
      slug: String(r.slug ?? ""),
      name,
      description,
      coverImageUrl,
    };
  })
  .handler(
    withErrorLogging("createPackFn", async ({ data }): Promise<CreatePackResult> => {
      await requireAdmin();
      const slug = normalizeKebab(data.slug, "Slug");
      const database = await getDb();

      // Scope the collision check to editorial (creator_id IS NULL) —
      // user-built packs can reuse the same slug under their own
      // namespace; the partial unique index enforces this at the DB
      // level too.
      const existing = await database
        .select({ id: packs.id })
        .from(packs)
        .where(and(eq(packs.slug, slug), isNull(packs.creatorId)))
        .limit(1);
      if (existing.length > 0) {
        throw new Error(`Editorial pack slug "${slug}" already exists`);
      }

      const [created] = await database
        .insert(packs)
        .values({
          slug,
          name: data.name,
          description: data.description,
          coverImageUrl: data.coverImageUrl,
          creatorId: null,
          isPublic: true,
          publishedAt: new Date(),
        })
        .returning({ id: packs.id, slug: packs.slug, name: packs.name });

      if (!created) throw new Error("Pack insert returned no row");
      return created;
    }),
  );

export interface AdminPackDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  creatorId: string | null;
  isPublic: boolean;
  coverImageUrl: string | null;
  /** Curated genre tags (1–3, kebab-case). Drives the gradient lookup
   *  on the rip surface and powers discovery filters; admin can edit
   *  via `updatePackFn`. */
  genreTags: ReadonlyArray<string>;
  createdAt: number;
  books: ReadonlyArray<{
    id: string;
    title: string;
    authors: ReadonlyArray<string>;
    coverUrl: string | null;
    genre: string;
    rarity: string;
  }>;
}

export const getPackFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): { slug: string } => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const slug = String(r.slug ?? "").trim().toLowerCase();
    if (!slug) throw new Error("slug is required");
    return { slug };
  })
  .handler(
    withErrorLogging("getPackFn", async ({ data }): Promise<AdminPackDetail> => {
      await requireAdmin();
      const database = await getDb();

      // Admin pack view scopes to the editorial namespace (creator_id IS
      // NULL). User-built packs have their own moderation surface — this
      // function only ever serves Tome-authored rows.
      const [pack] = await database
        .select({
          id: packs.id,
          slug: packs.slug,
          name: packs.name,
          description: packs.description,
          creatorId: packs.creatorId,
          isPublic: packs.isPublic,
          coverImageUrl: packs.coverImageUrl,
          genreTags: packs.genreTags,
          createdAt: packs.createdAt,
        })
        .from(packs)
        .where(and(eq(packs.slug, data.slug), isNull(packs.creatorId)))
        .limit(1);
      if (!pack) throw new Error(`Pack "${data.slug}" not found`);

      const rows = await database
        .select({
          id: books.id,
          title: books.title,
          authors: books.authors,
          coverUrl: books.coverUrl,
          genre: books.genre,
          rarity: books.rarity,
        })
        .from(packBooks)
        .innerJoin(books, eq(packBooks.bookId, books.id))
        .where(eq(packBooks.packId, pack.id))
        .orderBy(asc(books.title));

      return {
        id: pack.id,
        slug: pack.slug,
        name: pack.name,
        description: pack.description,
        creatorId: pack.creatorId,
        isPublic: pack.isPublic,
        coverImageUrl: pack.coverImageUrl,
        genreTags: pack.genreTags,
        createdAt: pack.createdAt.getTime(),
        books: rows,
      };
    }),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Pack membership — add / remove / bulk-set-for-book
// ─────────────────────────────────────────────────────────────────────────────

export interface PackMembershipInput {
  packId: string;
  bookId: string;
}

/**
 * Add a book to a pack. Idempotent on the composite PK — re-adding the
 * same pair is a no-op, not an error, so the UI can wire a checkbox to
 * this without tracking prior state.
 */
export const addBookToPackFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): PackMembershipInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("addBookToPackFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    return {
      packId: requireUuid(r.packId, "packId"),
      bookId: requireUuid(r.bookId, "bookId"),
    };
  })
  .handler(
    withErrorLogging("addBookToPackFn", async ({ data }): Promise<{ ok: true }> => {
      await requireAdmin();
      const database = await getDb();
      await database
        .insert(packBooks)
        .values({ packId: data.packId, bookId: data.bookId })
        .onConflictDoNothing();
      return { ok: true };
    }),
  );

export const removeBookFromPackFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): PackMembershipInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("removeBookFromPackFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    return {
      packId: requireUuid(r.packId, "packId"),
      bookId: requireUuid(r.bookId, "bookId"),
    };
  })
  .handler(
    withErrorLogging("removeBookFromPackFn", async ({ data }): Promise<{ ok: true }> => {
      await requireAdmin();
      const database = await getDb();
      await database
        .delete(packBooks)
        .where(and(eq(packBooks.packId, data.packId), eq(packBooks.bookId, data.bookId)));
      return { ok: true };
    }),
  );

export interface SetBookPacksInput {
  bookId: string;
  /** The complete set of pack ids the book should belong to after this call. */
  packIds: ReadonlyArray<string>;
}

/**
 * Bulk-replace a book's pack memberships to exactly `packIds`. Computes
 * the diff and issues a single INSERT (for adds) + single DELETE (for
 * removes) so the checkbox-modal use case runs in at most two writes.
 *
 * Not wrapped in a transaction: pack membership is advisory data, and
 * the worst case on partial failure is that the set of packs differs
 * from the UI's last-known state — recoverable by retry.
 */
export const setBookPacksFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): SetBookPacksInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("setBookPacksFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    const packIdsRaw = Array.isArray(r.packIds) ? (r.packIds as unknown[]) : [];
    const packIds = packIdsRaw.map((id, i) => requireUuid(id, `packIds[${i}]`));
    return {
      bookId: requireUuid(r.bookId, "bookId"),
      packIds,
    };
  })
  .handler(
    withErrorLogging(
      "setBookPacksFn",
      async ({ data }): Promise<{ added: number; removed: number }> => {
        await requireAdmin();
        const database = await getDb();

        const current = await database
          .select({ packId: packBooks.packId })
          .from(packBooks)
          .where(eq(packBooks.bookId, data.bookId));
        const currentSet = new Set(current.map((c) => c.packId));
        const nextSet = new Set(data.packIds);

        const toAdd = [...nextSet].filter((p) => !currentSet.has(p));
        const toRemove = [...currentSet].filter((p) => !nextSet.has(p));

        if (toAdd.length > 0) {
          await database
            .insert(packBooks)
            .values(toAdd.map((packId) => ({ packId, bookId: data.bookId })))
            .onConflictDoNothing();
        }
        if (toRemove.length > 0) {
          await database
            .delete(packBooks)
            .where(
              and(
                eq(packBooks.bookId, data.bookId),
                inArray(packBooks.packId, toRemove),
              ),
            );
        }

        return { added: toAdd.length, removed: toRemove.length };
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Admin Hardcover ingest (for editorial pack curation)
//
// Mirror of `ingestHardcoverBookForBuilderFn` in `src/server/user-packs.ts`,
// but scoped to editorial packs (`creator_id IS NULL`) and gated on
// `requireAdmin()`. Two intentional differences:
//
//   1. No per-user hourly throttle. The user-side cap exists to prevent
//      a single account from draining the shared 60 req/min Hardcover
//      budget; admins are trusted curators of editorial packs and
//      shouldn't be capped during a curation session.
//
//   2. `ingestedByUserId` is left `null` on insert (admin/legacy
//      convention — see the comment in user-packs.ts at line 974). This
//      keeps the user-side throttle counter from charging this admin's
//      personal account, and reflects that the row is editorial-owned,
//      not user-owned.
//
// Dedup behavior matches the user path: if a `books` row already has the
// requested `hardcover_id`, we skip the Hardcover fetch entirely and just
// link the existing row to the pack.
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestHardcoverForAdminPackResult {
  bookId: string;
  /** True when a fresh `books` row was inserted; false when we deduped. */
  created: boolean;
}

export const ingestHardcoverBookForAdminPackFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): { packId: string; hardcoverId: number } => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("ingestHardcoverBookForAdminPackFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    const packId = requireUuid(r.packId, "packId");
    const hardcoverId = Number(r.hardcoverId);
    if (!Number.isInteger(hardcoverId) || hardcoverId <= 0) {
      throw new Error(`Invalid Hardcover id: ${r.hardcoverId}`);
    }
    return { packId, hardcoverId };
  })
  .handler(
    withErrorLogging(
      "ingestHardcoverBookForAdminPackFn",
      async ({ data }): Promise<IngestHardcoverForAdminPackResult> => {
        await requireAdmin();
        const database = await getDb();

        // Confirm the target is an editorial pack. A guessed user-pack id
        // here would otherwise bypass the user-side ownership check, so
        // the `isNull(creator_id)` guard is load-bearing.
        const [pack] = await database
          .select({ id: packs.id })
          .from(packs)
          .where(and(eq(packs.id, data.packId), isNull(packs.creatorId)))
          .limit(1);
        if (!pack) {
          throw new Error(
            `Editorial pack ${data.packId} not found (or it is a user pack)`,
          );
        }

        // Dedup short-circuit: already-ingested books just get linked.
        const [existing] = await database
          .select({ id: books.id })
          .from(books)
          .where(eq(books.hardcoverId, data.hardcoverId))
          .limit(1);

        if (existing) {
          await database
            .insert(packBooks)
            .values({ packId: pack.id, bookId: existing.id })
            .onConflictDoNothing();
          return { bookId: existing.id, created: false };
        }

        const hardcoverBook = await fetchBookById(data.hardcoverId);
        if (!hardcoverBook) {
          throw new Error(
            `Hardcover book ${data.hardcoverId} not found. It may have been ` +
              `removed or the id is wrong.`,
          );
        }

        // `genre = "unknown"` matches the user-side convention: admins
        // sweep these via the curation surface. Mood tags stay empty for
        // the same reason; rarity defaults to `common` and gets reassigned
        // by the next `pnpm db:rebucket`.
        const row = bookResponseToRow(hardcoverBook, {
          genre: "unknown",
          moodTags: [],
        });

        // Same upsert shape as the user path (see user-packs.ts:1019). On
        // conflict we refresh editorial fields but leave provenance
        // (`ingestedByUserId`, `ingestedAt`) and curation
        // (`genre`, `moodTags`, `rarity`) untouched. `xmax = 0` flags
        // insert vs update so the caller can tell whether a new row was
        // actually created.
        const [upserted] = await database
          .insert(books)
          .values({
            ...row,
            // Admin path: leave provenance null so the row reads as
            // editorial/legacy rather than charged to the admin's
            // personal Hardcover quota.
            ingestedByUserId: null,
            ingestedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: books.hardcoverId,
            set: {
              title: row.title,
              authors: row.authors,
              coverUrl: row.coverUrl,
              description: row.description,
              pageCount: row.pageCount,
              publishedYear: row.publishedYear,
              ratingsCount: row.ratingsCount,
              averageRating: row.averageRating,
              rawMetadata: row.rawMetadata,
              updatedAt: sql`now()`,
            },
          })
          .returning({
            id: books.id,
            created: sql<boolean>`(xmax = 0)`,
          });

        if (!upserted) {
          throw new Error(
            `Upsert of hardcoverId=${data.hardcoverId} returned no row`,
          );
        }

        await database
          .insert(packBooks)
          .values({ packId: pack.id, bookId: upserted.id })
          .onConflictDoNothing();

        return { bookId: upserted.id, created: Boolean(upserted.created) };
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Refresh a single book's API-derived fields from Hardcover
// ─────────────────────────────────────────────────────────────────────────────
//
// Triage tool for the admin /admin/books table. Hardcover occasionally
// rotates cover URLs (the cached_image CDN moves), updates titles, or
// republishes editions; rows ingested months ago can drift out of sync
// with what's authoritative upstream. Rather than re-running the full
// ingest pipeline, this fn re-fetches the single Hardcover record by id
// and overwrites only the fields Hardcover owns.
//
// Boundary discipline (mirrors the on-conflict set list in
// ingestHardcoverBookForAdminPackFn above):
//   API-owned, refreshed → title, authors, coverUrl, description,
//                           pageCount, publishedYear, ratingsCount,
//                           averageRating, rawMetadata
//   Curated, preserved   → genre, moodTags, rarity
//   Provenance, preserved→ ingestedByUserId, ingestedAt
//
// Same 1.1s rate limit as every other Hardcover call (enforced inside
// fetchBookById). One-at-a-time clicks are fine; future bulk variants
// would need to serialize through the same gate.

export interface RefreshBookFromHardcoverInput {
  bookId: string;
}

export interface RefreshBookFromHardcoverResult {
  bookId: string;
  /** True if any of the API-owned fields actually changed. The UI uses
   * this to surface "Refreshed (no changes)" vs "Refreshed (X updated)"
   * so admins can tell whether the broken-cover report was real. */
  changed: boolean;
  /** The post-refresh values for fields the admin table renders, so
   * the caller can splice them into local state without a refetch. */
  title: string;
  authors: ReadonlyArray<string>;
  coverUrl: string | null;
  publishedYear: number | null;
  ratingsCount: number;
  averageRating: string | null;
}

export const refreshBookFromHardcoverFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): RefreshBookFromHardcoverInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("refreshBookFromHardcoverFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    return { bookId: requireUuid(r.bookId, "bookId") };
  })
  .handler(
    withErrorLogging(
      "refreshBookFromHardcoverFn",
      async ({ data }): Promise<RefreshBookFromHardcoverResult> => {
        await requireAdmin();
        const database = await getDb();

        const [existing] = await database
          .select({
            id: books.id,
            hardcoverId: books.hardcoverId,
            coverUrl: books.coverUrl,
            title: books.title,
            authors: books.authors,
          })
          .from(books)
          .where(eq(books.id, data.bookId))
          .limit(1);

        if (!existing) {
          throw new Error(`Book ${data.bookId} not found`);
        }

        const hardcoverBook = await fetchBookById(existing.hardcoverId);
        if (!hardcoverBook) {
          // Either Hardcover removed the record or our stored id is wrong.
          // Surface the cause distinctly so admins know this isn't a
          // transient network error and can investigate the row itself.
          throw new Error(
            `Hardcover book ${existing.hardcoverId} not found upstream. ` +
              `It may have been removed; consider unlinking or replacing this row.`,
          );
        }

        // `bookResponseToRow` needs genre/moodTags but we deliberately
        // discard the genre+moodTags it produces — only the API-owned
        // fields below are written. Passing the existing values keeps
        // the helper happy without leaking back into the DB.
        const row = bookResponseToRow(hardcoverBook, {
          genre: "unknown",
          moodTags: [],
        });

        const [updated] = await database
          .update(books)
          .set({
            title: row.title,
            authors: row.authors,
            coverUrl: row.coverUrl,
            description: row.description,
            pageCount: row.pageCount,
            publishedYear: row.publishedYear,
            ratingsCount: row.ratingsCount,
            averageRating: row.averageRating,
            rawMetadata: row.rawMetadata,
            updatedAt: sql`now()`,
          })
          .where(eq(books.id, data.bookId))
          .returning({
            id: books.id,
            title: books.title,
            authors: books.authors,
            coverUrl: books.coverUrl,
            publishedYear: books.publishedYear,
            ratingsCount: books.ratingsCount,
            averageRating: books.averageRating,
          });

        if (!updated) {
          throw new Error(`Refresh of book ${data.bookId} returned no row`);
        }

        // Cheap shallow diff against the row we read at the top. We
        // only check the most user-visible fields; if Hardcover changed
        // only the description or rawMetadata the admin still sees
        // "no changes" which matches their mental model (they came here
        // because of a broken *cover*).
        const changed =
          updated.coverUrl !== existing.coverUrl ||
          updated.title !== existing.title ||
          updated.authors.join("\u0001") !== existing.authors.join("\u0001");

        return {
          bookId: updated.id,
          changed,
          title: updated.title,
          authors: updated.authors,
          coverUrl: updated.coverUrl,
          publishedYear: updated.publishedYear,
          ratingsCount: updated.ratingsCount,
          averageRating: updated.averageRating,
        };
      },
    ),
  );
