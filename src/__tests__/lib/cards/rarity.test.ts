import { describe, expect, it } from "vitest";
import { assignRarities } from "@/lib/cards/rarity";
import { createBookRanking, resetFactoryIds } from "@test/factories";

describe("assignRarities", () => {
  it("returns an empty map for no input", () => {
    expect(assignRarities([])).toEqual(new Map());
  });

  it("buckets 100 books into the documented percentile cutoffs", () => {
    resetFactoryIds();
    // 100 books with descending ratings counts so rank == position.
    const books = Array.from({ length: 100 }, (_, i) =>
      createBookRanking({ ratingsCount: 1000 - i }),
    );

    const result = assignRarities(books);

    const counts = { common: 0, uncommon: 0, rare: 0, foil: 0, legendary: 0 };
    for (const rarity of result.values()) counts[rarity]++;

    expect(counts).toEqual({
      common: 20,
      uncommon: 30,
      rare: 30,
      foil: 15,
      legendary: 5,
    });
  });

  it("assigns the most-rated book to common and the least-rated to legendary", () => {
    resetFactoryIds();
    const top = createBookRanking({ ratingsCount: 1_000_000 });
    const middle = Array.from({ length: 18 }, () => createBookRanking({ ratingsCount: 500 }));
    const bottom = createBookRanking({ ratingsCount: 1 });

    const result = assignRarities([top, ...middle, bottom]);

    expect(result.get(top.id)).toBe("common");
    expect(result.get(bottom.id)).toBe("legendary");
  });

  it("is deterministic for ties (broken by id)", () => {
    const a = { id: "a", ratingsCount: 100 };
    const b = { id: "b", ratingsCount: 100 };
    const c = { id: "c", ratingsCount: 100 };
    const first = assignRarities([c, a, b]);
    const second = assignRarities([b, c, a]);
    expect(first).toEqual(second);
  });
});
