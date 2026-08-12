import { beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq, isNull, like, sql } from "drizzle-orm";
import { resetDb, seedBook, seedPack, seedUser, testDb } from "./_helpers";
import type { Database } from "@/db/client";
import { books, packBooks, packs } from "@/db/schema";
import { toAuthorsNeedle } from "@/db/authors";

/**
 * Schema-level guarantees that only the database can answer.
 *
 * Three partial indexes survived the migration to SQLite, and a partial index
 * is exactly the kind of thing that looks fine in a schema file and silently
 * does nothing — or rejects a statement outright, as the malformed
 * `ON CONFLICT ... WHERE` did. Each one below is asserted by its behaviour
 * rather than by its presence in sqlite_master.
 */

let db: Database;

/**
 * Assert a database constraint fired.
 *
 * Drizzle wraps driver errors as `Failed query: <sql>` and hides the real
 * message on `.cause`, so matching the thrown error's own message would pass
 * for ANY query failure — including a typo in the test's own SQL. Walking the
 * cause chain is what makes this assert the constraint rather than merely
 * asserting that something went wrong.
 */
async function expectConstraint(
  op: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let thrown: unknown;
  try {
    await op;
  } catch (err) {
    thrown = err;
  }
  expect(thrown, "expected the statement to be rejected").toBeDefined();

  const messages: Array<string> = [];
  let cursor: unknown = thrown;
  while (cursor instanceof Error) {
    messages.push(cursor.message);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  expect(
    messages.join(" | "),
    `no message in the cause chain matched ${String(pattern)}`,
  ).toMatch(pattern);
}

beforeEach(async () => {
  db = testDb();
  await resetDb();
});

describe("pack slug uniqueness (two partial unique indexes)", () => {
  it("scopes user pack slugs per creator", async () => {
    await seedUser(db, { id: "creator-a" });
    await seedUser(db, { id: "creator-b" });

    await seedPack(db, { id: "a1", slug: "my-pack", creatorId: "creator-a" });
    // Different creator, same slug: allowed. `packs_creator_slug_uq` is
    // (creator_id, slug) WHERE creator_id IS NOT NULL.
    await expect(
      seedPack(db, { id: "b1", slug: "my-pack", creatorId: "creator-b" }),
    ).resolves.toBeDefined();

    // Same creator, same slug: rejected.
    await expectConstraint(
      seedPack(db, { id: "a2", slug: "my-pack", creatorId: "creator-a" }),
      /UNIQUE constraint failed/,
    );
  });

  it("keeps the editorial namespace globally unique", async () => {
    // `packs_editorial_slug_uq` is (slug) WHERE creator_id IS NULL. Without
    // the partial index this could not work at all: SQL treats NULLs as
    // distinct, so an ordinary unique on (creator_id, slug) would happily
    // allow two editorial packs with the same slug.
    await seedPack(db, { id: "e1", slug: "starter", creatorId: null });
    await expectConstraint(
      seedPack(db, { id: "e2", slug: "starter", creatorId: null }),
      /UNIQUE constraint failed/,
    );
  });

  it("lets an editorial and a user pack share a slug", async () => {
    await seedUser(db, { id: "creator-a" });
    await seedPack(db, { id: "e1", slug: "shared", creatorId: null });
    await expect(
      seedPack(db, { id: "u1", slug: "shared", creatorId: "creator-a" }),
    ).resolves.toBeDefined();
    // The two indexes cover disjoint row sets, so neither sees the other.
    expect(await db.select().from(packs)).toHaveLength(2);
  });
});

describe("soft-deleted books", () => {
  it("excludes tombstoned rows from live listings", async () => {
    await seedBook(db, { id: "live", title: "Live Book" });
    await seedBook(db, { id: "dead", title: "Dead Book" });
    await db
      .update(books)
      .set({ deletedAt: new Date() })
      .where(eq(books.id, "dead"));

    // The predicate `books_live_created_idx` is built on. Every
    // catalog-facing query filters this way.
    const live = await db
      .select({ id: books.id })
      .from(books)
      .where(isNull(books.deletedAt))
      .orderBy(desc(books.createdAt));

    expect(live.map((b) => b.id)).toEqual(["live"]);
    // Both rows still exist — soft delete, so existing references survive.
    expect(await db.select().from(books)).toHaveLength(2);
  });

  it("restores by clearing the tombstone", async () => {
    await seedBook(db, { id: "b1", title: "Book" });
    await db
      .update(books)
      .set({ deletedAt: new Date() })
      .where(eq(books.id, "b1"));
    await db.update(books).set({ deletedAt: null }).where(eq(books.id, "b1"));

    const live = await db.select().from(books).where(isNull(books.deletedAt));
    expect(live).toHaveLength(1);
  });

  it("still dedupes ingest on a soft-deleted hardcover_id", async () => {
    // Ingest dedup deliberately does NOT filter on deleted_at: re-ingesting
    // a tombstoned book must revive the row in place, not collide with the
    // unique constraint.
    await seedBook(db, { id: "b1", title: "Book" });
    const [row] = await db.select().from(books).where(eq(books.id, "b1"));
    await db
      .update(books)
      .set({ deletedAt: new Date() })
      .where(eq(books.id, "b1"));

    const found = await db
      .select({ id: books.id })
      .from(books)
      .where(eq(books.hardcoverId, row.hardcoverId));
    expect(found.map((f) => f.id)).toEqual(["b1"]);
  });
});

describe("admin catalog search and sort", () => {
  it("matches on title or author, live rows only", async () => {
    await seedBook(db, {
      id: "b1",
      title: "Piranesi",
      authors: ["Susanna Clarke"],
    });
    await seedBook(db, {
      id: "b2",
      title: "Clarke's Other Book",
      authors: ["Arthur C. Clarke"],
    });
    await seedBook(db, { id: "b3", title: "Unrelated", authors: ["Someone"] });
    await db
      .update(books)
      .set({ deletedAt: new Date() })
      .where(eq(books.id, "b2"));

    const search = "clarke";
    const hits = await db
      .select({ id: books.id })
      .from(books)
      .where(
        and(
          sql`(${like(books.title, `%${search}%`)} OR ${like(books.authorsText, `%${toAuthorsNeedle(search)}%`)})`,
          isNull(books.deletedAt),
        ),
      );

    // b1 matches on author, b2 matches on both but is tombstoned, b3 not at all.
    expect(hits.map((h) => h.id)).toEqual(["b1"]);
  });

  it("sorts by first author with empty-author rows last", async () => {
    await seedBook(db, { id: "z", title: "Z", authors: ["Zadie Smith"] });
    await seedBook(db, { id: "a", title: "A", authors: ["Ann Leckie"] });
    await seedBook(db, { id: "none", title: "N", authors: [] });

    const rows = await db
      .select({ id: books.id })
      .from(books)
      .orderBy(
        sql`json_extract(${books.authors}, '$[0]') asc nulls last, ${books.id} asc`,
      );

    // NULLS LAST needs SQLite 3.30+; asserting it rather than assuming D1's
    // version is new enough.
    expect(rows.map((r) => r.id)).toEqual(["a", "z", "none"]);
  });
});

describe("pack membership", () => {
  it("is idempotent on the composite primary key", async () => {
    await seedPack(db, { id: "p1", slug: "p1", creatorId: null });
    await seedBook(db, { id: "b1", title: "Book" });

    for (let i = 0; i < 2; i++) {
      await db
        .insert(packBooks)
        .values({ packId: "p1", bookId: "b1", position: i })
        .onConflictDoNothing({
          target: [packBooks.packId, packBooks.bookId],
        });
    }

    const rows = await db.select().from(packBooks);
    expect(rows).toHaveLength(1);
    // do-nothing, so the original position survives.
    expect(rows[0].position).toBe(0);
  });

  it("refuses to drop a book that a pack still references", async () => {
    await seedPack(db, { id: "p1", slug: "p1", creatorId: null });
    await seedBook(db, { id: "b1", title: "Book" });
    await db.insert(packBooks).values({ packId: "p1", bookId: "b1" });

    // pack_books.book_id is ON DELETE RESTRICT — this is why books are
    // soft-deleted rather than removed.
    await expectConstraint(
      db.delete(books).where(eq(books.id, "b1")),
      /FOREIGN KEY constraint failed/,
    );
  });

  it("cascades membership away when the pack itself is deleted", async () => {
    await seedPack(db, { id: "p1", slug: "p1", creatorId: null });
    await seedBook(db, { id: "b1", title: "Book" });
    await db.insert(packBooks).values({ packId: "p1", bookId: "b1" });

    await db.delete(packs).where(eq(packs.id, "p1"));

    // pack_books.pack_id is ON DELETE CASCADE.
    expect(await db.select().from(packBooks)).toHaveLength(0);
    // The book survives — only the membership went.
    expect(await db.select().from(books)).toHaveLength(1);
  });
});
