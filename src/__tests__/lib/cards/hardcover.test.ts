import { describe, expect, it } from "vitest";
import {
  bookResponseToRow,
  extractAuthors,
  extractCoverUrl,
  normalizeAverageRating,
  type HardcoverBook,
} from "@/lib/cards/hardcover";

/**
 * Minimal fixture matching the shape our ingestion query actually
 * requests. Override individual fields per-test with spread.
 */
function fixture(overrides: Partial<HardcoverBook> = {}): HardcoverBook {
  return {
    id: 42,
    title: "The Left Hand of Darkness",
    subtitle: null,
    description: "On a frozen world…",
    pages: 304,
    release_year: 1969,
    rating: 4.21,
    ratings_count: 58_203,
    cached_image: { url: "https://cdn.hardcover.app/covers/42.jpg" },
    image: null,
    contributions: [
      { contribution: "Author", author: { name: "Ursula K. Le Guin" } },
    ],
    ...overrides,
  };
}

describe("extractAuthors", () => {
  it("pulls primary authors in order", () => {
    expect(
      extractAuthors([
        { contribution: "Author", author: { name: "A" } },
        { contribution: "Author", author: { name: "B" } },
      ]),
    ).toEqual(["A", "B"]);
  });

  it("treats null contribution role as primary author (legacy Hardcover data)", () => {
    expect(
      extractAuthors([{ contribution: null, author: { name: "A" } }]),
    ).toEqual(["A"]);
  });

  it("skips translators / illustrators / etc.", () => {
    expect(
      extractAuthors([
        { contribution: "Author", author: { name: "A" } },
        { contribution: "Translator", author: { name: "T" } },
        { contribution: "Illustrator", author: { name: "I" } },
      ]),
    ).toEqual(["A"]);
  });

  it("deduplicates repeated author names", () => {
    expect(
      extractAuthors([
        { contribution: "Author", author: { name: "A" } },
        { contribution: "Author", author: { name: "A" } },
      ]),
    ).toEqual(["A"]);
  });

  it("returns [] for null/empty contributions", () => {
    expect(extractAuthors(null)).toEqual([]);
    expect(extractAuthors([])).toEqual([]);
  });
});

describe("extractCoverUrl", () => {
  it("prefers cached_image.url", () => {
    expect(
      extractCoverUrl(
        fixture({
          cached_image: { url: "a" },
          image: { url: "b" },
        }),
      ),
    ).toBe("a");
  });

  it("falls back to image.url when cached_image is null", () => {
    expect(
      extractCoverUrl(fixture({ cached_image: null, image: { url: "b" } })),
    ).toBe("b");
  });

  it("returns null when both are missing", () => {
    expect(extractCoverUrl(fixture({ cached_image: null, image: null }))).toBeNull();
  });
});

describe("normalizeAverageRating", () => {
  it("formats number to two decimals as a string (matches DB text column)", () => {
    expect(normalizeAverageRating(4.21)).toBe("4.21");
  });

  it("parses string input from GraphQL numeric serialization", () => {
    expect(normalizeAverageRating("4.21")).toBe("4.21");
  });

  it("returns null for null/undefined/zero/invalid", () => {
    expect(normalizeAverageRating(null)).toBeNull();
    expect(normalizeAverageRating(undefined)).toBeNull();
    expect(normalizeAverageRating(0)).toBeNull();
    expect(normalizeAverageRating("nope")).toBeNull();
  });

  it("clamps to [0, 5]", () => {
    expect(normalizeAverageRating(99)).toBe("5.00");
  });
});

describe("bookResponseToRow", () => {
  const curation = { genre: "science-fiction", moodTags: ["literary", "slow-burn"] as const };

  it("produces a well-formed insert row", () => {
    const row = bookResponseToRow(fixture(), curation);

    expect(row).toMatchObject({
      hardcoverId: 42,
      title: "The Left Hand of Darkness",
      authors: ["Ursula K. Le Guin"],
      coverUrl: "https://cdn.hardcover.app/covers/42.jpg",
      description: "On a frozen world…",
      pageCount: 304,
      publishedYear: 1969,
      genre: "science-fiction",
      rarity: "common",
      moodTags: ["literary", "slow-burn"],
      ratingsCount: 58_203,
      averageRating: "4.21",
    });
  });

  it("wraps the raw payload in rawMetadata with provenance", () => {
    const row = bookResponseToRow(fixture(), curation);
    expect(row.rawMetadata).toMatchObject({
      source: "hardcover",
      book: expect.objectContaining({ id: 42 }),
    });
    expect((row.rawMetadata as { fetchedAt: string }).fetchedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it("honors an explicit initialRarity override", () => {
    const row = bookResponseToRow(fixture(), curation, { initialRarity: "legendary" });
    expect(row.rarity).toBe("legendary");
  });

  it("trims title whitespace", () => {
    const row = bookResponseToRow(fixture({ title: "  Padded  " }), curation);
    expect(row.title).toBe("Padded");
  });

  it("defaults missing ratings / pages / year to null/0", () => {
    const row = bookResponseToRow(
      fixture({
        rating: null,
        ratings_count: null,
        pages: null,
        release_year: null,
        description: null,
      }),
      curation,
    );
    expect(row.averageRating).toBeNull();
    expect(row.ratingsCount).toBe(0);
    expect(row.pageCount).toBeNull();
    expect(row.publishedYear).toBeNull();
    expect(row.description).toBeNull();
  });

  it("rejects a book with no title", () => {
    expect(() => bookResponseToRow(fixture({ title: null }), curation)).toThrow(
      /no title/,
    );
    expect(() => bookResponseToRow(fixture({ title: "   " }), curation)).toThrow(
      /no title/,
    );
  });

  it("rejects an invalid Hardcover id", () => {
    expect(() => bookResponseToRow(fixture({ id: 0 }), curation)).toThrow(/Invalid/);
    expect(() => bookResponseToRow(fixture({ id: -1 }), curation)).toThrow(/Invalid/);
  });

  it("rejects more than 3 mood tags (SPEC §2)", () => {
    expect(() =>
      bookResponseToRow(fixture(), {
        genre: "science-fiction",
        moodTags: ["a", "b", "c", "d"],
      }),
    ).toThrow(/3 mood tags/);
  });
});
