import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb, testDb } from "./_helpers";
import type { Database } from "@/db/client";
import { books } from "@/db/schema";
import { setAuthors } from "@/db/authors";

/**
 * The book upsert-on-hardcover_id shape, against a real D1.
 *
 * Every Hardcover ingest path (admin, pack builder, reading log) shares this
 * shape, and all four sites carried `created: sql\`(xmax = 0)\`` — the standard
 * Postgres trick for telling an insert from an update in one round trip.
 * `xmax` is a Postgres SYSTEM COLUMN. SQLite has no such thing, so on D1 the
 * statement failed outright with `no such column: xmax` and logging a book was
 * impossible.
 *
 * It is a good example of what a grep-driven migration misses: it is not a
 * type, a function, or an operator, so nothing about it looks Postgres-shaped
 * until you run it. Hence this test, which asserts the replacement (mint the
 * id, compare what comes back) reports insert vs update correctly.
 */

let db: Database;

beforeEach(async () => {
  db = testDb();
  await resetDb();
});

/** The production shape, minus the Hardcover fetch. */
async function upsertBook(opts: {
  hardcoverId: number;
  title: string;
  authors: Array<string>;
}): Promise<{ bookId: string; created: boolean }> {
  const newBookId = crypto.randomUUID();
  const [upserted] = await db
    .insert(books)
    .values({
      id: newBookId,
      hardcoverId: opts.hardcoverId,
      title: opts.title,
      ...setAuthors(opts.authors),
      genre: "unknown",
      rarity: "common",
    })
    .onConflictDoUpdate({
      target: books.hardcoverId,
      set: {
        title: opts.title,
        ...setAuthors(opts.authors),
        updatedAt: new Date(),
      },
    })
    .returning({ id: books.id });

  return { bookId: upserted.id, created: upserted.id === newBookId };
}

describe("book upsert on hardcover_id", () => {
  it("runs at all (the xmax regression)", async () => {
    await expect(
      upsertBook({ hardcoverId: 1, title: "First", authors: ["A"] }),
    ).resolves.toBeDefined();
  });

  it("reports created=true for a genuinely new book", async () => {
    const res = await upsertBook({
      hardcoverId: 42,
      title: "New Book",
      authors: ["Ann Leckie"],
    });
    expect(res.created).toBe(true);
  });

  it("reports created=false when the hardcover_id already exists", async () => {
    const first = await upsertBook({
      hardcoverId: 42,
      title: "Original",
      authors: ["Ann Leckie"],
    });
    const second = await upsertBook({
      hardcoverId: 42,
      title: "Re-ingested",
      authors: ["Ann Leckie"],
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    // Same row, not a duplicate — the unique index did its job.
    expect(second.bookId).toBe(first.bookId);

    const rows = await db.select().from(books);
    expect(rows).toHaveLength(1);
    // The conflict branch refreshed the editable fields.
    expect(rows[0].title).toBe("Re-ingested");
  });

  it("keeps both author columns in step through the conflict branch", async () => {
    await upsertBook({ hardcoverId: 7, title: "T", authors: ["Ann Leckie"] });
    await upsertBook({
      hardcoverId: 7,
      title: "T",
      authors: ["Becky Chambers", "Ann Leckie"],
    });

    const [row] = await db.select().from(books).where(eq(books.hardcoverId, 7));
    // `authors_text` is only useful if the UPDATE path maintains it too — a
    // stale search key is worse than none, because it silently misses.
    expect(row.authors).toEqual(["Becky Chambers", "Ann Leckie"]);
    expect(row.authorsText).toBe("becky chambers ann leckie");
  });
});
