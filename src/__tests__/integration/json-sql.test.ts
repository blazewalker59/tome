import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import {
  USER_ID,
  resetDb,
  seedBook,
  seedPack,
  seedUser,
  testDb,
} from "./_helpers";
import type { Database } from "@/db/client";
import { books, collectionCards, packRips } from "@/db/schema";
import { toAuthorsNeedle } from "@/db/authors";

/**
 * The Postgres-to-SQLite query rewrites, against real data.
 *
 * These queries changed shape completely in the migration — `unnest` became
 * `json_each`, `jsonb_agg`/`jsonb_build_object` became
 * `json_group_array`/`json_object`, `array_length` became
 * `json_array_length`, and array containment search became a LIKE over a
 * denormalized column. All of it operates on JSON text that SQLite parses at
 * runtime, so the failure modes are things a type checker cannot see: an
 * array silently embedded as an escaped string, a JSON path that matches
 * nothing, a column that exists but is never populated.
 *
 * The social feed queries in particular return empty on an empty database,
 * which means they "pass" while proving nothing. Everything here seeds rows
 * first.
 */

let db: Database;

beforeEach(async () => {
  db = testDb();
  await resetDb();
});

describe("json_each over pulled_book_ids", () => {
  it("unnests the JSON id array and joins books (the legendary feed)", async () => {
    await seedUser(db);
    await seedPack(db, { id: "pack-1", slug: "pack-1" });
    await seedBook(db, {
      id: "book-1",
      title: "The Way of Kings",
      authors: ["Brandon Sanderson"],
      rarity: "legendary",
    });
    await seedBook(db, {
      id: "book-2",
      title: "Mistborn",
      authors: ["Brandon Sanderson"],
      rarity: "legendary",
    });
    await seedBook(db, {
      id: "book-3",
      title: "Common Book",
      authors: ["Someone Else"],
      rarity: "common",
    });

    await db.insert(packRips).values({
      id: "rip-1",
      userId: USER_ID,
      packId: "pack-1",
      pulledBookIds: ["book-1", "book-2", "book-3"],
      duplicates: 0,
      shardsAwarded: 0,
    });

    // The shape loadLegendaryPullEvents builds: unnest via json_each, filter
    // to legendary, aggregate back to one row per rip.
    const rows = await db.all<{ rip_id: string; cards: string }>(
      sql`
        SELECT rip_id, json_group_array(json_object(
          'book_id', book_id, 'title', title, 'authors', json(authors)
        )) AS cards
        FROM (
          SELECT pr.id AS rip_id, b.id AS book_id, b.title AS title,
                 b.authors AS authors
          FROM pack_rips pr
          INNER JOIN json_each(pr.pulled_book_ids) AS pulled
          INNER JOIN books b ON b.id = pulled.value AND b.rarity = 'legendary'
          ORDER BY b.title
        )
        GROUP BY rip_id
      `,
    );

    expect(rows).toHaveLength(1);
    const cards = JSON.parse(rows[0].cards) as Array<{
      book_id: string;
      title: string;
      authors: Array<string>;
    }>;

    // Only the two legendaries, ordered by title.
    expect(cards.map((c) => c.title)).toEqual(["Mistborn", "The Way of Kings"]);

    // The trap this rewrite exists to avoid: `authors` is a TEXT column
    // holding JSON, so `json_object('authors', b.authors)` without the
    // `json()` wrapper nests it as an ESCAPED STRING rather than an array.
    // Assert the parsed shape, not just the presence of a value.
    expect(Array.isArray(cards[0].authors)).toBe(true);
    expect(cards[0].authors).toEqual(["Brandon Sanderson"]);
  });

  it("counts pulled ids with json_array_length (was array_length)", async () => {
    await seedUser(db);
    await seedPack(db, { id: "pack-1", slug: "pack-1" });
    await db.insert(packRips).values({
      id: "rip-1",
      userId: USER_ID,
      packId: "pack-1",
      pulledBookIds: ["a", "b", "c", "d", "e"],
      duplicates: 2,
      shardsAwarded: 10,
    });

    const { results } = await env.DB.prepare(
      "SELECT COALESCE(json_array_length(pulled_book_ids), 0) AS n FROM pack_rips",
    ).all<{ n: number }>();

    expect(results[0].n).toBe(5);
  });

  it("finds rips whose books the user still owns (the orphan-rip guard)", async () => {
    await seedUser(db);
    await seedPack(db, { id: "pack-1", slug: "pack-1" });
    await seedBook(db, { id: "book-1", title: "Owned" });
    await seedBook(db, { id: "book-2", title: "Not Owned" });

    await db.insert(packRips).values([
      {
        id: "rip-kept",
        userId: USER_ID,
        packId: "pack-1",
        pulledBookIds: ["book-1"],
      },
      {
        id: "rip-orphan",
        userId: USER_ID,
        packId: "pack-1",
        pulledBookIds: ["book-2"],
      },
    ]);
    // The user owns only book-1, so rip-orphan must be hidden.
    await db.insert(collectionCards).values({
      userId: USER_ID,
      bookId: "book-1",
      quantity: 1,
    });

    const { results } = await env.DB.prepare(
      `SELECT pr.id AS id FROM pack_rips pr
       WHERE EXISTS (
         SELECT 1 FROM json_each(pr.pulled_book_ids) AS pulled
         INNER JOIN collection_cards cc
           ON cc.user_id = pr.user_id AND cc.book_id = pulled.value
       )`,
    ).all<{ id: string }>();

    expect(results.map((r) => r.id)).toEqual(["rip-kept"]);
  });
});

describe("authors_text search (replaced unnest + ILIKE)", () => {
  it("matches an author regardless of case", async () => {
    await seedBook(db, {
      id: "b1",
      title: "Piranesi",
      authors: ["Susanna Clarke"],
    });
    await seedBook(db, {
      id: "b2",
      title: "Project Hail Mary",
      authors: ["Andy Weir"],
    });

    const hits = await db
      .select({ title: books.title })
      .from(books)
      .where(like(books.authorsText, `%${toAuthorsNeedle("SUSANNA")}%`));

    // Postgres used ILIKE; SQLite's LIKE is only case-insensitive for ASCII,
    // which is why both the column and the needle are lowercased.
    expect(hits.map((h) => h.title)).toEqual(["Piranesi"]);
  });

  it("keeps authors_text in step with the authors array", async () => {
    await seedBook(db, {
      id: "b1",
      title: "Multi",
      authors: ["Ann Leckie", "Becky Chambers"],
    });

    const [row] = await db.select().from(books).where(eq(books.id, "b1"));

    // The denormalization only works if both columns are written together —
    // `setAuthors()` is the single writer, and this is the invariant it holds.
    expect(row.authors).toEqual(["Ann Leckie", "Becky Chambers"]);
    expect(row.authorsText).toBe("ann leckie becky chambers");
  });

  it("sorts by first author via json_extract (was authors[1])", async () => {
    await seedBook(db, { id: "b1", title: "Z", authors: ["Zadie Smith"] });
    await seedBook(db, { id: "b2", title: "A", authors: ["Ann Leckie"] });
    await seedBook(db, { id: "b3", title: "N", authors: [] });

    const { results } = await env.DB.prepare(
      `SELECT id FROM books
       ORDER BY json_extract(authors, '$[0]') ASC NULLS LAST, id ASC`,
    ).all<{ id: string }>();

    // Postgres indexed arrays from 1 (authors[1]); the JSON path is 0-based.
    // Books with no authors sort last in both.
    expect(results.map((r) => r.id)).toEqual(["b2", "b1", "b3"]);
  });
});

describe("column type round-trips", () => {
  it("stores JSON arrays as JSON, not as escaped strings", async () => {
    await seedBook(db, { id: "b1", title: "T", authors: ["A", "B"] });

    const { results } = await env.DB.prepare(
      "SELECT json_valid(authors) AS valid, json_array_length(authors) AS n FROM books",
    ).all<{ valid: number; n: number }>();

    expect(results[0].valid).toBe(1);
    expect(results[0].n).toBe(2);
  });

  it("stores timestamps as epoch SECONDS", async () => {
    await seedUser(db);

    const { results } = await env.DB.prepare(
      "SELECT created_at FROM users",
    ).all<{ created_at: number }>();

    const seconds = results[0].created_at;
    // Seconds, not milliseconds. Getting this backwards doesn't throw — it
    // silently puts every row in 1970 or the year 56000 — so pin the
    // magnitude rather than trusting the schema comment.
    expect(seconds).toBeGreaterThan(1_600_000_000); // ~2020
    expect(seconds).toBeLessThan(4_000_000_000); // ~2096
  });
});
