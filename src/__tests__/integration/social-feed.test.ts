import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  USER_ID,
  resetDb,
  seedBook,
  seedPack,
  seedUser,
  testDb,
} from "./_helpers";
import type { Database } from "@/db/client";
import { collectionCards, packBooks, packRips, packs } from "@/db/schema";
import { _internals } from "@/server/social";

/**
 * The social feed loaders, running their REAL queries against D1.
 *
 * Earlier coverage tested hand-copied approximations of this SQL, which is a
 * weaker claim than it looks: a copy proves SQLite accepts *that string*, not
 * that the query the app ships is correct. These call the production loaders.
 *
 * Every case seeds rows first. All three queries return empty on an empty
 * database, so an unseeded test would pass while proving nothing — which is
 * exactly how the migration's earlier verification looked green.
 */

const {
  loadLegendaryPullEvents,
  loadPackPublishedEvents,
  loadFeedSuggestions,
} = _internals;

const FOLLOWEE = "followee-1";

let db: Database;

beforeEach(async () => {
  db = testDb();
  await resetDb();
});

describe("loadLegendaryPullEvents", () => {
  it("groups a rip's legendary cards into one event", async () => {
    await seedUser(db, { id: FOLLOWEE });
    await seedPack(db, { id: "pack-1", slug: "pack-1", creatorId: FOLLOWEE });
    await seedBook(db, {
      id: "leg-1",
      title: "The Way of Kings",
      authors: ["Brandon Sanderson"],
      rarity: "legendary",
    });
    await seedBook(db, {
      id: "leg-2",
      title: "Mistborn",
      authors: ["Brandon Sanderson"],
      rarity: "legendary",
    });
    await seedBook(db, { id: "common-1", title: "Ordinary", rarity: "common" });

    await db.insert(packRips).values({
      id: "rip-1",
      userId: FOLLOWEE,
      packId: "pack-1",
      pulledBookIds: ["leg-1", "common-1", "leg-2"],
    });

    const events = await loadLegendaryPullEvents(db, [FOLLOWEE], null, 20);

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.type).toBe("legendary_pull");
    // Only the legendaries, sorted by title inside the aggregate.
    expect(event.cards.map((c) => c.title)).toEqual([
      "Mistborn",
      "The Way of Kings",
    ]);
    // The `json()` trap: without it, authors nests as an escaped string.
    expect(event.cards[0].authors).toEqual(["Brandon Sanderson"]);
    // Epoch seconds out of SQLite, milliseconds in the feed contract.
    expect(event.timestamp).toBeGreaterThan(1_600_000_000_000);
  });

  it("returns nothing when the rip has no legendaries", async () => {
    await seedUser(db, { id: FOLLOWEE });
    await seedPack(db, { id: "pack-1", slug: "pack-1", creatorId: FOLLOWEE });
    await seedBook(db, { id: "c1", title: "Ordinary", rarity: "common" });
    await db.insert(packRips).values({
      id: "rip-1",
      userId: FOLLOWEE,
      packId: "pack-1",
      pulledBookIds: ["c1"],
    });

    expect(await loadLegendaryPullEvents(db, [FOLLOWEE], null, 20)).toEqual([]);
  });

  it("only surfaces rips by the followees passed in", async () => {
    await seedUser(db, { id: FOLLOWEE });
    await seedUser(db, { id: "stranger" });
    await seedPack(db, { id: "pack-1", slug: "pack-1", creatorId: FOLLOWEE });
    await seedBook(db, { id: "leg-1", title: "Legend", rarity: "legendary" });

    await db.insert(packRips).values([
      {
        id: "rip-mine",
        userId: FOLLOWEE,
        packId: "pack-1",
        pulledBookIds: ["leg-1"],
      },
      {
        id: "rip-theirs",
        userId: "stranger",
        packId: "pack-1",
        pulledBookIds: ["leg-1"],
      },
    ]);

    const events = await loadLegendaryPullEvents(db, [FOLLOWEE], null, 20);
    // The old query built an ARRAY[...] literal by string-concatenating ids
    // with hand-rolled quote escaping; this is now a plain IN (...) over bind
    // params, so it is worth pinning that the filter still filters.
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("pull:rip-mine");
  });

  it("honours the `before` cursor", async () => {
    await seedUser(db, { id: FOLLOWEE });
    await seedPack(db, { id: "pack-1", slug: "pack-1", creatorId: FOLLOWEE });
    await seedBook(db, { id: "leg-1", title: "Legend", rarity: "legendary" });

    const old = new Date("2026-01-01T00:00:00Z");
    const recent = new Date("2026-06-01T00:00:00Z");
    await db.insert(packRips).values([
      {
        id: "rip-old",
        userId: FOLLOWEE,
        packId: "pack-1",
        pulledBookIds: ["leg-1"],
        rippedAt: old,
      },
      {
        id: "rip-recent",
        userId: FOLLOWEE,
        packId: "pack-1",
        pulledBookIds: ["leg-1"],
        rippedAt: recent,
      },
    ]);

    // A Date interpolated into raw SQL has to be converted to epoch seconds
    // by hand — D1 rejects a Date outright, and getting the unit wrong
    // silently matches everything or nothing.
    const events = await loadLegendaryPullEvents(
      db,
      [FOLLOWEE],
      new Date("2026-03-01T00:00:00Z"),
      20,
    );
    expect(events.map((e) => e.id)).toEqual(["pull:rip-old"]);
  });
});

describe("loadPackPublishedEvents", () => {
  it("surfaces a followee's published pack with its book count", async () => {
    await seedUser(db, { id: FOLLOWEE });
    await seedPack(db, { id: "pack-1", slug: "pack-1", creatorId: FOLLOWEE });
    await seedBook(db, { id: "b1", title: "One" });
    await seedBook(db, { id: "b2", title: "Two" });
    await db.insert(packBooks).values([
      { packId: "pack-1", bookId: "b1" },
      { packId: "pack-1", bookId: "b2" },
    ]);
    await db
      .update(packs)
      .set({ publishedAt: new Date("2026-05-01T00:00:00Z") })
      .where(eq(packs.id, "pack-1"));

    const events = await loadPackPublishedEvents(db, [FOLLOWEE], null, 20);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("pack_published");
    // The count is a correlated subquery that used to carry `COUNT(*)::int`.
    expect(events[0].pack.bookCount).toBe(2);
    expect(events[0].actor.username).toBe(FOLLOWEE);
  });
});

describe("loadFeedSuggestions", () => {
  // Despite the name this returns trending public PACKS to show a viewer
  // whose feed is empty — not creators. `getSuggestedCreatorsFn` is the
  // people-shaped one. Worth stating, because the two are easy to conflate.

  it("returns other users' public packs, ordered by recent rip count", async () => {
    await seedUser(db, { id: USER_ID });
    await seedUser(db, { id: "creator-hot" });
    await seedUser(db, { id: "creator-cold" });
    await seedBook(db, { id: "leg-1", title: "Legend", rarity: "legendary" });

    for (const [id, creator] of [
      ["pack-hot", "creator-hot"],
      ["pack-cold", "creator-cold"],
    ] as const) {
      await seedPack(db, { id, slug: id, creatorId: creator });
      await db
        .update(packs)
        .set({ publishedAt: new Date() })
        .where(eq(packs.id, id));
    }

    // Two recent rips on pack-hot, none on pack-cold. The ordering
    // expression is a correlated COUNT over a rolling 7-day window whose
    // cutoff is a Date interpolated into raw SQL — the exact spot that
    // needs an explicit epoch-seconds conversion.
    await db.insert(packRips).values([
      {
        id: "r1",
        userId: "creator-cold",
        packId: "pack-hot",
        pulledBookIds: ["leg-1"],
      },
      {
        id: "r2",
        userId: USER_ID,
        packId: "pack-hot",
        pulledBookIds: ["leg-1"],
      },
    ]);

    const suggestions = await loadFeedSuggestions(db, USER_ID);

    expect(suggestions.map((p) => p.slug)).toEqual(["pack-hot", "pack-cold"]);
    expect(suggestions[0].creatorUsername).toBe("creator-hot");
    // JSON column round-trips as an array, never null.
    expect(suggestions[0].genreTags).toEqual([]);
  });

  it("excludes the viewer's own packs", async () => {
    await seedUser(db, { id: USER_ID });
    await seedUser(db, { id: "someone-else" });

    for (const [id, creator] of [
      ["mine", USER_ID],
      ["theirs", "someone-else"],
    ] as const) {
      await seedPack(db, { id, slug: id, creatorId: creator });
      await db
        .update(packs)
        .set({ publishedAt: new Date() })
        .where(eq(packs.id, id));
    }

    const suggestions = await loadFeedSuggestions(db, USER_ID);
    expect(suggestions.map((p) => p.slug)).toEqual(["theirs"]);
  });

  it("omits editorial packs, which have no creator to attribute", async () => {
    await seedUser(db, { id: USER_ID });
    await seedPack(db, { id: "editorial", slug: "editorial", creatorId: null });
    await db
      .update(packs)
      .set({ publishedAt: new Date() })
      .where(eq(packs.id, "editorial"));

    // `creator_id IS NOT NULL` plus an INNER JOIN on users — an editorial
    // pack has neither.
    expect(await loadFeedSuggestions(db, USER_ID)).toEqual([]);
  });
});

describe("collection guards", () => {
  it("counts a user's owned books through the composite unique", async () => {
    await seedUser(db);
    await seedBook(db, { id: "b1", title: "One" });
    await db
      .insert(collectionCards)
      .values({ userId: USER_ID, bookId: "b1", quantity: 1 })
      .onConflictDoNothing({
        target: [collectionCards.userId, collectionCards.bookId],
      });
    // Second insert of the same (user, book) must be swallowed, not throw —
    // this is the `collection_user_book_uq` constraint doing its job.
    await db
      .insert(collectionCards)
      .values({ userId: USER_ID, bookId: "b1", quantity: 1 })
      .onConflictDoNothing({
        target: [collectionCards.userId, collectionCards.bookId],
      });

    const rows = await db.select().from(collectionCards);
    expect(rows).toHaveLength(1);
  });
});
