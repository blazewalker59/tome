import { and, eq, gte, sql } from "drizzle-orm";
import { getEconomy } from "./config";
import type { Database } from "@/db/client";
import { shardBalances, shardEvents } from "@/db/schema";

/**
 * Shard ledger helpers.
 *
 * Every shard change — reading-transition grants, welcome grants, dupe
 * refunds, pack-rip debits — flows through one of the functions in this file.
 * The contract:
 *
 *   - Inserts a `shard_events` row (the source of truth).
 *   - Brings `shard_balances` in line (the cache).
 *
 * ── How this changed moving from Neon Postgres to Cloudflare D1 ──────────────
 *
 * The old design leaned on two Postgres features D1 does not have:
 *
 *   1. Interactive transactions. Callers passed in an open `tx` so a grant
 *      would roll back with whatever business write triggered it. D1 has no
 *      interactive transactions at all — `db.transaction()` on the D1 driver
 *      runs the callback with no BEGIN and gives no atomicity, which is worse
 *      than not having it, because it looks like it works.
 *
 *   2. `SELECT ... FOR UPDATE`. `spendShards` row-locked the balance so two
 *      concurrent rips couldn't both read "50 shards" and both spend. SQLite
 *      has no row locks.
 *
 * Both are replaced by `db.batch()`, which D1 executes as one atomic
 * transaction, plus compare-and-swap predicates that make each write safe
 * without a lock:
 *
 *   - `spendShards` debits with `WHERE shards >= amount` and treats
 *     "zero rows affected" as "couldn't afford it". Two concurrent rips
 *     serialize; the loser sees the post-debit balance and is refused. This
 *     is strictly better than the old lock — it cannot deadlock.
 *
 *   - `grantShards` recomputes the cached balance from the ledger
 *     (`SUM(delta)`) rather than applying a `+ amount` delta to it. That makes
 *     the balance statement idempotent and self-healing: if the event insert
 *     was a no-op (conflict), the recomputed sum is simply unchanged, so the
 *     two statements can be batched without the second needing to know what
 *     the first decided. Any historical drift is corrected on the next write.
 *
 * What is genuinely lost: a grant no longer rolls back with the caller's
 * business write, because there is no enclosing transaction to enlist in.
 * Callers that need the pair to be atomic must put both in one `db.batch()`.
 * See `recordRipFn` in src/server/collection.ts for how the rip flow does it.
 *
 * See CORE_LOOP_PLAN.md §1 for the economic reasoning and src/db/schema.ts
 * `shard_events` for the table + constraints.
 */

/**
 * The database handle. Was a Drizzle transaction object; now the plain D1
 * client, since there is nothing to enlist in.
 */
export type Db = Database;

/**
 * Enumerated reasons for a shard event. Kept as a union string literal
 * (not a DB enum) so new reasons don't require a migration; app-layer
 * validation keeps the set tight.
 */
export type ShardReason =
  | "welcome_grant"
  | "start_reading"
  | "finish_reading"
  | "dupe_refund"
  | "rip"
  /**
   * Reversal of a `rip` debit. Only written by `recordRipFn` when the rip's
   * write batch fails after the shards were already taken — see the
   * compensation note there. Never issued by normal play.
   */
  | "rip_refund"
  /**
   * One-time reconciliation written during the Neon -> D1 migration.
   *
   * The Neon data had `shard_balances` disagreeing with `SUM(shard_events)`
   * — 52 cached against a ledger summing to -110 for the only user. The
   * ledger was missing its `welcome_grant` row entirely, and rip audit rows
   * had been deleted by a collection reset while their debit events stayed.
   * Under the old code that drift was invisible, because the cache was
   * incremented rather than derived.
   *
   * It stops being invisible here: `grantShards` now rebuilds the cache from
   * the ledger, so the next grant would have yanked the balance from 52 to
   * roughly -110. Rather than carry a lie forward or silently reset someone's
   * currency, the migration writes one explicit event for the difference. The
   * balance the user sees is preserved and the ledger becomes the truth it
   * always claimed to be.
   *
   * Never written at runtime. See scripts/migrate-neon-to-d1.ts.
   */
  | "migration_adjustment";

export interface ShardEventRefs {
  bookId?: string;
  packId?: string;
  ripId?: string;
}

/**
 * The result returned from a successful grant or spend. Callers use
 * `newBalance` to surface "you have N shards" messaging and `applied`
 * to tell the user whether the grant actually landed (a capped grant
 * reports `applied: false, newBalance: <unchanged>`).
 */
export interface ShardChangeResult {
  applied: boolean;
  delta: number;
  newBalance: number;
  /**
   * Why the change was skipped, if it was. Only set when
   * `applied === false`. Caller can render a toast / no-op.
   */
  reason?: "cap_reached" | "already_granted_for_book" | "insufficient_shards";
}

/**
 * The balance cache, rebuilt from the ledger for one user.
 *
 * Deliberately a full `SUM(delta)` rather than an incremental `shards + N`.
 * It costs one indexed scan of that user's events (the
 * `shard_events_user_reason_created_idx` index leads with `user_id`), and in
 * exchange the cache can never drift from the ledger — which matters more now
 * that the two writes are no longer inside a transaction the caller controls.
 */
function balanceFromLedger(userId: string) {
  return sql<number>`(select coalesce(sum(${shardEvents.delta}), 0) from ${shardEvents} where ${shardEvents.userId} = ${userId})`;
}

/**
 * The "bring the balance cache in line with the ledger" statement, as a value
 * you can drop into a `db.batch([...])`.
 *
 * Exported because callers that write their own `shard_events` rows inside a
 * larger batch (currently `recordRipFn`, which inserts a run of dupe refunds)
 * need to close that batch by refreshing the cache — and must do it with the
 * same SQL this module uses, or the two would drift. Put it LAST in the batch:
 * it reads the ledger, so it has to run after every event insert in the batch.
 */
export function rebuildBalanceStatement(db: Db, userId: string) {
  return db
    .insert(shardBalances)
    .values({
      userId,
      shards: balanceFromLedger(userId),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: shardBalances.userId,
      set: { shards: balanceFromLedger(userId), updatedAt: new Date() },
    })
    .returning({ shards: shardBalances.shards });
}

/**
 * Writes a positive ledger entry + refreshes the balance cache. Idempotent
 * at the database level via the partial unique index on
 * (user_id, reason, ref_book_id) for start/finish transitions — calling
 * `grantShards` twice for the same (user, reason, book) returns
 * `applied: false, reason: 'already_granted_for_book'` rather than throwing.
 * Other reasons can be granted repeatedly.
 *
 * Cap enforcement: before the insert, we count the user's events of
 * this reason inside the current window (day for `start_reading`,
 * week for `finish_reading`) and skip if the cap is hit. Windows are
 * rolling — computed backwards from now, not from calendar boundaries —
 * to avoid the edge where a user is told they've hit their limit at
 * 11:59pm and has it reset one minute later.
 */
export async function grantShards(
  db: Db,
  userId: string,
  reason: ShardReason,
  amount: number,
  refs: ShardEventRefs = {},
): Promise<ShardChangeResult> {
  if (amount <= 0) {
    throw new Error(`grantShards: amount must be positive, got ${amount}`);
  }

  // Capacity check (reason-specific). Only start/finish have caps today;
  // welcome_grant and dupe_refund are uncapped because they're gated by
  // other means (once-at-signup, per-rip).
  const cap = await capCheck(db, userId, reason);
  if (cap && cap.used >= cap.limit) {
    const balance = await readBalance(db, userId);
    return {
      applied: false,
      delta: 0,
      newBalance: balance,
      reason: "cap_reached",
    };
  }

  // For reasons covered by the partial unique index on shard_events —
  // currently start_reading / finish_reading only — we target that index with
  // onConflictDoNothing so a second grant for the same (user, reason, book)
  // returns zero rows and we report it as already-granted. For uncovered
  // reasons (welcome_grant, dupe_refund, rip) a plain insert is correct:
  // they're allowed to repeat (one dupe_refund per dupe instance, say).
  //
  // Attaching the conflict target to a row the partial index doesn't cover is
  // an error on SQLite exactly as it was on Postgres ("ON CONFLICT clause does
  // not match any PRIMARY KEY or UNIQUE constraint"), which is why this
  // branches on the reason rather than always passing a target.
  const isIndexCovered =
    reason === "start_reading" || reason === "finish_reading";
  const insertValues = {
    userId,
    delta: amount,
    reason,
    refBookId: refs.bookId ?? null,
    refPackId: refs.packId ?? null,
    refRipId: refs.ripId ?? null,
  };

  const insertStatement = isIndexCovered
    ? db
        .insert(shardEvents)
        .values(insertValues)
        .onConflictDoNothing({
          target: [
            shardEvents.userId,
            shardEvents.reason,
            shardEvents.refBookId,
          ],
          // Repeat the partial index predicate so the planner can match the
          // conflict target to the right index. Must stay in sync with
          // `shard_events_once_per_book_uq` in src/db/schema.ts.
          where: sql`${shardEvents.reason} in ('start_reading', 'finish_reading')`,
        })
        .returning({ id: shardEvents.id })
    : db
        .insert(shardEvents)
        .values(insertValues)
        .returning({ id: shardEvents.id });

  // One atomic unit: append the event, then rebuild the cache from the
  // ledger. Because the second statement derives its value rather than
  // applying a delta, it is correct whether or not the first one inserted.
  const [inserted, balanceRows] = await db.batch([
    insertStatement,
    db
      .insert(shardBalances)
      .values({
        userId,
        shards: balanceFromLedger(userId),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: shardBalances.userId,
        set: { shards: balanceFromLedger(userId), updatedAt: new Date() },
      })
      .returning({ shards: shardBalances.shards }),
  ]);

  const newBalance = balanceRows[0]?.shards ?? 0;

  if (inserted.length === 0) {
    return {
      applied: false,
      delta: 0,
      newBalance,
      reason: "already_granted_for_book",
    };
  }

  return { applied: true, delta: amount, newBalance };
}

/**
 * Writes a negative ledger entry, refusing if the user can't afford the cost.
 * Used for pack rips.
 *
 * The affordability check is a compare-and-swap, not a read-then-write: the
 * `WHERE shards >= amount` predicate is evaluated by the database at write
 * time, inside the batch's transaction. Two concurrent rips therefore
 * serialize — whichever lands second re-evaluates against the already-debited
 * balance and is refused — with no row lock and no chance of driving the
 * balance negative.
 *
 * Both statements carry the same affordability predicate so they agree: the
 * event insert is an `INSERT ... SELECT ... WHERE`, which inserts zero rows
 * when the user can't pay. Neither can land without the other.
 */
export async function spendShards(
  db: Db,
  userId: string,
  amount: number,
  refs: ShardEventRefs = {},
): Promise<ShardChangeResult> {
  if (amount <= 0) {
    throw new Error(`spendShards: amount must be positive, got ${amount}`);
  }

  // The conditional insert, as `insert().select()` rather than a raw
  // `db.run(sql\`...\`)`.
  //
  // This distinction is not stylistic — a raw statement CANNOT go into
  // `db.batch()`. Drizzle's D1 batch does:
  //
  //     const prepared = query._prepare();
  //     if (prepared.getQuery().params.length > 0)
  //       builtQueries.push(prepared.stmt.bind(...params));
  //
  // and `SQLiteRaw._prepare()` returns `this`, which has no `.stmt`. So any
  // raw statement carrying bind params throws "Cannot read properties of
  // undefined (reading 'bind')" the moment it is batched. It type-checks
  // (SQLiteRaw does implement RunnableQuery) and it runs fine on its own —
  // it only fails inside a batch, which is why this shipped.
  //
  // `insert().select()` produces a real insert builder with a working
  // `_prepare()`, and drizzle emits the explicit column list from the table
  // definition, so the SELECT's column order is checked against the schema
  // rather than assumed. The id is generated here because `$defaultFn` only
  // runs for `.values()`, not for an insert-from-select.
  const eventId = crypto.randomUUID();
  const insertIfAffordable = db.insert(shardEvents).select(
    sql`select
      ${eventId}, ${userId}, ${-amount}, 'rip', null,
      ${refs.packId ?? null}, ${refs.ripId ?? null}, unixepoch()
    where coalesce(
      (select shards from ${shardBalances} where ${shardBalances.userId} = ${userId}),
      0
    ) >= ${amount}`,
  );

  const debit = db
    .update(shardBalances)
    .set({
      shards: sql`${shardBalances.shards} - ${amount}`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(shardBalances.userId, userId), gte(shardBalances.shards, amount)),
    )
    .returning({ shards: shardBalances.shards });

  const [, debited] = await db.batch([insertIfAffordable, debit]);

  if (debited.length === 0) {
    // Couldn't afford it (or has no balance row at all, which is the same
    // thing — nothing earned, nothing to spend). Nothing was written: the
    // insert carried the identical predicate.
    const current = await readBalance(db, userId);
    return {
      applied: false,
      delta: 0,
      newBalance: current,
      reason: "insufficient_shards",
    };
  }

  return { applied: true, delta: -amount, newBalance: debited[0].shards };
}

/**
 * Returns `{ used, limit }` for a capped reason, or `null` if the
 * reason is uncapped. Isolated so the cap definition lives in one
 * place and tests can exercise it directly.
 */
async function capCheck(
  db: Db,
  userId: string,
  reason: ShardReason,
): Promise<{ used: number; limit: number } | null> {
  const cfg = await getEconomy();
  switch (reason) {
    case "start_reading": {
      const used = await countEventsSince(db, userId, reason, daysAgo(1));
      return { used, limit: cfg.transitions.startReading.dailyCap };
    }
    case "finish_reading": {
      const used = await countEventsSince(db, userId, reason, daysAgo(7));
      return { used, limit: cfg.transitions.finishReading.weeklyCap };
    }
    default:
      return null;
  }
}

/**
 * Start of a rolling window, N days back from now.
 *
 * Was `sql\`now() - interval '1 day'\``. Computing it in JS instead of SQL
 * keeps it driver-agnostic and lets it go through Drizzle's query builder,
 * which knows `created_at` is `integer({ mode: "timestamp" })` and converts
 * the Date to epoch seconds. A raw `unixepoch('now', '-1 day')` would work
 * too, but only inside raw SQL.
 */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function countEventsSince(
  db: Db,
  userId: string,
  reason: ShardReason,
  since: Date,
): Promise<number> {
  const [row] = await db
    // `count(*)` on Postgres — SQLite's count() is already an integer
    // and has no cast syntax.
    .select({ count: sql<number>`count(*)` })
    .from(shardEvents)
    .where(
      and(
        eq(shardEvents.userId, userId),
        eq(shardEvents.reason, reason),
        gte(shardEvents.createdAt, since),
      ),
    );
  return row?.count ?? 0;
}

async function readBalance(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ shards: shardBalances.shards })
    .from(shardBalances)
    .where(eq(shardBalances.userId, userId))
    .limit(1);
  return row?.shards ?? 0;
}

// Exported for tests.
export const _internals = { capCheck, countEventsSince, readBalance, daysAgo };
