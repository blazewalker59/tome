import { describe, expect, it } from "vitest";

import {
  FOLLOW_TARGET_NOT_FOUND_PREFIX,
  SELF_FOLLOW_PREFIX,
  _internals,
} from "@/server/social";

/**
 * Pure-helper tests for `src/server/social.ts`. The handlers
 * themselves are exercised end-to-end via the route, but the input
 * validator is a static function we can lock down without a DB. A
 * regression here would silently let malformed payloads through to
 * the resolver step.
 *
 * The structured error sentinels are also asserted as constants —
 * the client branches on these prefixes, so renaming one without
 * updating consumers would break the follow-button UX. Pinning them
 * here makes a rename impossible to land silently.
 */

const { coerceUsernameInput } = _internals;

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
