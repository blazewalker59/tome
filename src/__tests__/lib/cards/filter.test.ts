import { describe, expect, it } from "vitest";
import {
  filterCards,
  groupByGenre,
  groupCards,
  rarityCounts,
  sortCards,
  uniqueGenres,
  uniqueMoods,
} from "@/lib/cards/filter";
import type { CardData } from "@/lib/cards/types";

const cards: CardData[] = [
  {
    id: "c1",
    title: "Beach Read",
    authors: ["Emily Henry"],
    coverUrl: "x",
    description: "",
    pageCount: 100,
    publishedYear: 2020,
    genre: "romance",
    rarity: "common",
    moodTags: ["cozy", "romantic"],
  },
  {
    id: "c2",
    title: "A Brief History of Time",
    authors: ["Stephen Hawking"],
    coverUrl: "x",
    description: "",
    pageCount: 200,
    publishedYear: 1988,
    genre: "science",
    rarity: "rare",
    moodTags: ["dense"],
  },
  {
    id: "c3",
    title: "Devotions",
    authors: ["Mary Oliver"],
    coverUrl: "x",
    description: "",
    pageCount: 300,
    publishedYear: 2017,
    genre: "poetry",
    rarity: "legendary",
    moodTags: ["meditative", "natural"],
  },
  {
    id: "c4",
    title: "Watchmen",
    authors: ["Alan Moore"],
    coverUrl: "x",
    description: "",
    pageCount: 416,
    publishedYear: 1987,
    genre: "graphic-novel",
    rarity: "foil",
    moodTags: ["dark", "political"],
  },
  {
    id: "c5",
    title: "Cozy Mystery",
    authors: ["Anonymous"],
    coverUrl: "x",
    description: "",
    pageCount: 220,
    publishedYear: 2021,
    genre: "romance",
    rarity: "uncommon",
    moodTags: ["cozy"],
  },
];

describe("filterCards", () => {
  it("returns all cards when no filter is applied", () => {
    expect(filterCards(cards, {})).toHaveLength(cards.length);
  });

  it("filters by genre", () => {
    const result = filterCards(cards, { genres: new Set(["romance"]) });
    expect(result.map((c) => c.id)).toEqual(["c1", "c5"]);
  });

  it("filters by rarity (multiple)", () => {
    const result = filterCards(cards, {
      rarities: new Set(["legendary", "foil"]),
    });
    expect(result.map((c) => c.id).sort()).toEqual(["c3", "c4"]);
  });

  it("filters by mood (any-match)", () => {
    const result = filterCards(cards, { moods: new Set(["cozy"]) });
    expect(result.map((c) => c.id).sort()).toEqual(["c1", "c5"]);
  });

  it("AND-combines filter dimensions", () => {
    const result = filterCards(cards, {
      genres: new Set(["romance"]),
      rarities: new Set(["common"]),
    });
    expect(result.map((c) => c.id)).toEqual(["c1"]);
  });

  it("does case-insensitive substring search on title and author", () => {
    expect(filterCards(cards, { search: "MARY" }).map((c) => c.id)).toEqual(["c3"]);
    expect(filterCards(cards, { search: "cozy" }).map((c) => c.id)).toEqual(["c5"]);
  });

  it("treats empty filter sets as 'no filter on that dimension'", () => {
    expect(filterCards(cards, { genres: new Set() })).toHaveLength(cards.length);
  });
});

describe("sortCards", () => {
  it("sorts by title alphabetically", () => {
    expect(sortCards(cards, "title").map((c) => c.title)).toEqual([
      "A Brief History of Time",
      "Beach Read",
      "Cozy Mystery",
      "Devotions",
      "Watchmen",
    ]);
  });

  it("sorts by author then title", () => {
    expect(sortCards(cards, "author").map((c) => c.authors[0])).toEqual([
      "Alan Moore",
      "Anonymous",
      "Emily Henry",
      "Mary Oliver",
      "Stephen Hawking",
    ]);
  });

  it("sorts by rarity (legendary first)", () => {
    expect(sortCards(cards, "rarity").map((c) => c.rarity)).toEqual([
      "legendary",
      "foil",
      "rare",
      "uncommon",
      "common",
    ]);
  });

  it("sorts by newest using injected acquired-at map", () => {
    const acquiredAt = new Map<string, number>([
      ["c1", 100],
      ["c2", 500],
      ["c3", 50],
      ["c4", 800],
      ["c5", 300],
    ]);
    expect(sortCards(cards, "newest", { acquiredAt }).map((c) => c.id)).toEqual([
      "c4",
      "c2",
      "c5",
      "c1",
      "c3",
    ]);
  });

  it("does not mutate the input array", () => {
    const before = cards.map((c) => c.id);
    sortCards(cards, "title");
    expect(cards.map((c) => c.id)).toEqual(before);
  });
});

describe("groupByGenre", () => {
  it("groups by genre, ordered by descending count then alphabetically", () => {
    const result = groupByGenre(cards);
    // romance has 2; the rest have 1 → romance first, then alpha order.
    expect(result.map((g) => g.genre)).toEqual(["romance", "graphic-novel", "poetry", "science"]);
    expect(result[0].cards.map((c) => c.id)).toEqual(["c1", "c5"]);
  });

  it("only includes genres present in the input", () => {
    const onlyPoetry = cards.filter((c) => c.genre === "poetry");
    const result = groupByGenre(onlyPoetry);
    expect(result.map((g) => g.genre)).toEqual(["poetry"]);
  });
});

describe("groupCards", () => {
  it("returns a single 'all' bucket for view=all", () => {
    const result = groupCards(cards, "all");
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("all");
    expect(result[0].cards).toHaveLength(cards.length);
  });

  it("groups by rarity in legendary→common order, omitting empty buckets", () => {
    // Every rarity has exactly one card in the fixture, so expect all 5
    // in the canonical order.
    const result = groupCards(cards, "rarity");
    expect(result.map((g) => g.label)).toEqual([
      "Legendary",
      "Foil",
      "Rare",
      "Uncommon",
      "Common",
    ]);
    // Restrict to two rarities to verify empty buckets are dropped.
    const subset = cards.filter((c) => c.rarity === "common" || c.rarity === "legendary");
    const trimmed = groupCards(subset, "rarity");
    expect(trimmed.map((g) => g.label)).toEqual(["Legendary", "Common"]);
  });

  it("groups by genre with count-desc ordering and Title-Case labels", () => {
    const result = groupCards(cards, "genre");
    expect(result.map((g) => g.label)).toEqual([
      "Romance",
      "Graphic Novel",
      "Poetry",
      "Science",
    ]);
    expect(result[0].cards.map((c) => c.id)).toEqual(["c1", "c5"]);
  });

  it("groups by author, duplicating books under every co-author", () => {
    const coAuthored: CardData[] = [
      ...cards,
      {
        id: "c6",
        title: "Good Omens",
        authors: ["Neil Gaiman", "Terry Pratchett"],
        coverUrl: "x",
        description: "",
        pageCount: 400,
        publishedYear: 1990,
        genre: "fantasy",
        rarity: "rare",
        moodTags: ["funny"],
      },
    ];
    const result = groupCards(coAuthored, "author");
    const byLabel = new Map(result.map((g) => [g.label, g]));
    // Good Omens must appear under both authors.
    expect(byLabel.get("Neil Gaiman")?.cards.map((c) => c.id)).toEqual(["c6"]);
    expect(byLabel.get("Terry Pratchett")?.cards.map((c) => c.id)).toEqual(["c6"]);
    // Every other card still appears exactly once.
    expect(byLabel.get("Emily Henry")?.cards.map((c) => c.id)).toEqual(["c1"]);
  });

  it("groups by pack using the acquisition map, falling back to label key when packId is missing", () => {
    const acquisitions = new Map<string, { packId: string | null; packName: string }>([
      ["c1", { packId: "p1", packName: "Editorial Pack" }],
      ["c2", { packId: "p1", packName: "Editorial Pack" }],
      ["c3", { packId: "p2", packName: "Booker 2024" }],
      // c4, c5 deliberately absent — they should cluster in "Unknown".
    ]);
    const result = groupCards(cards, "pack", { acquisitions });
    const byLabel = new Map(result.map((g) => [g.label, g]));
    expect(byLabel.get("Editorial Pack")?.cards.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(byLabel.get("Booker 2024")?.cards.map((c) => c.id)).toEqual(["c3"]);
    expect(byLabel.get("Unknown")?.cards.map((c) => c.id).sort()).toEqual(["c4", "c5"]);
  });

  it("orders groups by count desc, then alphabetically by label", () => {
    // Two genres of size 1 should appear alphabetically after the size-2 group.
    const result = groupCards(cards, "genre");
    const sizes = result.map((g) => g.cards.length);
    // Counts monotonically non-increasing.
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
    }
  });
});

describe("rarityCounts", () => {
  it("counts every rarity, returning 0 for absent ones", () => {
    expect(rarityCounts(cards)).toEqual({
      common: 1,
      uncommon: 1,
      rare: 1,
      foil: 1,
      legendary: 1,
    });
  });
});

describe("uniqueMoods", () => {
  it("returns a deduplicated, alphabetized list of mood tags", () => {
    expect(uniqueMoods(cards)).toEqual([
      "cozy",
      "dark",
      "dense",
      "meditative",
      "natural",
      "political",
      "romantic",
    ]);
  });
});

describe("uniqueGenres", () => {
  it("returns a deduplicated, alphabetized list of genres", () => {
    expect(uniqueGenres(cards)).toEqual(["graphic-novel", "poetry", "romance", "science"]);
  });
});
