import { describe, expect, it, vi } from "vitest";

/**
 * Ledger helper tests.
 *
 * These exercise the lightweight guards and branching logic that
 * don't require a real Drizzle transaction — input validation,
 * positive-amount checks, and the "already granted" / "insufficient
 * funds" early-return shapes. The deeper integration (SQL emitted,
 * partial-unique-index behaviour, FOR UPDATE row locks) is covered
 * by the Postgres engine itself and is not reproducible in a pure
 * unit test; adding a fake that mirrors all of Drizzle's builder
 * chain would drift from reality faster than it would catch bugs.
 */

// Fake tx that returns configurable results via per-test overrides.
// Builder chains return `this` until a terminal method resolves with
// whatever the test put into the matching `result` slot. Keep this
// minimal — only the paths we actually traverse need to exist.
interface FakeTxOverrides {
  grantInsertReturning?: Array<{ id: string }>;
  grantBalanceReturning?: Array<{ shards: number }>;
  spendLockedRows?: Array<{ shards: number }>;
  spendBalanceReturning?: Array<{ shards: number }>;
  capCountRows?: Array<{ count: number }>;
  readBalanceRows?: Array<{ shards: number }>;
}

function makeTx(o: FakeTxOverrides = {}) {
  const tx: any = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => o.grantInsertReturning ?? [{ id: "evt-1" }],
        }),
        onConflictDoUpdate: () => ({
          returning: async () => o.grantBalanceReturning ?? [{ shards: 0 }],
        }),
        // Non-conflict insert path (uncovered reasons like
        // welcome_grant / dupe_refund). Returns the same stub array
        // as the conflict path so tests can control both via
        // `grantInsertReturning`.
        returning: async () => o.grantInsertReturning ?? [{ id: "evt-1" }],
        // Plain `values()` returning a thenable for spend's insert-only path.
        then: (fn: (v: unknown) => unknown) => Promise.resolve(fn(undefined)),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => o.spendBalanceReturning ?? [{ shards: 0 }],
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          // `.limit()` for readBalance; plain await for cap count
          limit: async () => o.readBalanceRows ?? [{ shards: 0 }],
          then: (fn: (v: unknown) => unknown) =>
            Promise.resolve(fn(o.capCountRows ?? [{ count: 0 }])),
        }),
      }),
    }),
    execute: async () => ({ rows: o.spendLockedRows ?? [] }),
  };
  return tx;
}

// Keep the economy config deterministic for cap-related tests.
vi.mock("@/lib/economy/config", async (orig) => {
  const actual = (await orig()) as typeof import("@/lib/economy/config");
  return {
    ...actual,
    getEconomy: async () => actual.DEFAULTS,
  };
});

// Schema import resolves column references inside the builder chain;
// the fake tx ignores them, so this mock just needs to be importable.
vi.mock("@/db/schema", () => ({
  shardBalances: { userId: "user_id", shards: "shards", updatedAt: "updated_at" },
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

import { grantShards, spendShards } from "@/lib/economy/ledger";

describe("grantShards", () => {
  it("throws when amount is zero or negative", async () => {
    const tx = makeTx();
    await expect(grantShards(tx, "u1", "welcome_grant", 0)).rejects.toThrow(
      /amount must be positive/,
    );
    await expect(grantShards(tx, "u1", "welcome_grant", -5)).rejects.toThrow(
      /amount must be positive/,
    );
  });

  it("reports already-granted when the index-covered insert returns zero rows", async () => {
    // Only start_reading / finish_reading are covered by the partial
    // unique index on shard_events — those are the reasons that can
    // come back "already granted" via onConflictDoNothing.
    const tx = makeTx({
      grantInsertReturning: [], // conflict-do-nothing → no inserted row
      capCountRows: [{ count: 0 }], // under the daily cap
      readBalanceRows: [{ shards: 42 }],
    });
    const res = await grantShards(tx, "u1", "start_reading", 5, { bookId: "b1" });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("already_granted_for_book");
    expect(res.newBalance).toBe(42);
    expect(res.delta).toBe(0);
  });

  it("inserts uncovered reasons without a conflict target (repeatable grants)", async () => {
    // dupe_refund isn't part of the partial unique index. A second
    // grant for the same (user, reason, book) must insert cleanly
    // rather than erroring — that's what lets a rip with two copies
    // of the same book credit two separate refunds.
    const tx = makeTx({
      grantInsertReturning: [{ id: "evt-2" }],
      grantBalanceReturning: [{ shards: 55 }],
    });
    const res = await grantShards(tx, "u1", "dupe_refund", 5, {
      bookId: "b1",
      ripId: "r1",
    });
    expect(res.applied).toBe(true);
    expect(res.delta).toBe(5);
    expect(res.newBalance).toBe(55);
  });

  it("applies the grant and returns the new balance when the insert succeeds", async () => {
    const tx = makeTx({
      grantInsertReturning: [{ id: "evt-1" }],
      grantBalanceReturning: [{ shards: 250 }],
    });
    const res = await grantShards(tx, "u1", "welcome_grant", 200);
    expect(res.applied).toBe(true);
    expect(res.delta).toBe(200);
    expect(res.newBalance).toBe(250);
  });
});

describe("spendShards", () => {
  it("throws when amount is zero or negative", async () => {
    const tx = makeTx();
    await expect(spendShards(tx, "u1", 0)).rejects.toThrow(/amount must be positive/);
    await expect(spendShards(tx, "u1", -10)).rejects.toThrow(/amount must be positive/);
  });

  it("refuses the spend when the locked balance is below the amount", async () => {
    const tx = makeTx({ spendLockedRows: [{ shards: 10 }] });
    const res = await spendShards(tx, "u1", 50);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("insufficient_shards");
    expect(res.newBalance).toBe(10);
  });

  it("treats a missing balance row as zero shards", async () => {
    const tx = makeTx({ spendLockedRows: [] });
    const res = await spendShards(tx, "u1", 1);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("insufficient_shards");
    expect(res.newBalance).toBe(0);
  });

  it("applies the debit when the user can afford it", async () => {
    const tx = makeTx({
      spendLockedRows: [{ shards: 100 }],
      spendBalanceReturning: [{ shards: 50 }],
    });
    const res = await spendShards(tx, "u1", 50);
    expect(res.applied).toBe(true);
    expect(res.delta).toBe(-50);
    expect(res.newBalance).toBe(50);
  });
});
