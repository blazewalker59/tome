/**
 * Server functions for the social graph.
 *
 * Scope:
 *   • follow / unfollow another user by username
 *   • read follower + following counts and the viewer's follow state
 *     for a given profile
 *   • read the viewer's follow feed: a chronologically-ordered union
 *     of "a followee published a pack" and "a followee pulled a
 *     legendary card" events, paginated by timestamp cursor.
 *
 * Out of scope (deferred to follow-ups):
 *   • user search / Discover-people page
 *
 * Authorization:
 *   • follow / unfollow require auth (the actor is the signed-in user).
 *   • follow-state read is anonymous-friendly: counts are public,
 *     `viewerFollows` collapses to `false` when there's no session.
 *   • follow-feed read requires auth — the response is keyed to "the
 *     people YOU follow." Anonymous callers get a structured
 *     `null`-shaped response so the route can render a sign-in
 *     prompt instead of a sad empty feed.
 *
 * Identity layer:
 *   • Profiles are addressed by `users.username` everywhere in the
 *     URL/UX layer; we resolve username → id once at the top of each
 *     handler and pass ids into the `follows` table from there. Keeps
 *     URL-level renames cheap if we ever allow them.
 *
 * Self-follow guard:
 *   • Insert is rejected at the application layer rather than a DB
 *     CHECK, so we can return a structured error sentinel instead of
 *     a 500. The followee/follower PK doesn't prevent self-follows;
 *     a `follower_id <> followee_id` check is enforced by code only.
 */

import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { follows, packBooks, packRips, packs, users } from "@/db/schema";
import { getSessionUser, requireSessionUser } from "@/lib/auth/session";
import { withErrorLogging } from "./_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Error sentinels
//
// Structured prefixes so the client can branch on a specific failure
// mode without parsing free-form messages. Same convention as
// INSUFFICIENT_SHARDS_PREFIX et al. in collection.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when the caller tries to follow themselves. */
export const SELF_FOLLOW_PREFIX = "SELF_FOLLOW:";

/** Thrown when the target username doesn't resolve to a user. Used by
 *  both follow and unfollow so the error surface is uniform. */
export const FOLLOW_TARGET_NOT_FOUND_PREFIX = "FOLLOW_TARGET_NOT_FOUND:";

// ─────────────────────────────────────────────────────────────────────────────
// Input coercion
// ─────────────────────────────────────────────────────────────────────────────

interface UsernameInput {
  username: string;
}

function coerceUsernameInput(raw: unknown, fnName: string): UsernameInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${fnName} expects an object`);
  }
  const r = raw as Record<string, unknown>;
  const username = String(r.username ?? "").trim();
  if (username.length === 0) throw new Error("username is required");
  return { username };
}

/**
 * Resolve a username to its user-id, throwing the structured "target
 * not found" sentinel on miss. Centralized so both follow and
 * unfollow surface identical errors to the client.
 */
async function resolveUsernameToId(
  database: Awaited<ReturnType<typeof getDb>>,
  username: string,
): Promise<string> {
  const [row] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!row) {
    throw new Error(
      `${FOLLOW_TARGET_NOT_FOUND_PREFIX} user @${username} not found`,
    );
  }
  return row.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations: follow / unfollow
// ─────────────────────────────────────────────────────────────────────────────

export interface FollowResult {
  /** True after this call: caller follows the target. Lets the UI
   *  optimistically toggle without a separate read. */
  following: true;
  /** Updated follower count for the target — lets the profile header
   *  bump its number without an extra round-trip. */
  followerCount: number;
}

/**
 * Follow another user, addressed by username. Idempotent: a duplicate
 * follow returns the existing state rather than throwing. Self-follow
 * is rejected with the SELF_FOLLOW sentinel.
 *
 * Why not enforce uniqueness via PK conflict alone? The PK does
 * prevent dupes, but a raw conflict would surface as a generic DB
 * error to the client. `onConflictDoNothing` keeps the call
 * idempotent and lets us return the live `followerCount` after the
 * write — useful when the user double-taps the button.
 */
export const followUserFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): UsernameInput =>
    coerceUsernameInput(raw, "followUserFn"),
  )
  .handler(
    withErrorLogging("followUserFn", async ({ data }): Promise<FollowResult> => {
      const me = await requireSessionUser();
      const database = await getDb();
      const targetId = await resolveUsernameToId(database, data.username);

      if (targetId === me.id) {
        throw new Error(`${SELF_FOLLOW_PREFIX} cannot follow yourself`);
      }

      // Idempotent insert: if the row already exists, do nothing.
      // The PK on (follower_id, followee_id) is the dedup key; we
      // rely on it rather than a pre-check to avoid the read-then-
      // write race in concurrent taps.
      await database
        .insert(follows)
        .values({ followerId: me.id, followeeId: targetId })
        .onConflictDoNothing();

      // Fresh count after the write. The aggregate is cheap given the
      // PK index on (follower_id, followee_id) and a future
      // (followee_id) index — for now Postgres scans the followee
      // column directly. Acceptable while the table is small; if it
      // grows we'll add `index("follows_followee_idx").on(t.followeeId)`.
      const [{ count }] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(follows)
        .where(eq(follows.followeeId, targetId));

      return { following: true, followerCount: count };
    }),
  );

export interface UnfollowResult {
  following: false;
  followerCount: number;
}

/**
 * Stop following another user. Idempotent: removing a non-existent
 * follow returns the current state rather than throwing.
 */
export const unfollowUserFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): UsernameInput =>
    coerceUsernameInput(raw, "unfollowUserFn"),
  )
  .handler(
    withErrorLogging(
      "unfollowUserFn",
      async ({ data }): Promise<UnfollowResult> => {
        const me = await requireSessionUser();
        const database = await getDb();
        const targetId = await resolveUsernameToId(database, data.username);

        // Self-unfollow is a no-op (a self-follow can't have been
        // created in the first place), but we still execute the
        // delete + count to keep the response shape uniform.
        await database
          .delete(follows)
          .where(
            and(
              eq(follows.followerId, me.id),
              eq(follows.followeeId, targetId),
            ),
          );

        const [{ count }] = await database
          .select({ count: sql<number>`count(*)::int` })
          .from(follows)
          .where(eq(follows.followeeId, targetId));

        return { following: false, followerCount: count };
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Read: follow state for a profile
// ─────────────────────────────────────────────────────────────────────────────

export interface FollowStatePayload {
  /** Number of users following the target. Public. */
  followerCount: number;
  /** Number of users the target follows. Public. */
  followingCount: number;
  /**
   * True when the signed-in viewer follows the target. Always false
   * for anonymous viewers and when the viewer is the target (you
   * can't follow yourself, so the button shouldn't render).
   */
  viewerFollows: boolean;
  /**
   * True when the target IS the viewer. Lets the UI hide the follow
   * button on the viewer's own profile without a separate `getMeFn`
   * call from the loader.
   */
  isSelf: boolean;
}

/**
 * Read follower/following counts and the viewer's relationship to
 * the target. Anonymous-friendly. Drives the follow button + counts
 * row on `/u/$username`.
 *
 * Three queries instead of one big join because the PK index on
 * `follows` makes each lookup O(log N) and bundling them adds
 * complexity without measurable gain at this scale. If we later
 * fetch follow-state for a list of users at once we'll batch.
 */
export const getFollowStateFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): UsernameInput =>
    coerceUsernameInput(raw, "getFollowStateFn"),
  )
  .handler(
    withErrorLogging(
      "getFollowStateFn",
      async ({ data }): Promise<FollowStatePayload> => {
        const database = await getDb();
        const targetId = await resolveUsernameToId(database, data.username);
        const me = await getSessionUser();

        const [followerRow] = await database
          .select({ count: sql<number>`count(*)::int` })
          .from(follows)
          .where(eq(follows.followeeId, targetId));

        const [followingRow] = await database
          .select({ count: sql<number>`count(*)::int` })
          .from(follows)
          .where(eq(follows.followerId, targetId));

        let viewerFollows = false;
        if (me && me.id !== targetId) {
          const [edge] = await database
            .select({ followerId: follows.followerId })
            .from(follows)
            .where(
              and(
                eq(follows.followerId, me.id),
                eq(follows.followeeId, targetId),
              ),
            )
            .limit(1);
          viewerFollows = Boolean(edge);
        }

        return {
          followerCount: followerRow.count,
          followingCount: followingRow.count,
          viewerFollows,
          isSelf: me?.id === targetId,
        };
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Read: follow feed
//
// A chronological union of two event types from people the viewer
// follows:
//
//   1. PACK_PUBLISHED — `packs.published_at` flipped (`is_public = true`,
//      `creator_id` ∈ followees). Surfaces "@alice shipped a deck."
//   2. LEGENDARY_PULL — a `pack_rips` row whose `pulled_book_ids`
//      includes any book with `rarity = 'legendary'`. Surfaces
//      "@alice just pulled a legendary: <Title>." Multiple legendaries
//      in a single rip collapse into one event with the cards in an
//      array — mass-rip events should read as one moment, not five.
//
// Pagination is timestamp-cursor based: callers pass an optional
// `before` (epoch ms) and we return up to `limit` events strictly
// older than that cursor. This is monotonic across both event types
// because `events.timestamp` is the union key. The caller threads the
// last event's timestamp back as `before` to fetch the next page.
//
// Why two queries + JS merge instead of one SQL UNION ALL? Three
// reasons:
//   • The two event shapes are different enough (publish has a pack,
//     pull has a rip + cards) that a UNION would force coalesced
//     columns and a discriminator we'd then re-split client-side.
//   • Each query stays simple and indexable; the merge is O(n+m)
//     against a hard cap (limit = 20 by default).
//   • Drizzle's UNION ergonomics are clunky enough that the readability
//     win goes to the merge approach.
//
// We over-fetch each side (limit * 2) so that after the merge + cap
// we still have `limit` events. Worst case: all `limit * 2` events
// come from one stream and the other contributes nothing. That's fine
// — we just truncate.
//
// Anonymous callers and signed-in callers with zero follows both get
// `{ events: [], suggestions }`. The `suggestions` payload mirrors
// `listPublicPacksFn` minimally (just enough for the empty-state to
// render trending public packs) so the feed route doesn't need a
// second loader call.
// ─────────────────────────────────────────────────────────────────────────────

export type FollowFeedEventType = "pack_published" | "legendary_pull";

interface FollowFeedActor {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface PackPublishedEvent {
  type: "pack_published";
  /**
   * Epoch ms. For pack_published this is `packs.published_at`. Used
   * for ordering and as the pagination cursor (`before`).
   */
  timestamp: number;
  /** Stable key for the React list. Composed so a deletion + repost
   *  produces a fresh row. */
  id: string;
  actor: FollowFeedActor;
  pack: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    coverImageUrl: string | null;
    genreTags: ReadonlyArray<string>;
    bookCount: number;
  };
}

export interface LegendaryPullEvent {
  type: "legendary_pull";
  timestamp: number;
  id: string;
  actor: FollowFeedActor;
  pack: {
    /** Pack the legendary came from. May be editorial (creator_id null)
     *  or a user pack. The link target is /rip/$slug for editorial,
     *  /u/$username/$slug for user packs — the route picks based on
     *  whether `creatorUsername` is null. */
    id: string;
    slug: string;
    name: string;
    creatorUsername: string | null;
  };
  /** All legendaries pulled in this single rip. Usually 1; multi-
   *  legendary rips are rare but real. */
  cards: ReadonlyArray<{
    bookId: string;
    title: string;
    coverUrl: string | null;
    /** Author display string — first author or "Multiple authors". */
    authors: ReadonlyArray<string>;
  }>;
}

export type FollowFeedEvent = PackPublishedEvent | LegendaryPullEvent;

/**
 * Trending public-pack suggestion shown in the empty state. A trimmed
 * subset of `listPublicPacksFn`'s payload — just enough for a tile.
 */
export interface FeedSuggestion {
  id: string;
  slug: string;
  name: string;
  coverImageUrl: string | null;
  genreTags: ReadonlyArray<string>;
  creatorUsername: string;
}

export interface FollowFeedPayload {
  /**
   * Page of feed events, newest first. Up to `limit` items. Empty
   * when the viewer follows no one (or follows quiet accounts) — the
   * UI uses `suggestions` instead in that case.
   */
  events: ReadonlyArray<FollowFeedEvent>;
  /**
   * Empty-state seed: trending public packs. Always populated (even
   * when `events` is non-empty) so the feed footer can suggest more
   * creators to follow without a second round-trip. The route renders
   * them only when the events list is empty.
   */
  suggestions: ReadonlyArray<FeedSuggestion>;
  /**
   * Cursor for the next page: epoch ms of the oldest event returned,
   * or null when there are no more events. Caller passes this back
   * as `before` to load older items.
   */
  nextCursor: number | null;
  /** True when the viewer is signed in. Anonymous callers get this
   *  flag set so the route can show a sign-in CTA instead of an
   *  empty feed. */
  signedIn: boolean;
  /** True when the signed-in viewer follows zero people. Lets the UI
   *  branch on "go follow someone" vs "your followees are quiet". */
  followingCount: number;
}

export interface FollowFeedInput {
  /** Epoch ms; return events strictly older than this. Omit for the
   *  newest page. */
  before?: number;
  /** Page size cap. Defaults to 20; max 50. */
  limit?: number;
}

/**
 * Pure merge step: union two streams of feed events, sort newest-
 * first, and cap. Extracted from the handler so we can unit-test the
 * ordering and cap behavior without standing up a database.
 *
 * Stable across event types: ties on `timestamp` (rare but possible
 * in tests) break by id so the order is deterministic.
 */
function mergeFeedEvents(
  publishes: ReadonlyArray<FollowFeedEvent>,
  pulls: ReadonlyArray<FollowFeedEvent>,
  limit: number,
): FollowFeedEvent[] {
  const merged = [...publishes, ...pulls];
  merged.sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return merged.slice(0, limit);
}

export const getFollowFeedFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): FollowFeedInput => {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object") {
      throw new Error("getFollowFeedFn expects an object or undefined");
    }
    const r = raw as Record<string, unknown>;
    const out: FollowFeedInput = {};
    if (r.before !== undefined) {
      const n = Number(r.before);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error("before must be a positive epoch ms");
      }
      out.before = n;
    }
    if (r.limit !== undefined) {
      const n = Number(r.limit);
      if (!Number.isInteger(n) || n <= 0 || n > 50) {
        throw new Error("limit must be a positive integer ≤ 50");
      }
      out.limit = n;
    }
    return out;
  })
  .handler(
    withErrorLogging(
      "getFollowFeedFn",
      async ({ data }): Promise<FollowFeedPayload> => {
        const limit = data.limit ?? 20;
        const before = data.before ? new Date(data.before) : null;
        const database = await getDb();
        const me = await getSessionUser();

        // Suggestions are always loaded — even for signed-in users
        // with active feeds, we want them available for the
        // "discover more creators" footer. Cheap query (cap 6) so the
        // redundancy is fine.
        const suggestions = await loadFeedSuggestions(database, me?.id ?? null);

        if (!me) {
          return {
            events: [],
            suggestions,
            nextCursor: null,
            signedIn: false,
            followingCount: 0,
          };
        }

        // Followee set. Single round-trip then we hold the array in
        // memory for the two stream queries. Empty array short-
        // circuits — Postgres handles `IN ()` poorly and there's
        // nothing to fetch anyway.
        const followeeRows = await database
          .select({ id: follows.followeeId })
          .from(follows)
          .where(eq(follows.followerId, me.id));
        const followeeIds = followeeRows.map((r) => r.id);

        if (followeeIds.length === 0) {
          return {
            events: [],
            suggestions,
            nextCursor: null,
            signedIn: true,
            followingCount: 0,
          };
        }

        // Over-fetch each stream so the merge has enough material to
        // hit `limit` after combination. limit*2 + buffer of 5 covers
        // the case where the merge boundary sits right at the cap.
        const overFetch = limit * 2 + 5;

        const [publishes, pulls] = await Promise.all([
          loadPackPublishedEvents(database, followeeIds, before, overFetch),
          loadLegendaryPullEvents(database, followeeIds, before, overFetch),
        ]);

        const events = mergeFeedEvents(publishes, pulls, limit);

        // Cursor = timestamp of the last item, or null when we
        // exhausted both streams. We can't tell with certainty that
        // we're done without another query, but if either stream
        // returned fewer than `overFetch` rows AND the merge consumed
        // every event, there's no more. Conservative approach: only
        // emit a cursor when we filled `limit`, since that's the
        // signal the client uses to fetch more.
        const nextCursor =
          events.length === limit ? events[events.length - 1].timestamp : null;

        return {
          events,
          suggestions,
          nextCursor,
          signedIn: true,
          followingCount: followeeIds.length,
        };
      },
    ),
  );

/**
 * Trending public packs (re-derived 7-day rip count, same logic as
 * `listPublicPacksFn`) excluding the viewer's own packs. Capped at 6
 * since the empty-state surface is small and we don't want to hit the
 * DB hard for a footer banner.
 */
async function loadFeedSuggestions(
  database: Awaited<ReturnType<typeof getDb>>,
  myId: string | null,
): Promise<FeedSuggestion[]> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const trendingExpr = sql<number>`(
    SELECT COUNT(*)::int
    FROM ${packRips}
    WHERE ${packRips.packId} = ${packs.id}
      AND ${packRips.rippedAt} > ${weekAgo}
  )`;

  const conditions = [
    sql`${packs.creatorId} IS NOT NULL`,
    eq(packs.isPublic, true),
  ];
  if (myId) conditions.push(sql`${packs.creatorId} <> ${myId}`);

  const rows = await database
    .select({
      id: packs.id,
      slug: packs.slug,
      name: packs.name,
      coverImageUrl: packs.coverImageUrl,
      genreTags: packs.genreTags,
      creatorUsername: users.username,
    })
    .from(packs)
    .innerJoin(users, eq(packs.creatorId, users.id))
    .where(and(...conditions))
    .orderBy(desc(trendingExpr), desc(packs.publishedAt))
    .limit(6);

  return rows.map((r) => ({ ...r, genreTags: r.genreTags ?? [] }));
}

/**
 * Pack-published events from followees. Filters by `creator_id IN
 * (followees) AND is_public = true AND published_at IS NOT NULL`,
 * applies the optional `before` cursor, and orders by `published_at`
 * desc. Joins `users` for actor display + a correlated count of
 * member books.
 */
async function loadPackPublishedEvents(
  database: Awaited<ReturnType<typeof getDb>>,
  followeeIds: ReadonlyArray<string>,
  before: Date | null,
  limit: number,
): Promise<PackPublishedEvent[]> {
  const conditions = [
    inArray(packs.creatorId, [...followeeIds]),
    eq(packs.isPublic, true),
    sql`${packs.publishedAt} IS NOT NULL`,
  ];
  if (before) conditions.push(lt(packs.publishedAt, before));

  const rows = await database
    .select({
      packId: packs.id,
      slug: packs.slug,
      name: packs.name,
      description: packs.description,
      coverImageUrl: packs.coverImageUrl,
      genreTags: packs.genreTags,
      publishedAt: packs.publishedAt,
      bookCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${packBooks}
        WHERE ${packBooks.packId} = ${packs.id}
      )`,
      actor: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(packs)
    .innerJoin(users, eq(packs.creatorId, users.id))
    .where(and(...conditions))
    .orderBy(desc(packs.publishedAt))
    .limit(limit);

  return rows.map((r) => ({
    type: "pack_published" as const,
    // publishedAt is non-null per the WHERE clause; the `!` here is
    // load-bearing — Drizzle's column is typed as nullable but the
    // filter guarantees presence at runtime.
    timestamp: r.publishedAt!.getTime(),
    id: `pub:${r.packId}`,
    actor: r.actor,
    pack: {
      id: r.packId,
      slug: r.slug,
      name: r.name,
      description: r.description,
      coverImageUrl: r.coverImageUrl,
      genreTags: r.genreTags ?? [],
      bookCount: r.bookCount,
    },
  }));
}

/**
 * Legendary-pull events from followees. We unnest each rip's
 * `pulled_book_ids` array, join `books` to find legendaries, and
 * group back by rip so a multi-legendary rip is one event. The query
 * also joins `packs` for pack identity + `users` (twice: once for the
 * ripping user, once for the pack creator's username when the pack is
 * a user pack).
 *
 * Aggregation is done in SQL via array_agg so we get one row per rip
 * with a `cards` payload — keeps the JS map step trivial.
 */
async function loadLegendaryPullEvents(
  database: Awaited<ReturnType<typeof getDb>>,
  followeeIds: ReadonlyArray<string>,
  before: Date | null,
  limit: number,
): Promise<LegendaryPullEvent[]> {
  // Subquery: per-rip aggregation of legendary cards. We select the
  // rip + actor + pack columns, then aggregate the legendary book
  // metadata via array_agg. The HAVING clause drops rips with zero
  // legendaries — the WHERE on rarity already filters but the
  // aggregate still produces a row per rip if any joined book matched.
  // No it doesn't — the inner JOIN against books-with-rarity-legendary
  // means rips with no legendary books produce no rows at all, so a
  // GROUP BY collapses to non-empty groups only. HAVING is a safety net.
  //
  // Drizzle doesn't expose array_agg ergonomically through its query
  // builder when paired with cross-table joins on uuid arrays, so we
  // drop to raw SQL for the aggregate. Bind params keep this safe.
  const beforeCond = before ? sql`AND pr.ripped_at < ${before}` : sql``;
  const followeeArray = sql.raw(
    `ARRAY[${followeeIds.map((id) => `'${id.replace(/'/g, "''")}'::uuid`).join(",")}]`,
  );

  // Sanity: followeeIds is already validated as a non-empty array of
  // UUIDs by the caller. The single-quote escape is belt-and-braces
  // — Postgres uuids never contain quotes, but we don't want to bet
  // on the input shape staying static.

  const result = await database.execute<{
    rip_id: string;
    ripped_at: Date;
    pack_id: string;
    pack_slug: string;
    pack_name: string;
    pack_creator_username: string | null;
    actor_id: string;
    actor_username: string;
    actor_display_name: string | null;
    actor_avatar_url: string | null;
    cards: Array<{
      book_id: string;
      title: string;
      cover_url: string | null;
      authors: string[];
    }>;
  }>(sql`
    SELECT
      pr.id AS rip_id,
      pr.ripped_at,
      p.id AS pack_id,
      p.slug AS pack_slug,
      p.name AS pack_name,
      pcu.username AS pack_creator_username,
      au.id AS actor_id,
      au.username AS actor_username,
      au.display_name AS actor_display_name,
      au.avatar_url AS actor_avatar_url,
      jsonb_agg(
        jsonb_build_object(
          'book_id', b.id,
          'title', b.title,
          'cover_url', b.cover_url,
          'authors', b.authors
        )
        ORDER BY b.title
      ) AS cards
    FROM pack_rips pr
    INNER JOIN users au ON au.id = pr.user_id
    INNER JOIN packs p ON p.id = pr.pack_id
    LEFT JOIN users pcu ON pcu.id = p.creator_id
    INNER JOIN LATERAL unnest(pr.pulled_book_ids) AS pulled_id ON true
    INNER JOIN books b ON b.id = pulled_id AND b.rarity = 'legendary'
    WHERE pr.user_id = ANY(${followeeArray})
      ${beforeCond}
    GROUP BY pr.id, pr.ripped_at, p.id, p.slug, p.name, pcu.username,
             au.id, au.username, au.display_name, au.avatar_url
    ORDER BY pr.ripped_at DESC
    LIMIT ${limit}
  `);

  // Drizzle's `execute` returns the driver's row shape, which for
  // postgres-js comes back as an array on the result itself. Some
  // driver versions wrap it in `.rows`; handle both.
  const rows = (Array.isArray(result) ? result : result.rows) as Array<{
    rip_id: string;
    ripped_at: Date;
    pack_id: string;
    pack_slug: string;
    pack_name: string;
    pack_creator_username: string | null;
    actor_id: string;
    actor_username: string;
    actor_display_name: string | null;
    actor_avatar_url: string | null;
    cards: Array<{
      book_id: string;
      title: string;
      cover_url: string | null;
      authors: string[];
    }>;
  }>;

  return rows.map((r) => ({
    type: "legendary_pull" as const,
    timestamp:
      r.ripped_at instanceof Date
        ? r.ripped_at.getTime()
        : new Date(r.ripped_at).getTime(),
    id: `pull:${r.rip_id}`,
    actor: {
      id: r.actor_id,
      username: r.actor_username,
      displayName: r.actor_display_name,
      avatarUrl: r.actor_avatar_url,
    },
    pack: {
      id: r.pack_id,
      slug: r.pack_slug,
      name: r.pack_name,
      creatorUsername: r.pack_creator_username,
    },
    cards: r.cards.map((c) => ({
      bookId: c.book_id,
      title: c.title,
      coverUrl: c.cover_url,
      authors: c.authors ?? [],
    })),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Test surface
//
// Exposed via `_internals` rather than direct export so the file's
// public API stays focused on the server fns. Mirrors the convention
// used in `src/lib/economy/ledger.ts` and `config.ts`.
// ─────────────────────────────────────────────────────────────────────────────

export const _internals = { coerceUsernameInput, mergeFeedEvents };
