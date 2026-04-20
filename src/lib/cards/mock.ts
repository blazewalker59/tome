import type { CardData } from "./types";
import type { PoolEntry } from "./pull";

/**
 * Mock pack contents for the visual prototype. One card per rarity tier
 * across a spread of genres so we can see how each variant renders.
 *
 * Cover URLs use OpenLibrary's free cover endpoint by ISBN. They're not
 * the long-term source — Hardcover will replace them — but they're stable,
 * unauthenticated, and visually correct for prototyping.
 */
export const MOCK_PACK: ReadonlyArray<CardData> = [
  {
    id: "mock-body-keeps-score",
    title: "The Body Keeps the Score",
    authors: ["Bessel van der Kolk"],
    coverUrl: "https://covers.openlibrary.org/b/isbn/9780143127741-L.jpg",
    description:
      "A landmark synthesis of trauma research showing how mind and body intertwine in healing.",
    pageCount: 464,
    publishedYear: 2014,
    genre: "psychology",
    rarity: "common",
    moodTags: ["dense", "hopeful", "clinical"],
  },
  {
    id: "mock-long-way",
    title: "The Long Way to a Small, Angry Planet",
    authors: ["Becky Chambers"],
    coverUrl: "https://covers.openlibrary.org/b/isbn/9780062444134-L.jpg",
    description:
      "A wandering crew of misfits aboard a tunnelling ship that punches holes in space.",
    pageCount: 441,
    publishedYear: 2014,
    genre: "science-fiction",
    rarity: "uncommon",
    moodTags: ["cozy", "character-driven", "escapist"],
  },
  {
    id: "mock-devotions",
    title: "Devotions",
    authors: ["Mary Oliver"],
    coverUrl: "https://covers.openlibrary.org/b/isbn/9780399563249-L.jpg",
    description:
      "Mary Oliver's own selection from a half-century of luminous attention to the world.",
    pageCount: 480,
    publishedYear: 2017,
    genre: "poetry",
    rarity: "rare",
    moodTags: ["meditative", "natural", "tender"],
  },
  {
    id: "mock-watchmen",
    title: "Watchmen",
    authors: ["Alan Moore", "Dave Gibbons"],
    coverUrl: "https://covers.openlibrary.org/b/isbn/9780930289232-L.jpg",
    description:
      "A noir deconstruction of the superhero, told in twelve issues of formal precision.",
    pageCount: 416,
    publishedYear: 1987,
    genre: "graphic-novel",
    rarity: "foil",
    moodTags: ["dark", "formally-inventive", "political"],
  },
  {
    id: "mock-piranesi",
    title: "Piranesi",
    authors: ["Susanna Clarke"],
    coverUrl: "https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg",
    description:
      "A man wanders an infinite house of statues and tides, keeping faithful records of every wonder.",
    pageCount: 272,
    publishedYear: 2020,
    genre: "fantasy",
    rarity: "legendary",
    moodTags: ["dreamlike", "literary", "lonely"],
  },
];

/**
 * Larger mock pool used by the `/rip` page so each rip pulls a different
 * 5-card subset and duplicates become possible. Mix of rarities skewed
 * realistically (mostly commons, a handful of rares, one legendary).
 */
export const MOCK_POOL: ReadonlyArray<CardData> = [
  ...MOCK_PACK,
  {
    id: "mock-station-eleven",
    title: "Station Eleven",
    authors: ["Emily St. John Mandel"],
    coverUrl: "https://covers.openlibrary.org/b/isbn/9780804172448-L.jpg",
    description:
      "A traveling Shakespearean troupe crosses a quiet, post-collapse Great Lakes region.",
    pageCount: 333,
    publishedYear: 2014,
    genre: "science-fiction",
    rarity: "uncommon",
    moodTags: ["elegiac", "interwoven", "hopeful"],
  },
  {
    id: "mock-immortal-life",
    title: "The Immortal Life of Henrietta Lacks",
    authors: ["Rebecca Skloot"],
    coverUrl: "https://covers.openlibrary.org/b/isbn/9781400052189-L.jpg",
    description:
      "The story of the woman whose cells, taken without consent, transformed modern medicine.",
    pageCount: 400,
    publishedYear: 2010,
    genre: "biography",
    rarity: "common",
    moodTags: ["investigative", "intimate", "ethics"],
  },
  {
    id: "mock-night-circus",
    title: "The Night Circus",
    authors: ["Erin Morgenstern"],
    coverUrl: "https://covers.openlibrary.org/b/isbn/9780307744432-L.jpg",
    description:
      "Two magicians bound to a duel they did not choose, played out under a black-and-white tent.",
    pageCount: 387,
    publishedYear: 2011,
    genre: "fantasy",
    rarity: "common",
    moodTags: ["lush", "romantic", "atmospheric"],
  },
  {
    id: "mock-fun-home",
    title: "Fun Home",
    authors: ["Alison Bechdel"],
    coverUrl: "https://covers.openlibrary.org/b/isbn/9780618871711-L.jpg",
    description:
      "A graphic memoir of a daughter, a closeted father, and a funeral home in rural Pennsylvania.",
    pageCount: 232,
    publishedYear: 2006,
    genre: "memoir",
    rarity: "rare",
    moodTags: ["confessional", "literary", "queer"],
  },
  {
    id: "mock-citizen",
    title: "Citizen: An American Lyric",
    authors: ["Claudia Rankine"],
    coverUrl: "https://covers.openlibrary.org/b/isbn/9781555976903-L.jpg",
    description:
      "A genre-bending lyric on race, refusal, and the small daily aggressions of being seen.",
    pageCount: 169,
    publishedYear: 2014,
    genre: "poetry",
    rarity: "rare",
    moodTags: ["urgent", "fragmented", "political"],
  },
  {
    id: "mock-pachinko",
    title: "Pachinko",
    authors: ["Min Jin Lee"],
    coverUrl: "https://covers.openlibrary.org/b/isbn/9781455563937-L.jpg",
    description:
      "Four generations of a Korean family in twentieth-century Japan, surviving and not.",
    pageCount: 490,
    publishedYear: 2017,
    genre: "historical-fiction",
    rarity: "uncommon",
    moodTags: ["sweeping", "intergenerational", "quietly-devastating"],
  },
  {
    id: "mock-overstory",
    title: "The Overstory",
    authors: ["Richard Powers"],
    coverUrl: "https://covers.openlibrary.org/b/isbn/9780393635522-L.jpg",
    description:
      "Nine strangers, summoned in different ways by the world's trees, find their lives entwined.",
    pageCount: 502,
    publishedYear: 2018,
    genre: "literary-fiction",
    rarity: "foil",
    moodTags: ["ecological", "epic", "polyphonic"],
  },
];

/**
 * Pool entries used for rarity-weighted sampling. Mirrors `MOCK_POOL` but
 * exposes only the shape `pullPack` cares about.
 */
export const MOCK_POOL_ENTRIES: ReadonlyArray<PoolEntry> = MOCK_POOL.map((c) => ({
  bookId: c.id,
  rarity: c.rarity,
}));

/** Convenience map used to hydrate pull results back into full card data. */
export const MOCK_POOL_BY_ID: ReadonlyMap<string, CardData> = new Map(
  MOCK_POOL.map((c) => [c.id, c]),
);
