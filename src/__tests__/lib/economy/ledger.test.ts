import { describe, expect, it, vi } from "vitest";

import type * as EconomyConfig from "@/lib/economy/config";
import { grantShards, spendShards } from "@/lib/economy/ledger";

/**
 * Ledger helper tests.
 *
 * These exercise the branching logic that doesn't need a real database:
 * input validation, the cap / already-granted / insufficient-funds early
 * returns, and — since the move to D1 — the shape of the write batch.
 *
 * That last one is worth asserting even against a fake. On Postgres the
 * atomicity came from an enclosing transaction, so a test could only have
 * checked it by running real SQL. On D1 atomicity comes from the statements
 * being handed to `db.batch()` in one call, which IS observable here: if a
 * future edit moves a write out of the batch, the count assertions fail.
 * What a fake still cannot tell us is whether the SQL itself is right —
 * that's what the migration's live verification covers.
 */

// Fake D1 client. The real one returns opaque statement builders that only
// mean anything once `batch()` executes them, so the fake returns sentinels
// and lets each test declare what `batch()` should resolve to.
interface FakeDbOverrides {
  /** Results array returned by `db.batch(...)`. */
  batchResults?: Array<unknown>;
  /** Rows for the `.limit()`-terminated select (readBalance). */
  readBalanceRows?: Array<{ shards: number }>;
  /** Rows for the awaited select (countEventsSince). */
  capCountRows?: Array<{ count: number }>;
}

function makeDb(o: FakeDbOverrides = {}) {
  const batchCalls: Array<Array<unknown>> = [];

  const statement = (kind: string) => ({ __statement: kind });

  const db: any = {
    insert: () => ({
      // `insert().select(...)` is spendShards' conditional insert. It is built
      // with the query builder rather than `db.run(sql\`...\`)` because a raw
      // statement cannot be batched — see batchable.test.ts.
      select: () => statement("insert.select"),
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => statement("insert.onConflictDoNothing"),
        }),
        onConflictDoUpdate: () => ({
          returning: () => statement("insert.onConflictDoUpdate"),
        }),
        returning: () => statement("insert.returning"),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => statement("update.returning"),
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          // `.limit()` terminates readBalance; a bare await terminates the
          // cap count.
          limit: async () => o.readBalanceRows ?? [{ shards: 0 }],
          then: (fn: (v: unknown) => unknown) =>
            Promise.resolve(fn(o.capCountRows ?? [{ count: 0 }])),
        }),
      }),
    }),
    run: () => statement("run"),
    batch: async (statements: Array<unknown>) => {
      batchCalls.push(statements);
      return o.batchResults ?? [[], []];
    },
  };

  return { db, batchCalls };
}

// Keep the economy config deterministic for cap-related tests.
vi.mock("@/lib/economy/config", async (orig) => {
  const actual = (await orig()) as typeof EconomyConfig;
  return {
    ...actual,
    getEconomy: async () => actual.DEFAULTS,
  };
});

// Schema import resolves column references inside the builder chain;
// the fake ignores them, so this mock just needs to be importable.
vi.mock("@/db/schema", () => ({
  shardBalances: {
    userId: "user_id",
    shards: "shards",
    updatedAt: "updated_at",
  },
  shardEvents: {
    id: "id",
    userId: "user_id",
    delta: "delta",
    reason: "reason",
    refBookId: "ref_book_id",
    refPackId: "ref_pack_id",
    refRipId: "ref_rip_id",
    createdAt: "created_at",
  },
}));

vi.mock("@/db/client", () => ({ getDb: async () => ({}) }));

describe("grantShards", () => {
  it("throws when amount is zero or negative", async () => {
    const { db } = makeDb();
    await expect(grantShards(db, "u1", "welcome_grant", 0)).rejects.toThrow(
      /amount must be positive/,
    );
    await expect(grantShards(db, "u1", "welcome_grant", -5)).rejects.toThrow(
      /amount must be positive/,
    );
  });

  it("reports already-granted when the index-covered insert returns zero rows", async () => {
    // Only start_reading / finish_reading are covered by the partial
    // unique index on shard_events — those are the reasons that can
    // come back "already granted" via onConflictDoNothing.
    const { db } = makeDb({
      // [insertResult, balanceResult]: no inserted row, balance unchanged.
      batchResults: [[], [{ shards: 42 }]],
      capCountRows: [{ count: 0 }], // under the daily cap
    });
    const res = await grantShards(db, "u1", "start_reading", 5, {
      bookId: "b1",
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("already_granted_for_book");
    expect(res.delta).toBe(0);
    // Balance still comes from the ledger rebuild, not from a stale read.
    expect(res.newBalance).toBe(42);
  });

  it("inserts uncovered reasons without a conflict target (repeatable grants)", async () => {
    // dupe_refund isn't part of the partial unique index. A second
    // grant for the same (user, reason, book) must insert cleanly
    // rather than erroring — that's what lets a rip with two copies
    // of the same book credit two separate refunds.
    const { db } = makeDb({
      batchResults: [[{ id: "evt-2" }], [{ shards: 55 }]],
    });
    const res = await grantShards(db, "u1", "dupe_refund", 5, {
      bookId: "b1",
      ripId: "r1",
    });
    expect(res.applied).toBe(true);
    expect(res.delta).toBe(5);
    expect(res.newBalance).toBe(55);
  });

  it("applies the grant and returns the rebuilt balance", async () => {
    const { db } = makeDb({
      batchResults: [[{ id: "evt-1" }], [{ shards: 250 }]],
    });
    const res = await grantShards(db, "u1", "welcome_grant", 200);
    expect(res.applied).toBe(true);
    expect(res.delta).toBe(200);
    expect(res.newBalance).toBe(250);
  });

  it("reports cap_reached without writing anything", async () => {
    const { db, batchCalls } = makeDb({
      // DEFAULTS caps start_reading at 5/day; report the cap as hit.
      capCountRows: [{ count: 999 }],
      readBalanceRows: [{ shards: 17 }],
    });
    const res = await grantShards(db, "u1", "start_reading", 5, {
      bookId: "b1",
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("cap_reached");
    expect(res.newBalance).toBe(17);
    // The whole point of checking the cap first: no batch is issued at all.
    expect(batchCalls).toHaveLength(0);
  });

  it("writes the event and the balance refresh in ONE batch", async () => {
    const { db, batchCalls } = makeDb({
      batchResults: [[{ id: "evt-1" }], [{ shards: 10 }]],
    });
    await grantShards(db, "u1", "welcome_grant", 10);
    expect(batchCalls).toHaveLength(1);
    // Ledger insert + balance rebuild, atomically, in that order.
    expect(batchCalls[0]).toHaveLength(2);
  });
});

describe("spendShards", () => {
  it("throws when amount is zero or negative", async () => {
    const { db } = makeDb();
    await expect(spendShards(db, "u1", 0)).rejects.toThrow(
      /amount must be positive/,
    );
    await expect(spendShards(db, "u1", -10)).rejects.toThrow(
      /amount must be positive/,
    );
  });

  it("refuses the spend when the compare-and-swap debit matches no row", async () => {
    // The CAS `WHERE shards >= amount` didn't match, so the update returns
    // no rows. The conditional insert carried the same predicate, so nothing
    // was written either.
    const { db } = makeDb({
      batchResults: [{ success: true }, []],
      readBalanceRows: [{ shards: 10 }],
    });
    const res = await spendShards(db, "u1", 50);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("insufficient_shards");
    expect(res.newBalance).toBe(10);
  });

  it("treats a missing balance row as zero shards", async () => {
    const { db } = makeDb({
      batchResults: [{ success: true }, []],
      readBalanceRows: [],
    });
    const res = await spendShards(db, "u1", 1);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("insufficient_shards");
    expect(res.newBalance).toBe(0);
  });

  it("applies the debit when the user can afford it", async () => {
    const { db } = makeDb({
      batchResults: [{ success: true }, [{ shards: 50 }]],
    });
    const res = await spendShards(db, "u1", 50);
    expect(res.applied).toBe(true);
    expect(res.delta).toBe(-50);
    // Comes straight from the CAS update's RETURNING, so it reflects the
    // post-debit value the database actually committed.
    expect(res.newBalance).toBe(50);
  });

  it("pairs the conditional insert and the debit in ONE batch", async () => {
    const { db, batchCalls } = makeDb({
      batchResults: [{ success: true }, [{ shards: 50 }]],
    });
    await spendShards(db, "u1", 50);
    expect(batchCalls).toHaveLength(1);
    // Both statements must land together — if the insert ran outside the
    // batch a failed debit could still record a charge, and vice versa.
    expect(batchCalls[0]).toHaveLength(2);
  });
});
