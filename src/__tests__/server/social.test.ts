import { describe, expect, it } from "vitest";

import {
  FOLLOW_TARGET_NOT_FOUND_PREFIX,
  SELF_FOLLOW_PREFIX,
  _internals,
  type FollowFeedEvent,
} from "@/server/social";

/**
 * Pure-helper tests for `src/server/social.ts`. The handlers
 * themselves are exercised end-to-end via the route, but the input
 * validator and the feed merge are static functions we can lock down
 * without a DB. A regression in either silently breaks user-facing
 * behavior that's hard to spot without integration coverage.
 *
 * The structured error sentinels are also asserted as constants —
 * the client branches on these prefixes, so renaming one without
 * updating consumers would break the follow-button UX. Pinning them
 * here makes a rename impossible to land silently.
 */

const { coerceUsernameInput, mergeFeedEvents } = _internals;

describe("coerceUsernameInput", () => {
  it("returns trimmed username", () => {
    expect(coerceUsernameInput({ username: "  alice  " }, "fn")).toEqual({
      username: "alice",
    });
  });

  it("preserves valid usernames as-is", () => {
    expect(coerceUsernameInput({ username: "bob_42" }, "fn")).toEqual({
      username: "bob_42",
    });
  });

  it("coerces non-string username via String()", () => {
    // Belt-and-braces: the route param is always a string, but
    // server fns can be hit by anything. A numeric username should
    // surface as a string, not a TypeError.
    expect(coerceUsernameInput({ username: 42 }, "fn")).toEqual({
      username: "42",
    });
  });

  it("rejects empty username", () => {
    expect(() => coerceUsernameInput({ username: "" }, "fn")).toThrow(
      /username is required/,
    );
  });

  it("rejects whitespace-only username", () => {
    expect(() => coerceUsernameInput({ username: "   " }, "fn")).toThrow(
      /username is required/,
    );
  });

  it("rejects missing username key", () => {
    expect(() => coerceUsernameInput({}, "fn")).toThrow(/username is required/);
  });

  it("rejects non-object input with the named fn for context", () => {
    expect(() => coerceUsernameInput(null, "followUserFn")).toThrow(
      /followUserFn expects an object/,
    );
    expect(() => coerceUsernameInput("alice", "getFollowStateFn")).toThrow(
      /getFollowStateFn expects an object/,
    );
  });
});

describe("error sentinels", () => {
  it("SELF_FOLLOW_PREFIX is stable", () => {
    // Pinned because the client checks for this exact prefix.
    expect(SELF_FOLLOW_PREFIX).toBe("SELF_FOLLOW:");
  });

  it("FOLLOW_TARGET_NOT_FOUND_PREFIX is stable", () => {
    expect(FOLLOW_TARGET_NOT_FOUND_PREFIX).toBe("FOLLOW_TARGET_NOT_FOUND:");
  });
});

describe("mergeFeedEvents", () => {
  // Minimal event factories. Real events carry actor + pack payloads
  // but the merge logic only inspects timestamp + id, so we can stub
  // those without affecting the test outcome.
  const makePub = (id: string, ts: number): FollowFeedEvent => ({
    type: "pack_published",
    id: `pub:${id}`,
    timestamp: ts,
    actor: { id, username: id, displayName: null, avatarUrl: null },
    pack: {
      id,
      slug: id,
      name: id,
      description: null,
      coverImageUrl: null,
      genreTags: [],
      bookCount: 0,
    },
  });
  const makePull = (id: string, ts: number): FollowFeedEvent => ({
    type: "legendary_pull",
    id: `pull:${id}`,
    timestamp: ts,
    actor: { id, username: id, displayName: null, avatarUrl: null },
    pack: { id, slug: id, name: id, creatorUsername: id },
    cards: [],
  });

  it("interleaves two streams by timestamp, newest first", () => {
    const publishes = [makePub("a", 300), makePub("b", 100)];
    const pulls = [makePull("c", 200), makePull("d", 50)];
    const merged = mergeFeedEvents(publishes, pulls, 10);
    expect(merged.map((e) => e.timestamp)).toEqual([300, 200, 100, 50]);
  });

  it("caps at limit and drops the oldest tail", () => {
    const publishes = [makePub("a", 500), makePub("b", 300)];
    const pulls = [makePull("c", 400), makePull("d", 200), makePull("e", 100)];
    const merged = mergeFeedEvents(publishes, pulls, 3);
    expect(merged.map((e) => e.timestamp)).toEqual([500, 400, 300]);
  });

  it("handles empty streams without throwing", () => {
    expect(mergeFeedEvents([], [], 10)).toEqual([]);
    expect(mergeFeedEvents([makePub("a", 1)], [], 10)).toHaveLength(1);
    expect(mergeFeedEvents([], [makePull("b", 1)], 10)).toHaveLength(1);
  });

  it("breaks timestamp ties deterministically by id", () => {
    // Same timestamp on both events. Without a tiebreaker, the relative
    // order would depend on Array.sort stability across engines —
    // we lock it to id-asc so paginated rendering doesn't shuffle
    // when a tie sits on the page boundary.
    const a = makePub("aaa", 100);
    const b = makePull("zzz", 100);
    const merged1 = mergeFeedEvents([a], [b], 10);
    const merged2 = mergeFeedEvents([b], [a], 10);
    expect(merged1.map((e) => e.id)).toEqual(merged2.map((e) => e.id));
    expect(merged1[0].id < merged1[1].id).toBe(true);
  });

  it("limit=0 returns empty without iterating", () => {
    const publishes = [makePub("a", 100)];
    const pulls = [makePull("b", 50)];
    expect(mergeFeedEvents(publishes, pulls, 0)).toEqual([]);
  });
});
