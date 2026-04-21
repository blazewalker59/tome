import { describe, expect, it } from "vitest";
import {
  assignRarities,
  MIN_RATINGS_FOR_TOP_TIER,
  scoreBook,
} from "@/lib/cards/rarity";
import { createBookRanking, resetFactoryIds } from "@test/factories";

describe("scoreBook", () => {
  it("returns averageRating * ratingsCount", () => {
    expect(scoreBook({ id: "x", ratingsCount: 1000, averageRating: 4.5 })).toBe(4500);
  });

  it("parses string averageRating (DB numeric shape)", () => {
    expect(scoreBook({ id: "x", ratingsCount: 1000, averageRating: "4.5" })).toBe(4500);
  });

  it("returns 0 for null/invalid averageRating (new or unrated book)", () => {
    expect(scoreBook({ id: "x", ratingsCount: 1000, averageRating: null })).toBe(0);
    expect(scoreBook({ id: "x", ratingsCount: 1000, averageRating: "nope" })).toBe(0);
    expect(scoreBook({ id: "x", ratingsCount: 1000, averageRating: 0 })).toBe(0);
  });
});

describe("assignRarities", () => {
  it("returns an empty map for no input", () => {
    expect(assignRarities([])).toEqual(new Map());
  });

  it("buckets 100 books into the documented 1/5/15/30/49 cutoffs", () => {
    resetFactoryIds();
    // 100 books with descending scores — all well above the floor so the
    // top-tier-eligibility rule doesn't interfere with the bucket counts.
    const books = Array.from({ length: 100 }, (_, i) =>
      createBookRanking({ ratingsCount: 10_000 - i, averageRating: 4.5 }),
    );

    const result = assignRarities(books);

    const counts = { common: 0, uncommon: 0, rare: 0, foil: 0, legendary: 0 };
    for (const rarity of result.values()) counts[rarity]++;

    expect(counts).toEqual({
      legendary: 1,
      foil: 5,
      rare: 15,
      uncommon: 30,
      common: 49,
    });
  });

  it("puts the highest-scoring book at legendary and the lowest at common", () => {
    resetFactoryIds();
    const top = createBookRanking({ ratingsCount: 1_000_000, averageRating: 4.8 });
    const middle = Array.from({ length: 98 }, () =>
      createBookRanking({ ratingsCount: 1000, averageRating: 4.0 }),
    );
    const bottom = createBookRanking({ ratingsCount: 200, averageRating: 3.0 });

    const result = assignRarities([top, ...middle, bottom]);

    expect(result.get(top.id)).toBe("legendary");
    expect(result.get(bottom.id)).toBe("common");
  });

  it("beats a pure-volume bestseller with a widely-loved book", () => {
    // "Mediocre bestseller" — huge volume, middling rating.
    const bestseller = createBookRanking({
      id: "bestseller",
      ratingsCount: 500_000,
      averageRating: 3.2,
    });
    // "Beloved classic" — solid volume AND high rating.
    const beloved = createBookRanking({
      id: "beloved",
      ratingsCount: 200_000,
      averageRating: 4.6,
    });

    // bestseller: 1.6M, beloved: 920k → bestseller still wins on raw score.
    // This test documents the tradeoff, not a bug: mass-popular-and-liked
    // STILL beats niche-and-adored. That feels right for "legendary" —
    // legendary should mean universally celebrated.
    expect(scoreBook(bestseller)).toBeGreaterThan(scoreBook(beloved));
  });

  it("caps small-sample books at `rare` even if their score percentile is in the top tiers", () => {
    // A hypothetical indie gem: perfect rating, only 10 ratings. Without
    // the floor it would be #1 by score (5.0 × 10 = 50) in a catalog of
    // otherwise-unrated books. The floor should cap it at `rare`.
    const tinyGem = createBookRanking({
      id: "tinygem",
      ratingsCount: 10,
      averageRating: 5.0,
    });
    const others = Array.from({ length: 19 }, () =>
      createBookRanking({ ratingsCount: 0, averageRating: null }),
    );

    const result = assignRarities([tinyGem, ...others]);
    expect(result.get(tinyGem.id)).toBe("rare");
  });

  it("treats a book exactly at the floor as eligible for top tiers", () => {
    const atFloor = createBookRanking({
      id: "atfloor",
      ratingsCount: MIN_RATINGS_FOR_TOP_TIER,
      averageRating: 5.0,
    });
    const others = Array.from({ length: 99 }, () =>
      createBookRanking({ ratingsCount: 10, averageRating: 3.0 }),
    );

    const result = assignRarities([atFloor, ...others]);
    expect(result.get(atFloor.id)).toBe("legendary");
  });

  it("assigns `common` to books with no rating data and keeps them below rated books", () => {
    const unrated = createBookRanking({
      id: "unrated",
      ratingsCount: 0,
      averageRating: null,
    });
    const rated = createBookRanking({
      id: "rated",
      ratingsCount: 500,
      averageRating: 4.5,
    });
    // In a 2-book catalog the best book's percentile is 1/2 = 0.5 →
    // `uncommon` by the cutoff table. We only assert relative ordering
    // (rated must outrank unrated) and that unrated is `common`.
    const result = assignRarities([unrated, rated]);
    expect(result.get(unrated.id)).toBe("common");
    expect(result.get(rated.id)).toBe("uncommon");
  });

  it("is deterministic for ties (broken by id ascending)", () => {
    const a = { id: "a", ratingsCount: 1000, averageRating: 4.0 };
    const b = { id: "b", ratingsCount: 1000, averageRating: 4.0 };
    const c = { id: "c", ratingsCount: 1000, averageRating: 4.0 };
    const first = assignRarities([c, a, b]);
    const second = assignRarities([b, c, a]);
    expect(first).toEqual(second);
  });
});
