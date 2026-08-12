import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { Db } from "@/lib/economy/ledger";
import type * as EconomyConfig from "@/lib/economy/config";
import {
  grantShards,
  rebuildBalanceStatement,
  spendShards,
} from "@/lib/economy/ledger";

/**
 * Guards the one invariant that shipped a production bug: every statement
 * handed to `db.batch()` must survive drizzle's batch preparation.
 *
 * The bug: `spendShards` built its conditional insert with
 * `db.run(sql\`...\`)`. That type-checks — `SQLiteRaw` implements
 * `RunnableQuery<'sqlite'>`, so it is a legal `BatchItem` — and it executes
 * correctly on its own. It only fails *inside a batch*, because
 * drizzle-orm/d1's batch does:
 *
 *     const prepared = query._prepare();
 *     if (prepared.getQuery().params.length > 0)
 *       builtQueries.push(prepared.stmt.bind(...params));
 *
 * and `SQLiteRaw._prepare()` returns `this`, which has no `.stmt`. Any raw
 * statement with bind params therefore throws "Cannot read properties of
 * undefined (reading 'bind')" — and every rip failed with "Save failed".
 *
 * Nothing caught it: types passed, the SQL was verified by hand against D1,
 * and the ledger unit tests use a fake `db` whose `batch()` accepts anything.
 * So this test deliberately reaches into drizzle's internals and replays the
 * exact branch above against a REAL drizzle instance. Coupling to an internal
 * is the point — that internal is the contract that broke.
 */

// `grantShards` runs its cap check before branching, and that reads the
// economy config through `getDb()` — which throws off-Worker. Pin the config
// so these tests exercise statement construction, not config loading.
vi.mock("@/lib/economy/config", async (orig) => {
  const actual = (await orig()) as typeof EconomyConfig;
  return { ...actual, getEconomy: async () => actual.DEFAULTS };
});

/**
 * Asserts a statement will survive drizzle's batch preparation.
 *
 * The check is `_prepare()` must return something OTHER than the statement
 * itself. A normal query builder delegates to `session.prepareQuery()`, which
 * returns a driver-specific prepared query — and under D1 that object carries
 * the `.stmt` that `batch()` calls `.bind()` on. `SQLiteRaw` instead returns
 * `this`, never touching the session, so it reaches `batch()` with no `.stmt`.
 *
 * Testing identity rather than `.stmt` directly keeps this driver-agnostic:
 * `.stmt` only exists on D1's prepared query, so a test running against any
 * other driver would see it undefined everywhere and prove nothing.
 */
function assertBatchable(statement: unknown, label: string): void {
  const stmt = statement as {
    _prepare: () => { getQuery: () => { params: Array<unknown> } };
  };
  const prepared = stmt._prepare();

  expect(
    typeof prepared.getQuery,
    `${label}: statement is not preparable at all`,
  ).toBe("function");

  const { params } = prepared.getQuery();
  if (params.length > 0) {
    expect(
      prepared,
      `${label}: has ${params.length} bind param(s) and _prepare() returned ` +
        `the statement itself — that is a SQLiteRaw from db.run(sql\`...\`), ` +
        `which never goes through the session and so reaches db.batch() with ` +
        `no .stmt. Batching it throws "Cannot read properties of undefined ` +
        `(reading 'bind')". Use a query builder (e.g. insert().select()).`,
    ).not.toBe(stmt);
  }
}

/**
 * A drizzle instance over a no-op driver. Real enough to build and render
 * statements — which is all the batch-preparation path touches — without
 * needing a live D1 binding.
 */
function makeRealDrizzle(): Db {
  return drizzle(async () => ({ rows: [] })) as unknown as Db;
}

describe("statements passed to db.batch() are batchable", () => {
  it("spendShards: the conditional insert and the CAS debit", async () => {
    const db = makeRealDrizzle();
    const batched: Array<unknown> = [];

    // Intercept the batch instead of executing it, then check each statement
    // the way drizzle's own batch() would.
    (db as unknown as { batch: unknown }).batch = async (
      statements: Array<unknown>,
    ) => {
      batched.push(...statements);
      return [{ success: true }, []];
    };

    await spendShards(db, "user-1", 50, { packId: "pack-1" });

    expect(batched).toHaveLength(2);
    assertBatchable(batched[0], "spendShards conditional insert");
    assertBatchable(batched[1], "spendShards CAS debit");
  });

  it("grantShards: the event insert and the balance rebuild", async () => {
    const db = makeRealDrizzle();
    const batched: Array<unknown> = [];

    (db as unknown as { batch: unknown }).batch = async (
      statements: Array<unknown>,
    ) => {
      batched.push(...statements);
      return [[{ id: "evt-1" }], [{ shards: 10 }]];
    };

    // welcome_grant is uncapped, so this takes the plain-insert path without
    // needing the cap-check read to resolve against a real database.
    await grantShards(db, "user-1", "welcome_grant", 10);

    expect(batched).toHaveLength(2);
    assertBatchable(batched[0], "grantShards event insert");
    assertBatchable(batched[1], "grantShards balance rebuild");
  });

  it("grantShards: the index-covered insert with a conflict target", async () => {
    // start_reading targets the partial unique index, a different insert
    // shape from the plain path above.
    const db = makeRealDrizzle();
    const batched: Array<unknown> = [];

    (db as unknown as { batch: unknown }).batch = async (
      statements: Array<unknown>,
    ) => {
      batched.push(...statements);
      return [[{ id: "evt-1" }], [{ shards: 10 }]];
    };

    await grantShards(db, "user-1", "start_reading", 5, { bookId: "book-1" });

    expect(batched).toHaveLength(2);
    assertBatchable(batched[0], "grantShards onConflictDoNothing insert");
    assertBatchable(batched[1], "grantShards balance rebuild");
  });

  it("rebuildBalanceStatement, which recordRipFn appends to its own batch", () => {
    assertBatchable(
      rebuildBalanceStatement(makeRealDrizzle(), "user-1"),
      "rebuildBalanceStatement",
    );
  });
});
