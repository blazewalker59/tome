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
import { grantShards, spendShards } from "@/lib/economy/ledger";
import { shardBalances, shardEvents } from "@/db/schema";

/**
 * The shard ledger, executed against a real D1.
 *
 * These are the tests that would have caught the "Save failed" bug. The unit
 * suite covers the same functions against a fake, which is fine for branch
 * logic but structurally cannot catch a statement that builds correctly and
 * fails at execution — which is exactly what shipped.
 */

let db: Database;

async function balanceOf(userId: string): Promise<number | null> {
  const [row] = await db
    .select({ shards: shardBalances.shards })
    .from(shardBalances)
    .where(eq(shardBalances.userId, userId));
  return row?.shards ?? null;
}

async function ledgerSum(userId: string): Promise<number> {
  const rows = await db
    .select({ delta: shardEvents.delta })
    .from(shardEvents)
    .where(eq(shardEvents.userId, userId));
  return rows.reduce((n, r) => n + r.delta, 0);
}

async function eventCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: shardEvents.id })
    .from(shardEvents)
    .where(eq(shardEvents.userId, userId));
  return rows.length;
}

beforeEach(async () => {
  db = testDb();
  await resetDb();
  // `shard_events.ref_pack_id` / `ref_book_id` are real foreign keys, so the
  // rows a ledger entry points at have to exist. Seeding them here rather
  // than passing null refs keeps the tests on the same code path production
  // uses, FK enforcement included.
  await seedPack(db, { id: "pack-1", slug: "pack-1" });
  await seedPack(db, { id: "pack-2", slug: "pack-2" });
  await seedBook(db, { id: "book-1", title: "Book One" });
  await seedBook(db, { id: "book-2", title: "Book Two" });
});

describe("spendShards", () => {
  it("executes its batch at all", async () => {
    // The regression test, stated plainly. The shipped version built its
    // conditional insert with `db.run(sql`...`)`, which drizzle's batch cannot
    // prepare — every call threw "Cannot read properties of undefined
    // (reading 'bind')". Nothing about the SQL or the types was wrong; only
    // running it revealed the problem.
    await seedUser(db, { shards: 100 });
    await expect(
      spendShards(db, USER_ID, 50, { packId: "pack-1" }),
    ).resolves.toMatchObject({ applied: true });
  });

  it("debits the balance and records the event together", async () => {
    await seedUser(db, { shards: 100 });

    const res = await spendShards(db, USER_ID, 50, { packId: "pack-1" });

    expect(res.applied).toBe(true);
    expect(res.delta).toBe(-50);
    expect(res.newBalance).toBe(50);
    expect(await balanceOf(USER_ID)).toBe(50);
    // The cache and the ledger must agree — the ledger is the source of truth.
    expect(await ledgerSum(USER_ID)).toBe(-50);
    expect(await eventCount(USER_ID)).toBe(1);
  });

  it("refuses when short, and writes NOTHING", async () => {
    await seedUser(db, { shards: 10 });

    const res = await spendShards(db, USER_ID, 50, { packId: "pack-1" });

    expect(res.applied).toBe(false);
    expect(res.reason).toBe("insufficient_shards");
    expect(res.newBalance).toBe(10);
    // Both halves of the batch carry the same affordability predicate, so a
    // refusal must leave no ledger row behind and no balance change.
    expect(await eventCount(USER_ID)).toBe(0);
    expect(await balanceOf(USER_ID)).toBe(10);
  });

  it("treats a missing balance row as zero", async () => {
    await seedUser(db); // no shard_balances row at all

    const res = await spendShards(db, USER_ID, 1);

    expect(res.applied).toBe(false);
    expect(res.reason).toBe("insufficient_shards");
    expect(res.newBalance).toBe(0);
    expect(await eventCount(USER_ID)).toBe(0);
  });

  it("cannot be driven negative by repeated spends", async () => {
    // The property the old `SELECT ... FOR UPDATE` existed to provide, now
    // carried by the compare-and-swap. Four spends of 30 against 100 must
    // yield three successes and one refusal — never a negative balance.
    await seedUser(db, { shards: 100 });

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await spendShards(db, USER_ID, 30, { packId: "pack-1" }));
    }

    expect(results.filter((r) => r.applied)).toHaveLength(3);
    expect(results.filter((r) => !r.applied)).toHaveLength(1);
    expect(await balanceOf(USER_ID)).toBe(10);
    expect(await ledgerSum(USER_ID)).toBe(-90);
  });

  it("holds the floor under concurrent spends", async () => {
    // Same invariant, but issued together rather than in sequence. Whatever
    // interleaving D1 chooses, the balance must never go below zero and the
    // ledger must equal the cache.
    await seedUser(db, { shards: 100 });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        spendShards(db, USER_ID, 30, { packId: "pack-1" }),
      ),
    );

    const applied = results.filter((r) => r.applied).length;
    expect(applied).toBeLessThanOrEqual(3);
    const balance = await balanceOf(USER_ID);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(balance).toBe(100 - applied * 30);
    expect(await ledgerSum(USER_ID)).toBe(-applied * 30);
    expect(await eventCount(USER_ID)).toBe(applied);
  });
});

describe("grantShards", () => {
  it("writes the event and rebuilds the balance from the ledger", async () => {
    await seedUser(db);

    const res = await grantShards(db, USER_ID, "welcome_grant", 200);

    expect(res.applied).toBe(true);
    expect(res.newBalance).toBe(200);
    expect(await balanceOf(USER_ID)).toBe(200);
    expect(await ledgerSum(USER_ID)).toBe(200);
  });

  it("enforces once-per-book via the partial unique index", async () => {
    // start_reading is covered by `shard_events_once_per_book_uq`, a PARTIAL
    // unique index. Whether SQLite matches an ON CONFLICT target against a
    // partial index is precisely the kind of thing a fake cannot answer.
    await seedUser(db);

    const first = await grantShards(db, USER_ID, "start_reading", 5, {
      bookId: "book-1",
    });
    const second = await grantShards(db, USER_ID, "start_reading", 5, {
      bookId: "book-1",
    });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.reason).toBe("already_granted_for_book");
    // The second grant must not have inflated the balance.
    expect(second.newBalance).toBe(5);
    expect(await eventCount(USER_ID)).toBe(1);
    expect(await ledgerSum(USER_ID)).toBe(5);
  });

  it("allows the same reason for a different book", async () => {
    await seedUser(db);
    await grantShards(db, USER_ID, "start_reading", 5, { bookId: "book-1" });
    const other = await grantShards(db, USER_ID, "start_reading", 5, {
      bookId: "book-2",
    });
    expect(other.applied).toBe(true);
    expect(await ledgerSum(USER_ID)).toBe(10);
  });

  it("repeats uncovered reasons — two dupes of one book both refund", async () => {
    // dupe_refund is deliberately OUTSIDE the partial index, so a rip that
    // pulls the same book twice credits two separate refunds. Attaching a
    // conflict target to this reason would be an error at the database level.
    await seedUser(db);

    const a = await grantShards(db, USER_ID, "dupe_refund", 5, {
      bookId: "book-1",
    });
    const b = await grantShards(db, USER_ID, "dupe_refund", 5, {
      bookId: "book-1",
    });

    expect(a.applied).toBe(true);
    expect(b.applied).toBe(true);
    expect(await eventCount(USER_ID)).toBe(2);
    expect(await ledgerSum(USER_ID)).toBe(10);
  });

  it("self-heals a balance cache that has drifted from the ledger", async () => {
    // The property that made the Neon migration's +162 reconciliation safe:
    // because the cache is recomputed as SUM(delta) rather than incremented,
    // a wrong cached value is corrected by the next write instead of
    // compounding.
    await seedUser(db, { shards: 9999 }); // deliberately wrong
    await grantShards(db, USER_ID, "welcome_grant", 200);

    expect(await balanceOf(USER_ID)).toBe(200);
    expect(await ledgerSum(USER_ID)).toBe(200);
  });

  it("rejects non-positive amounts before touching the database", async () => {
    await seedUser(db);
    await expect(grantShards(db, USER_ID, "welcome_grant", 0)).rejects.toThrow(
      /amount must be positive/,
    );
    expect(await eventCount(USER_ID)).toBe(0);
  });
});

describe("grant and spend together", () => {
  it("keeps the cache equal to the ledger across a mixed sequence", async () => {
    await seedUser(db);

    await grantShards(db, USER_ID, "welcome_grant", 200);
    await spendShards(db, USER_ID, 50, { packId: "pack-1" });
    await grantShards(db, USER_ID, "dupe_refund", 5, { bookId: "book-1" });
    await grantShards(db, USER_ID, "dupe_refund", 5, { bookId: "book-2" });
    await spendShards(db, USER_ID, 50, { packId: "pack-2" });

    // 200 - 50 + 5 + 5 - 50
    expect(await ledgerSum(USER_ID)).toBe(110);
    expect(await balanceOf(USER_ID)).toBe(110);
  });
});
