import { describe, expect, it } from "vitest";

import {
  normalizeKebab,
  normalizeMoodTags,
  requireUuid,
} from "@/server/catalog";

/**
 * Tests for the pure input validators used by the admin catalog server
 * functions. The handlers themselves go through `requireAdmin()` → Drizzle,
 * both of which are already covered elsewhere (see
 * `src/__tests__/lib/auth/session.test.ts`). What's worth isolating here
 * is the format-coercion logic, because it's reused across pack slugs,
 * genres, and mood tags — a bug there silently corrupts catalog data.
 */

describe("normalizeKebab", () => {
  it("trims + lowercases valid kebab-case", () => {
    expect(normalizeKebab("  Literary-Fiction  ", "Genre")).toBe(
      "literary-fiction",
    );
  });

  it("accepts all-digits segments", () => {
    expect(normalizeKebab("booker-2024", "Slug")).toBe("booker-2024");
  });

  it("rejects leading hyphen (must start with alnum)", () => {
    expect(() => normalizeKebab("-foo", "Genre")).toThrow(/kebab-case/);
  });

  it("rejects spaces", () => {
    expect(() => normalizeKebab("literary fiction", "Genre")).toThrow(
      /kebab-case/,
    );
  });

  it("rejects underscores", () => {
    expect(() => normalizeKebab("literary_fiction", "Genre")).toThrow(
      /kebab-case/,
    );
  });

  it("rejects empty strings", () => {
    expect(() => normalizeKebab("   ", "Slug")).toThrow(/kebab-case/);
  });

  it("mentions the label in the error", () => {
    expect(() => normalizeKebab("BAD VAL", "Slug")).toThrow(/Slug/);
  });
});

describe("normalizeMoodTags", () => {
  it("trims, lowercases, and filters empty entries", () => {
    expect(normalizeMoodTags(["  Atmospheric ", "", "Slow-Burn"])).toEqual([
      "atmospheric",
      "slow-burn",
    ]);
  });

  it("deduplicates repeated tags (preserves first occurrence)", () => {
    expect(normalizeMoodTags(["cozy", "cozy", "mysterious"])).toEqual([
      "cozy",
      "mysterious",
    ]);
  });

  it("rejects non-kebab tags", () => {
    expect(() => normalizeMoodTags(["slow burn"])).toThrow(/kebab-case/);
  });

  it("rejects more than three tags", () => {
    expect(() => normalizeMoodTags(["a", "b", "c", "d"])).toThrow(
      /At most 3/,
    );
  });

  it("coerces non-string entries via String()", () => {
    // An empty/numeric array entry shouldn't crash the validator; it
    // either coerces cleanly or is rejected as non-kebab.
    expect(normalizeMoodTags([null, undefined, ""])).toEqual([]);
  });
});

describe("requireUuid", () => {
  it("accepts a well-formed uuid", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(requireUuid(id, "bookId")).toBe(id);
  });

  it("rejects non-strings", () => {
    expect(() => requireUuid(123, "bookId")).toThrow(/bookId/);
    expect(() => requireUuid(null, "bookId")).toThrow(/bookId/);
  });

  it("rejects empty strings", () => {
    expect(() => requireUuid("", "bookId")).toThrow(/bookId/);
  });

  it("rejects strings with disallowed characters", () => {
    expect(() => requireUuid("not a uuid!", "bookId")).toThrow(
      /not a valid id/,
    );
  });
});
