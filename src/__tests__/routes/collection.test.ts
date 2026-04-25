import { describe, expect, it } from "vitest";
import { parseCollectionSearch } from "@/routes/library.collection";

describe("parseCollectionSearch", () => {
  it("returns an empty object when nothing is provided", () => {
    expect(parseCollectionSearch({})).toEqual({});
  });

  it("accepts every known view", () => {
    for (const view of ["all", "pack", "author", "rarity", "genre"] as const) {
      expect(parseCollectionSearch({ view })).toEqual({ view });
    }
  });

  it("accepts every known sort mode", () => {
    for (const sort of ["newest", "rarity", "title", "author"] as const) {
      expect(parseCollectionSearch({ sort })).toEqual({ sort });
    }
  });

  it("ignores unknown view / sort values instead of throwing", () => {
    // Forgiving parsing is deliberate — stale shared links should
    // degrade to defaults, not route errors.
    expect(parseCollectionSearch({ view: "nope" })).toEqual({});
    expect(parseCollectionSearch({ sort: "popularity" })).toEqual({});
  });

  it("ignores non-string param types", () => {
    // Query params can technically arrive as arrays (?view=a&view=b)
    // or other junk from malicious input; we only trust strings.
    expect(parseCollectionSearch({ view: 42, sort: { nested: "yes" } })).toEqual({});
  });

  it("keeps the search query, dropping empty/whitespace-only values", () => {
    expect(parseCollectionSearch({ q: "gaiman" })).toEqual({ q: "gaiman" });
    expect(parseCollectionSearch({ q: "" })).toEqual({});
    expect(parseCollectionSearch({ q: "   " })).toEqual({});
  });

  it("caps the search query at 200 chars to bound request size", () => {
    const long = "x".repeat(500);
    const result = parseCollectionSearch({ q: long });
    expect(result.q).toHaveLength(200);
  });

  it("parses all three params together", () => {
    expect(
      parseCollectionSearch({ view: "rarity", sort: "title", q: "oliver" }),
    ).toEqual({ view: "rarity", sort: "title", q: "oliver" });
  });
});
