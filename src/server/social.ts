/**
 * Server functions for the social graph.
 *
 * Scope (this PR — first social slice):
 *   • follow / unfollow another user by username
 *   • read follower + following counts and the viewer's follow state
 *     for a given profile
 *
 * Out of scope (deferred to follow-ups):
 *   • follow feed (publishes + legendary pulls from followees)
 *   • user search / Discover-people page
 *
 * Authorization:
 *   • follow / unfollow require auth (the actor is the signed-in user).
 *   • follow-state read is anonymous-friendly: counts are public,
 *     `viewerFollows` collapses to `false` when there's no session.
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
import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { follows, users } from "@/db/schema";
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
// Test surface
//
// Exposed via `_internals` rather than direct export so the file's
// public API stays focused on the server fns. Mirrors the convention
// used in `src/lib/economy/ledger.ts` and `config.ts`.
// ─────────────────────────────────────────────────────────────────────────────

export const _internals = { coerceUsernameInput };
