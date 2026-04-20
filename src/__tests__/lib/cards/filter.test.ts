import { describe, expect, it } from "vitest";
import {
  filterCards,
  groupByGenre,
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
