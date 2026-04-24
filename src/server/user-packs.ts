/**
 * Server functions for user-built packs.
 *
 * Scope:
 *   • Drafts and publishes of creator-authored packs (`packs.creator_id`
 *     NOT NULL). Editorial packs are handled in `catalog.ts` by admin.
 *   • Book search used by the builder UI (global catalog, not just the
 *     creator's collection — the plan is explicit about this).
 *   • Public pack lookup by `(username, slug)` for the `/u/$u/$s` route.
 *
 * Authorization model:
 *   • Drafts: visible only to their creator. No soft-unlock gate on
 *     creating/editing — the plan explicitly says "Drafts unrestricted;
 *     only publish is gated."
 *   • Publish: creator must be signed in, own the draft, have ≥N
 *     finished books (`getPublishUnlockStatus`), and the draft must
 *     pass `checkPackComposition`.
 *   • Public view: anyone, even anonymous — the `/u/$u/$s` route shows
 *     the pack; rips (handled by `recordRipFn` in `collection.ts`) still
 *     require auth. That's the "sign-in-to-rip" CTA from the plan.
 *
 * Slug semantics:
 *   • Auto-derived from name if the creator doesn't supply one. Slug
 *     uniqueness is per-creator, enforced by the `packs_creator_slug_uq`
 *     partial index; we pre-check to surface a friendlier error.
 *   • Slugs cannot change after publish (part of the "contents frozen"
 *     rule in the plan). Enforced in `updatePackDraftFn`.
 */

import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { books, packBooks, packs, users } from "@/db/schema";
import { requireSessionUser } from "@/lib/auth/session";
import { getEconomy } from "@/lib/economy/config";
import type { Rarity } from "@/lib/packs/composition";
import { checkPackComposition } from "@/lib/packs/composition";
import { getPublishUnlockStatus } from "@/lib/packs/unlock";
import { bookResponseToRow } from "@/lib/cards/hardcover";
import {
  fetchBookById,
  searchBooks,
  type HardcoverSearchHit,
} from "./hardcover";
import { normalizeKebab } from "./catalog";
import { withErrorLogging } from "./_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Shared shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full draft/published pack shape returned to the owner (for editing)
 * and a trimmed subset to the public (see `PublicPackPayload`).
 */
export interface MyPackDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  coverImageUrl: string | null;
  genreTags: ReadonlyArray<string>;
  isPublic: boolean;
  publishedAt: number | null;
  createdAt: number;
  books: ReadonlyArray<{
    id: string;
    title: string;
    authors: ReadonlyArray<string>;
    coverUrl: string | null;
    genre: string;
    rarity: Rarity;
    position: number;
  }>;
}

export interface PublicPackPayload {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  coverImageUrl: string | null;
  genreTags: ReadonlyArray<string>;
  publishedAt: number | null;
  creator: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
  books: ReadonlyArray<{
    id: string;
    title: string;
    authors: ReadonlyArray<string>;
    coverUrl: string | null;
    genre: string;
    rarity: Rarity;
  }>;
}

// Slug length ceiling. Postgres `text` is unbounded, but URLs should stay
// reasonable and this keeps the collision-check cheap.
const MAX_SLUG_LEN = 80;
const MAX_NAME_LEN = 120;
const MAX_DESCRIPTION_LEN = 2000;
const MAX_GENRE_TAGS = 3;

function trimOptionalString(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (v.length === 0) return undefined;
  if (v.length > max) throw new Error(`String exceeds ${max} characters`);
  return v;
}

function normalizeGenreTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags = raw
    .map((t) => String(t ?? "").trim().toLowerCase())
    .filter((t) => t.length > 0);
  for (const t of tags) {
    // Reuse the kebab validator — genre tags follow the same rule as
    // book genres so they're compatible with future discovery filters.
    normalizeKebab(t, "Genre tag");
  }
  if (tags.length > MAX_GENRE_TAGS) {
    throw new Error(`At most ${MAX_GENRE_TAGS} genre tags allowed`);
  }
  // Dedupe, preserving first-seen order.
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
 * Build a candidate slug from a pack name. Lowercase, strip accents,
 * collapse non-alphanumerics to single hyphens, trim. Not guaranteed
 * unique — callers must dedupe via a collision check.
 */
function slugifyName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN);
  if (base.length === 0) throw new Error("Pack name must contain letters or digits");
  return base;
}

/**
 * Pick a free slug for `creatorId`, starting with `candidate` and
 * appending `-2`, `-3`, … until it doesn't collide. Small loop, fine
 * for low-volume creator action; the partial unique index is the final
 * backstop.
 */
async function reserveSlugForCreator(
  database: Awaited<ReturnType<typeof getDb>>,
  creatorId: string,
  candidate: string,
): Promise<string> {
  const existing = await database
    .select({ slug: packs.slug })
    .from(packs)
    .where(and(eq(packs.creatorId, creatorId), ilike(packs.slug, `${candidate}%`)));
  const taken = new Set(existing.map((r) => r.slug));
  if (!taken.has(candidate)) return candidate;
  for (let n = 2; n < 1000; n += 1) {
    const next = `${candidate}-${n}`.slice(0, MAX_SLUG_LEN);
    if (!taken.has(next)) return next;
  }
  // Absurd: creator has >1000 packs with the same base slug. Fail loud.
  throw new Error(`Could not find a free slug starting with "${candidate}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Create draft
// ─────────────────────────────────────────────────────────────────────────────

export interface CreatePackDraftInput {
  name: string;
  description?: string;
  /** Optional — auto-derived from name if omitted. */
  slug?: string;
  coverImageUrl?: string;
  genreTags?: ReadonlyArray<string>;
}

export interface CreatePackDraftResult {
  id: string;
  slug: string;
}

export const createPackDraftFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): CreatePackDraftInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("createPackDraftFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    const name = String(r.name ?? "").trim();
    if (name.length === 0) throw new Error("Pack name is required");
    if (name.length > MAX_NAME_LEN) {
      throw new Error(`Pack name must be ≤${MAX_NAME_LEN} characters`);
    }
    return {
      name,
      description: trimOptionalString(r.description, MAX_DESCRIPTION_LEN),
      slug: trimOptionalString(r.slug, MAX_SLUG_LEN),
      coverImageUrl: trimOptionalString(r.coverImageUrl, 2048),
      genreTags: normalizeGenreTags(r.genreTags),
    };
  })
  .handler(
    withErrorLogging(
      "createPackDraftFn",
      async ({ data }): Promise<CreatePackDraftResult> => {
        const user = await requireSessionUser();
        const database = await getDb();

        // Slug: either the creator's explicit choice (validated as
        // kebab-case) or derived from the name. Either way, reserve
        // against their own namespace so we don't have to handle the
        // partial-unique-index error at the DB layer.
        const base =
          data.slug !== undefined
            ? normalizeKebab(data.slug, "Slug")
            : slugifyName(data.name);
        const slug = await reserveSlugForCreator(database, user.id, base);

        const [created] = await database
          .insert(packs)
          .values({
            creatorId: user.id,
            slug,
            name: data.name,
            description: data.description,
            coverImageUrl: data.coverImageUrl,
            genreTags: data.genreTags ? [...data.genreTags] : [],
            isPublic: false,
          })
          .returning({ id: packs.id, slug: packs.slug });
        if (!created) throw new Error("Pack insert returned no row");
        return created;
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Update draft (or published-pack metadata)
//
// Post-publish editing is restricted: name, description, cover, genre
// tags can still change, but book membership is frozen (creators
// re-publish via an unpublish → edit → publish cycle if they want to
// change contents). This matches the plan's "contents frozen" rule.
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdatePackDraftInput {
  packId: string;
  name?: string;
  description?: string | null;
  coverImageUrl?: string | null;
  genreTags?: ReadonlyArray<string>;
}

export const updatePackDraftFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): UpdatePackDraftInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("updatePackDraftFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    const packId = String(r.packId ?? "");
    if (packId.length === 0) throw new Error("packId is required");

    const out: UpdatePackDraftInput = { packId };
    if (typeof r.name === "string") {
      const name = r.name.trim();
      if (name.length === 0) throw new Error("Pack name cannot be blank");
      if (name.length > MAX_NAME_LEN) {
        throw new Error(`Pack name must be ≤${MAX_NAME_LEN} characters`);
      }
      out.name = name;
    }
    if ("description" in r) {
      // null explicitly clears it; undefined leaves it alone.
      out.description =
        r.description === null
          ? null
          : trimOptionalString(r.description, MAX_DESCRIPTION_LEN) ?? null;
    }
    if ("coverImageUrl" in r) {
      out.coverImageUrl =
        r.coverImageUrl === null ? null : trimOptionalString(r.coverImageUrl, 2048) ?? null;
    }
    if ("genreTags" in r) {
      out.genreTags = normalizeGenreTags(r.genreTags);
    }
    return out;
  })
  .handler(
    withErrorLogging("updatePackDraftFn", async ({ data }): Promise<{ ok: true }> => {
      const user = await requireSessionUser();
      const database = await getDb();
      await assertPackOwnedBy(database, data.packId, user.id);

      const patch: Record<string, unknown> = {};
      if (data.name !== undefined) patch.name = data.name;
      if ("description" in data) patch.description = data.description;
      if ("coverImageUrl" in data) patch.coverImageUrl = data.coverImageUrl;
      if (data.genreTags !== undefined) patch.genreTags = [...data.genreTags];
      if (Object.keys(patch).length === 0) return { ok: true };

      await database.update(packs).set(patch).where(eq(packs.id, data.packId));
      return { ok: true };
    }),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Membership (add / remove / reorder books)
//
// All three reject when the pack is already published — contents are
// frozen post-publish. The creator can unpublish to edit, which flips
// `is_public` back to false and clears `published_at`.
// ─────────────────────────────────────────────────────────────────────────────

export interface PackMembershipInput {
  packId: string;
  bookId: string;
}

export const addBookToPackDraftFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): PackMembershipInput => coercePackMembershipInput(raw))
  .handler(
    withErrorLogging("addBookToPackDraftFn", async ({ data }): Promise<{ ok: true }> => {
      const user = await requireSessionUser();
      const database = await getDb();
      const pack = await assertPackOwnedBy(database, data.packId, user.id);
      if (pack.isPublic) {
        throw new Error("Pack is published — unpublish before editing contents");
      }

      // Verify the book exists before inserting — the FK would also
      // catch this but the error would be opaque.
      const [book] = await database
        .select({ id: books.id })
        .from(books)
        .where(eq(books.id, data.bookId))
        .limit(1);
      if (!book) throw new Error(`Book ${data.bookId} not found`);

      // Position = current max + 1, so the new book lands at the end of
      // the builder's list. `MAX(position)` per pack is cheap via the
      // composite PK + position column.
      const [{ maxPos }] = await database
        .select({ maxPos: sql<number>`COALESCE(MAX(${packBooks.position}), -1)::int` })
        .from(packBooks)
        .where(eq(packBooks.packId, data.packId));

      await database
        .insert(packBooks)
        .values({ packId: data.packId, bookId: data.bookId, position: maxPos + 1 })
        .onConflictDoNothing({ target: [packBooks.packId, packBooks.bookId] });
      return { ok: true };
    }),
  );

export const removeBookFromPackDraftFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): PackMembershipInput => coercePackMembershipInput(raw))
  .handler(
    withErrorLogging(
      "removeBookFromPackDraftFn",
      async ({ data }): Promise<{ ok: true }> => {
        const user = await requireSessionUser();
        const database = await getDb();
        const pack = await assertPackOwnedBy(database, data.packId, user.id);
        if (pack.isPublic) {
          throw new Error("Pack is published — unpublish before editing contents");
        }
        await database
          .delete(packBooks)
          .where(
            and(eq(packBooks.packId, data.packId), eq(packBooks.bookId, data.bookId)),
          );
        return { ok: true };
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Publish / unpublish
// ─────────────────────────────────────────────────────────────────────────────

export interface PublishPackResult {
  slug: string;
  /** URL path for the newly published pack, ready to push via router. */
  path: string;
}

export const publishPackFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): { packId: string } => {
    if (typeof raw !== "object" || raw === null) throw new Error("publishPackFn expects an object");
    const r = raw as Record<string, unknown>;
    const packId = String(r.packId ?? "");
    if (packId.length === 0) throw new Error("packId is required");
    return { packId };
  })
  .handler(
    withErrorLogging("publishPackFn", async ({ data }): Promise<PublishPackResult> => {
      const user = await requireSessionUser();
      const database = await getDb();

      // 1) Soft unlock: N finished books. Surface a specific error so
      //    the UI can show the meter rather than a generic failure.
      const unlock = await getPublishUnlockStatus(user.id);
      if (!unlock.eligible) {
        throw new Error(
          `PUBLISH_UNLOCK:have=${unlock.finishedBooks} need=${unlock.threshold}`,
        );
      }

      // 2) Ownership.
      const pack = await assertPackOwnedBy(database, data.packId, user.id);
      if (pack.isPublic) return { slug: pack.slug, path: buildUserPackPath(user.username, pack.slug) };

      // 3) Composition: load rarities of member books and run the pure
      //    validator. Even though the builder UI blocks publish while
      //    composition fails, re-checking server-side closes the tamper
      //    gap.
      const rarities = await database
        .select({ rarity: books.rarity })
        .from(packBooks)
        .innerJoin(books, eq(packBooks.bookId, books.id))
        .where(eq(packBooks.packId, data.packId));
      const cfg = await getEconomy();
      const check = checkPackComposition(
        rarities.map((r) => r.rarity as Rarity),
        cfg.packComposition,
      );
      if (!check.ok) {
        const reasons = check.errors.map((e) => e.code).join(",");
        throw new Error(`PUBLISH_COMPOSITION:${reasons}`);
      }

      await database
        .update(packs)
        .set({ isPublic: true, publishedAt: new Date() })
        .where(eq(packs.id, data.packId));

      return { slug: pack.slug, path: buildUserPackPath(user.username, pack.slug) };
    }),
  );

export const unpublishPackFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): { packId: string } => {
    if (typeof raw !== "object" || raw === null) throw new Error("unpublishPackFn expects an object");
    const r = raw as Record<string, unknown>;
    const packId = String(r.packId ?? "");
    if (packId.length === 0) throw new Error("packId is required");
    return { packId };
  })
  .handler(
    withErrorLogging("unpublishPackFn", async ({ data }): Promise<{ ok: true }> => {
      const user = await requireSessionUser();
      const database = await getDb();
      await assertPackOwnedBy(database, data.packId, user.id);
      await database
        .update(packs)
        .set({ isPublic: false, publishedAt: null })
        .where(eq(packs.id, data.packId));
      return { ok: true };
    }),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Reads — owner, public, and builder book search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load a pack the signed-in user owns, including its books. Used by
 * the edit page. Throws if the pack doesn't exist or isn't theirs.
 */
export const getMyPackFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): { packId: string } => {
    if (typeof raw !== "object" || raw === null) throw new Error("getMyPackFn expects an object");
    const r = raw as Record<string, unknown>;
    const packId = String(r.packId ?? "");
    if (packId.length === 0) throw new Error("packId is required");
    return { packId };
  })
  .handler(
    withErrorLogging("getMyPackFn", async ({ data }): Promise<MyPackDetail> => {
      const user = await requireSessionUser();
      const database = await getDb();
      const pack = await assertPackOwnedBy(database, data.packId, user.id);

      const rows = await database
        .select({
          id: books.id,
          title: books.title,
          authors: books.authors,
          coverUrl: books.coverUrl,
          genre: books.genre,
          rarity: books.rarity,
          position: packBooks.position,
        })
        .from(packBooks)
        .innerJoin(books, eq(packBooks.bookId, books.id))
        .where(eq(packBooks.packId, pack.id))
        .orderBy(asc(packBooks.position), asc(books.title));

      return {
        id: pack.id,
        slug: pack.slug,
        name: pack.name,
        description: pack.description,
        coverImageUrl: pack.coverImageUrl,
        genreTags: pack.genreTags,
        isPublic: pack.isPublic,
        publishedAt: pack.publishedAt?.getTime() ?? null,
        createdAt: pack.createdAt.getTime(),
        books: rows.map((r) => ({ ...r, rarity: r.rarity as Rarity })),
      };
    }),
  );

export interface MyPackSummary {
  id: string;
  slug: string;
  name: string;
  isPublic: boolean;
  publishedAt: number | null;
  bookCount: number;
}

/**
 * Every pack the signed-in user has authored — drafts and published
 * alike. Drives the "My Packs" section of their profile and the
 * builder landing page.
 */
export const listMyPacksFn = createServerFn({ method: "GET" }).handler(
  withErrorLogging("listMyPacksFn", async (): Promise<ReadonlyArray<MyPackSummary>> => {
    const user = await requireSessionUser();
    const database = await getDb();
    const rows = await database
      .select({
        id: packs.id,
        slug: packs.slug,
        name: packs.name,
        isPublic: packs.isPublic,
        publishedAt: packs.publishedAt,
        bookCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${packBooks} WHERE ${packBooks.packId} = ${packs.id}
        )`,
      })
      .from(packs)
      .where(eq(packs.creatorId, user.id))
      .orderBy(desc(packs.createdAt));
    return rows.map((r) => ({
      ...r,
      publishedAt: r.publishedAt?.getTime() ?? null,
    }));
  }),
);

/**
 * Publish-unlock probe for the signed-in user. Thin server-fn wrapper
 * around `getPublishUnlockStatus` so the builder's UI can render a
 * finished-books meter without leaking a client-side db/economy
 * dependency. Throws for anonymous callers (consistent with other
 * gated reads); loaders should check `getMeFn` first.
 */
export const getMyPublishUnlockFn = createServerFn({ method: "GET" }).handler(
  withErrorLogging("getMyPublishUnlockFn", async () => {
    const user = await requireSessionUser();
    return getPublishUnlockStatus(user.id);
  }),
);

/**
 * Public pack view — lookup by (username, slug). Works for anonymous
 * callers. Returns only published packs so drafts can't leak via URL
 * guessing. Creators previewing their own draft should use `getMyPackFn`.
 */
export const getPublicPackFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): { username: string; slug: string } => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("getPublicPackFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    const username = String(r.username ?? "").trim();
    const slug = String(r.slug ?? "").trim();
    if (username.length === 0) throw new Error("username is required");
    if (slug.length === 0) throw new Error("slug is required");
    return { username, slug };
  })
  .handler(
    withErrorLogging("getPublicPackFn", async ({ data }): Promise<PublicPackPayload> => {
      const database = await getDb();
      const [row] = await database
        .select({
          pack: {
            id: packs.id,
            slug: packs.slug,
            name: packs.name,
            description: packs.description,
            coverImageUrl: packs.coverImageUrl,
            genreTags: packs.genreTags,
            publishedAt: packs.publishedAt,
          },
          creator: {
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
          },
        })
        .from(packs)
        .innerJoin(users, eq(packs.creatorId, users.id))
        .where(
          and(eq(users.username, data.username), eq(packs.slug, data.slug), eq(packs.isPublic, true)),
        )
        .limit(1);
      if (!row) throw new Error(`Pack @${data.username}/${data.slug} not found`);

      const bookRows = await database
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
        .where(eq(packBooks.packId, row.pack.id))
        .orderBy(asc(packBooks.position), asc(books.title));

      return {
        id: row.pack.id,
        slug: row.pack.slug,
        name: row.pack.name,
        description: row.pack.description,
        coverImageUrl: row.pack.coverImageUrl,
        genreTags: row.pack.genreTags,
        publishedAt: row.pack.publishedAt?.getTime() ?? null,
        creator: row.creator,
        books: bookRows.map((b) => ({ ...b, rarity: b.rarity as Rarity })),
      };
    }),
  );

/**
 * Book search for the builder. Matches against title + author names
 * case-insensitively. Limited to 20 rows — the builder UI paginates
 * by typing, not by scrolling. Open to any signed-in user; anonymous
 * callers have no use for this surface.
 */
export const searchBooksForBuilderFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): { query: string; excludePackId?: string } => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("searchBooksForBuilderFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    const query = String(r.query ?? "").trim();
    if (query.length < 2) {
      throw new Error("Search query must be at least 2 characters");
    }
    const excludePackId =
      typeof r.excludePackId === "string" && r.excludePackId.length > 0
        ? r.excludePackId
        : undefined;
    return { query, excludePackId };
  })
  .handler(
    withErrorLogging(
      "searchBooksForBuilderFn",
      async ({ data }): Promise<
        ReadonlyArray<{
          id: string;
          title: string;
          authors: ReadonlyArray<string>;
          coverUrl: string | null;
          genre: string;
          rarity: Rarity;
        }>
      > => {
        await requireSessionUser();
        const database = await getDb();
        const like = `%${data.query}%`;

        // If we're excluding a pack's current members, fetch those ids
        // first. Kept as a separate query so the main search plan
        // stays simple (ilike + optional NOT IN).
        let excludedIds: string[] = [];
        if (data.excludePackId) {
          const rows = await database
            .select({ id: packBooks.bookId })
            .from(packBooks)
            .where(eq(packBooks.packId, data.excludePackId));
          excludedIds = rows.map((r) => r.id);
        }

        const rows = await database
          .select({
            id: books.id,
            title: books.title,
            authors: books.authors,
            coverUrl: books.coverUrl,
            genre: books.genre,
            rarity: books.rarity,
          })
          .from(books)
          .where(
            and(
              or(
                ilike(books.title, like),
                // Search over the author array via unnest.
                sql`EXISTS (SELECT 1 FROM unnest(${books.authors}) AS a WHERE a ILIKE ${like})`,
              ),
              excludedIds.length > 0
                ? sql`${books.id} NOT IN ${excludedIds}`
                : undefined,
            ),
          )
          .orderBy(asc(books.title))
          .limit(20);

        return rows.map((r) => ({ ...r, rarity: r.rarity as Rarity }));
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Hardcover fallback search + on-demand ingest
//
// The pack builder calls `searchBooksForBuilderFn` first. When that returns
// fewer than LOCAL_SPARSE_THRESHOLD hits, the UI follows up with
// `searchHardcoverForBuilderFn` to surface books not yet in our catalog.
// Picking one of those hits runs `ingestHardcoverBookForBuilderFn`, which
// fetches the full Hardcover record, inserts a `books` row (marked with
// the ingesting user), and links it to the caller's pack draft.
//
// Rate-limiting is two-layered: the Hardcover client enforces a global
// ~54 req/min floor via its FIFO queue, and we enforce a per-user hourly
// cap below to prevent a single account from burning the shared budget.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Below this many local hits the builder UI should also query Hardcover.
 * Kept here (not in economy config) because it's a UX knob, not a game
 * lever; changes don't need to flow through the admin config surface.
 */
export const LOCAL_SPARSE_THRESHOLD = 5;

/**
 * Hourly cap on user-driven ingests. Each successful insert counts; an
 * existing-row upsert (dedup hit) does not. Tuned low to prevent abuse
 * of the shared 60 req/min Hardcover budget without disrupting a creator
 * curating one pack at a time.
 */
const USER_INGEST_HOURLY_CAP = 10;

/**
 * Shape surfaced to the builder UI. `alreadyInCatalogBookId` is populated
 * when our `books` table already has this `hardcover_id` — the UI shows
 * it as "already added, pick from local results" instead of re-ingesting.
 */
export interface BuilderHardcoverHit {
  hardcoverId: number;
  title: string;
  authors: ReadonlyArray<string>;
  coverUrl: string | null;
  releaseYear: number | null;
  /** Populated iff we already ingested this hardcover_id. */
  alreadyInCatalogBookId: string | null;
}

/**
 * Web-search fallback for the pack builder. Only hits Hardcover; the UI
 * is expected to call this in parallel with (or after) the local search
 * when local returns few hits. Any signed-in user can call this — rate
 * limiting is global (Hardcover client queue) plus per-user (see
 * `ingestHardcoverBookForBuilderFn`).
 */
export const searchHardcoverForBuilderFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): { query: string } => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("searchHardcoverForBuilderFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    const query = String(r.query ?? "").trim();
    if (query.length < 2) {
      throw new Error("Search query must be at least 2 characters");
    }
    return { query };
  })
  .handler(
    withErrorLogging(
      "searchHardcoverForBuilderFn",
      async ({ data }): Promise<ReadonlyArray<BuilderHardcoverHit>> => {
        // Signed-in only so anonymous traffic can't drain the rate budget
        // by hammering the search box.
        await requireSessionUser();

        let result: { hits: ReadonlyArray<HardcoverSearchHit> };
        try {
          result = await searchBooks(data.query, { page: 1, perPage: 20 });
        } catch (err) {
          // Surface a cleaner message than the raw HardcoverError so the
          // builder UI can show it without leaking internals.
          throw new Error(
            err instanceof Error
              ? `Hardcover search failed: ${err.message}`
              : "Hardcover search failed",
          );
        }

        if (result.hits.length === 0) return [];

        // Dedup against our catalog in a single round-trip so the UI can
        // tag "already in catalog" hits without needing a second call.
        const database = await getDb();
        const ids = result.hits.map((h) => h.id);
        const existing = await database
          .select({ id: books.id, hardcoverId: books.hardcoverId })
          .from(books)
          .where(inArray(books.hardcoverId, ids));
        const byHardcoverId = new Map<number, string>(
          existing.map((e) => [e.hardcoverId, e.id]),
        );

        return result.hits.map((h) => ({
          hardcoverId: h.id,
          title: h.title ?? "Untitled",
          authors: h.authorNames,
          coverUrl: h.coverUrl,
          releaseYear: h.releaseYear,
          alreadyInCatalogBookId: byHardcoverId.get(h.id) ?? null,
        }));
      },
    ),
  );

export interface IngestHardcoverForBuilderResult {
  bookId: string;
  /** True if we created a new row; false if we linked to an existing one. */
  created: boolean;
}

/**
 * User-initiated ingest from the pack builder. Unlike the admin
 * `ingestBookFn`, this path:
 *
 *   - requires only a signed-in user (no `requireAdmin`);
 *   - defaults curation (`genre = "unknown"`, `moodTags = []`) since we
 *     don't want to ask non-admins to pick a genre at ingest time — an
 *     admin can re-curate later;
 *   - stamps `ingested_by_user_id` + `ingested_at` for provenance and
 *     for the per-user hourly throttle;
 *   - links the resulting book to the caller's pack draft in the same
 *     call, so the UI doesn't need a second round-trip;
 *   - dedups: if the book is already in the catalog (by `hardcover_id`),
 *     we skip the Hardcover fetch entirely and just link to the existing
 *     row. This also means repeated clicks on a hit don't double-ingest.
 */
export const ingestHardcoverBookForBuilderFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): { packId: string; hardcoverId: number } => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("ingestHardcoverBookForBuilderFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    const packId = String(r.packId ?? "");
    if (packId.length === 0) throw new Error("packId is required");
    const hardcoverId = Number(r.hardcoverId);
    if (!Number.isInteger(hardcoverId) || hardcoverId <= 0) {
      throw new Error(`Invalid Hardcover id: ${r.hardcoverId}`);
    }
    return { packId, hardcoverId };
  })
  .handler(
    withErrorLogging(
      "ingestHardcoverBookForBuilderFn",
      async ({ data }): Promise<IngestHardcoverForBuilderResult> => {
        const user = await requireSessionUser();
        const database = await getDb();

        // Ownership check up-front so we never waste a Hardcover call on
        // a URL-guessed pack id.
        const pack = await assertPackOwnedBy(database, data.packId, user.id);
        if (pack.isPublic) {
          // Published packs are content-frozen (see plan). Matches the
          // guard in `addBookToPackDraftFn`.
          throw new Error("Cannot add books to a published pack; unpublish first");
        }

        // Dedup short-circuit: if we already have this hardcover_id, just
        // link it. No Hardcover fetch, no throttle charge — the user
        // picked a hit we could've shown in the local results.
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

        // Throttle: count only this user's ingests (`ingested_by_user_id`
        // is null for admin and legacy rows, so those don't count). The
        // index `books_ingested_by_at_idx` covers this predicate.
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const [{ count: recentCount }] = await database
          .select({ count: sql<number>`count(*)::int` })
          .from(books)
          .where(
            and(
              eq(books.ingestedByUserId, user.id),
              gt(books.ingestedAt, oneHourAgo),
            ),
          );
        if (recentCount >= USER_INGEST_HOURLY_CAP) {
          throw new Error(
            `You've added ${recentCount} books from Hardcover in the last hour. ` +
              `Try again later (limit ${USER_INGEST_HOURLY_CAP}/hour).`,
          );
        }

        // Fetch from Hardcover (rate-limited by the client). Any HTTP or
        // GraphQL error bubbles up wrapped by withErrorLogging.
        const hardcoverBook = await fetchBookById(data.hardcoverId);
        if (!hardcoverBook) {
          throw new Error(
            `Hardcover book ${data.hardcoverId} not found. It may have been ` +
              `removed or the id is wrong.`,
          );
        }

        // `genre = "unknown"` is a deliberate sentinel: admins sweep these
        // during periodic curation. Mood tags stay empty for the same
        // reason. Rarity defaults to `common`; the rebucket script will
        // reassign it based on ratings_count × average_rating.
        const row = bookResponseToRow(hardcoverBook, {
          genre: "unknown",
          moodTags: [],
        });

        // Upsert: race conditions between two users ingesting the same
        // hardcover_id concurrently should not throw a unique-violation.
        // We also set the provenance columns ONLY on insert — a later
        // admin re-ingest (which runs the admin path) shouldn't flip
        // provenance from user to null. `xmax = 0` tells us insert vs
        // update; the UPDATE branch only refreshes editorial fields.
        const [upserted] = await database
          .insert(books)
          .values({
            ...row,
            ingestedByUserId: user.id,
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
              // Intentionally NOT updating: genre, moodTags, rarity,
              // ingestedByUserId, ingestedAt. Curation is the admin's
              // domain; provenance is write-once on first ingest.
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

/**
 * Resolve a username → lightweight profile + their public packs.
 * Drives the `/u/$username` page. Anonymous-friendly.
 */
export interface PublicProfilePayload {
  user: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  packs: ReadonlyArray<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    coverImageUrl: string | null;
    genreTags: ReadonlyArray<string>;
    publishedAt: number | null;
    bookCount: number;
  }>;
}

export const getPublicProfileFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): { username: string } => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("getPublicProfileFn expects an object");
    }
    const r = raw as Record<string, unknown>;
    const username = String(r.username ?? "").trim();
    if (username.length === 0) throw new Error("username is required");
    return { username };
  })
  .handler(
    withErrorLogging(
      "getPublicProfileFn",
      async ({ data }): Promise<PublicProfilePayload> => {
        const database = await getDb();
        const [user] = await database
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
          })
          .from(users)
          .where(eq(users.username, data.username))
          .limit(1);
        if (!user) throw new Error(`User @${data.username} not found`);

        const rows = await database
          .select({
            id: packs.id,
            slug: packs.slug,
            name: packs.name,
            description: packs.description,
            coverImageUrl: packs.coverImageUrl,
            genreTags: packs.genreTags,
            publishedAt: packs.publishedAt,
            bookCount: sql<number>`(
              SELECT COUNT(*)::int FROM ${packBooks} WHERE ${packBooks.packId} = ${packs.id}
            )`,
          })
          .from(packs)
          .where(and(eq(packs.creatorId, user.id), eq(packs.isPublic, true)))
          .orderBy(desc(packs.publishedAt));

        return {
          user,
          packs: rows.map((p) => ({
            ...p,
            publishedAt: p.publishedAt?.getTime() ?? null,
          })),
        };
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function coercePackMembershipInput(raw: unknown): PackMembershipInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Expected { packId, bookId }");
  }
  const r = raw as Record<string, unknown>;
  const packId = String(r.packId ?? "");
  const bookId = String(r.bookId ?? "");
  if (packId.length === 0) throw new Error("packId is required");
  if (bookId.length === 0) throw new Error("bookId is required");
  return { packId, bookId };
}

interface OwnedPackRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  coverImageUrl: string | null;
  genreTags: string[];
  isPublic: boolean;
  publishedAt: Date | null;
  createdAt: Date;
}

/**
 * Load a pack and verify the caller owns it. Throws on 404 OR
 * authorization failure — we deliberately use the same error message
 * to avoid leaking pack-existence to non-owners.
 */
async function assertPackOwnedBy(
  database: Awaited<ReturnType<typeof getDb>>,
  packId: string,
  userId: string,
): Promise<OwnedPackRow> {
  const [pack] = await database
    .select({
      id: packs.id,
      slug: packs.slug,
      name: packs.name,
      description: packs.description,
      coverImageUrl: packs.coverImageUrl,
      genreTags: packs.genreTags,
      isPublic: packs.isPublic,
      publishedAt: packs.publishedAt,
      createdAt: packs.createdAt,
      creatorId: packs.creatorId,
    })
    .from(packs)
    .where(eq(packs.id, packId))
    .limit(1);
  if (!pack || pack.creatorId !== userId) {
    throw new Error(`Pack ${packId} not found`);
  }
  // Strip creator_id before returning — callers only need ownership
  // confirmed, not the raw id.
  const { creatorId: _creatorId, ...rest } = pack;
  void _creatorId;
  return rest;
}

function buildUserPackPath(username: string, slug: string): string {
  return `/u/${username}/${slug}`;
}
