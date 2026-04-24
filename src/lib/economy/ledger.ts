import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { shardBalances, shardEvents } from "@/db/schema";
import { getEconomy } from "./config";

/**
 * Shard ledger helpers.
 *
 * Every shard change — reading-transition grants, welcome grants,
 * dupe refunds, pack-rip debits — flows through one of the functions
 * in this file. The contract:
 *
 *   - Inserts a `shard_events` row (the source of truth).
 *   - Bumps `shard_balances` in the same transaction (the cache).
 *
 * Callers pass in the existing transaction so the grant rolls back
 * cleanly with whatever business write triggered it (e.g. if
 * `updateCollectionCardFn` fails after the grant, the grant rolls
 * back too). The `Tx` type is parameterised via an in-scope generic
 * rather than imported so we don't leak Drizzle internals here.
 *
 * See CORE_LOOP_PLAN.md §1 for the economic reasoning and
 * src/db/schema.ts `shard_events` for the table + constraints.
 */

/**
 * Narrow type for the transaction object callers pass in. Using the
 * specific `NeonDatabase` shape from the driver would couple this
 * file to the driver; instead we accept any object with the `insert`
 * / `select` / `update` shape we need. Drizzle's `PgDatabase` and
 * `PgTransaction` both satisfy this structurally.
 */
export type Tx = Awaited<ReturnType<typeof getDb>>;

/**
 * Enumerated reasons for a shard event. Kept as a union string literal
 * (not a pgEnum) so new reasons don't require a migration; app-layer
 * validation keeps the set tight.
 */
export type ShardReason =
  | "welcome_grant"
  | "start_reading"
  | "finish_reading"
  | "dupe_refund"
  | "rip";

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
 * Writes a positive ledger entry + updates the balance cache. Idempotent
 * only at the database level via the partial unique index on
 * (user_id, reason, ref_book_id) for start/finish transitions — calling
 * `grantShards` twice for the same (user, reason, book) returns
 * `applied: false, reason: 'already_granted_for_book'` rather than
 * throwing. Other reasons can be granted repeatedly.
 *
 * Cap enforcement: before the insert, we count the user's events of
 * this reason inside the current window (day for `start_reading`,
 * week for `finish_reading`) and skip if the cap is hit. Windows are
 * computed from `now() - interval`, not calendar boundaries, to avoid
 * the edge where a user is told they've hit their limit at 11:59pm
 * and has it reset one minute later. We can revisit calendar-day
 * resets if users find rolling windows confusing.
 */
export async function grantShards(
  tx: Tx,
  userId: string,
  reason: ShardReason,
  amount: number,
  refs: ShardEventRefs = {},
): Promise<ShardChangeResult> {
  if (amount <= 0) {
    throw new Error(`grantShards: amount must be positive, got ${amount}`);
  }

  // Capacity check (reason-specific). Only start/finish have caps
  // today; welcome_grant and dupe_refund are uncapped because they're
  // gated by other means (once-at-signup, per-rip).
  const cap = await capCheck(tx, userId, reason);
  if (cap && cap.used >= cap.limit) {
    const balance = await readBalance(tx, userId);
    return {
      applied: false,
      delta: 0,
      newBalance: balance,
      reason: "cap_reached",
    };
  }

  // Attempt the insert. For reasons covered by the partial unique
  // index on shard_events — currently start_reading / finish_reading
  // only — we target that index with onConflictDoNothing so a second
  // grant for the same (user, reason, book) returns zero rows and we
  // report it as already-granted. For uncovered reasons
  // (welcome_grant, dupe_refund, rip) a plain insert is correct:
  // they're allowed to repeat (one dupe_refund per dupe instance,
  // for example). Crucially, attaching onConflictDoNothing with an
  // index target that doesn't match the row's reason raises "no
  // unique or exclusion constraint matching the ON CONFLICT
  // specification" at the db level — Postgres matches the target
  // against the literal index definition, not against which rows it
  // would have covered.
  const isIndexCovered = reason === "start_reading" || reason === "finish_reading";
  const insertValues = {
    userId,
    delta: amount,
    reason,
    refBookId: refs.bookId ?? null,
    refPackId: refs.packId ?? null,
    refRipId: refs.ripId ?? null,
  };
  const inserted = isIndexCovered
    ? await tx
        .insert(shardEvents)
        .values(insertValues)
        .onConflictDoNothing({
          target: [shardEvents.userId, shardEvents.reason, shardEvents.refBookId],
        })
        .returning({ id: shardEvents.id })
    : await tx.insert(shardEvents).values(insertValues).returning({ id: shardEvents.id });

  if (inserted.length === 0) {
    const balance = await readBalance(tx, userId);
    return {
      applied: false,
      delta: 0,
      newBalance: balance,
      reason: "already_granted_for_book",
    };
  }

  // Bump the balance cache. Upsert because a brand-new user may not
  // have a `shard_balances` row yet (the welcome grant is usually
  // the first write).
  const [row] = await tx
    .insert(shardBalances)
    .values({ userId, shards: amount })
    .onConflictDoUpdate({
      target: shardBalances.userId,
      set: {
        shards: sql`${shardBalances.shards} + ${amount}`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ shards: shardBalances.shards });

  return {
    applied: true,
    delta: amount,
    newBalance: row.shards,
  };
}

/**
 * Writes a negative ledger entry, refusing if the user can't afford
 * the cost. Used for pack rips. The balance check + insert + cache
 * decrement all happen inside the caller's transaction so a concurrent
 * rip can't race and push the balance negative.
 */
export async function spendShards(
  tx: Tx,
  userId: string,
  amount: number,
  refs: ShardEventRefs = {},
): Promise<ShardChangeResult> {
  if (amount <= 0) {
    throw new Error(`spendShards: amount must be positive, got ${amount}`);
  }

  // Row-lock the balance row so two concurrent rips can't both read
  // "50 shards" and both spend, leaving -50. Neon WebSocket
  // transactions support FOR UPDATE via raw SQL. If the row doesn't
  // exist yet we treat it as zero balance — the user hasn't earned
  // anything, so they can't spend.
  const locked = await tx.execute(
    sql`select shards from shard_balances where user_id = ${userId} for update`,
  );
  // neon-serverless returns `{ rows: [...] }` for raw execute; guard
  // shape differences between driver versions.
  const rows = (locked as unknown as { rows?: Array<{ shards: number }> }).rows ?? [];
  const current = rows[0]?.shards ?? 0;

  if (current < amount) {
    return {
      applied: false,
      delta: 0,
      newBalance: current,
      reason: "insufficient_shards",
    };
  }

  await tx.insert(shardEvents).values({
    userId,
    delta: -amount,
    reason: "rip",
    refBookId: null,
    refPackId: refs.packId ?? null,
    refRipId: refs.ripId ?? null,
  });

  const [row] = await tx
    .update(shardBalances)
    .set({
      shards: sql`${shardBalances.shards} - ${amount}`,
      updatedAt: sql`now()`,
    })
    .where(eq(shardBalances.userId, userId))
    .returning({ shards: shardBalances.shards });

  return {
    applied: true,
    delta: -amount,
    newBalance: row.shards,
  };
}

/**
 * Returns `{ used, limit }` for a capped reason, or `null` if the
 * reason is uncapped. Isolated so the cap definition lives in one
 * place and tests can exercise it directly.
 */
async function capCheck(
  tx: Tx,
  userId: string,
  reason: ShardReason,
): Promise<{ used: number; limit: number } | null> {
  const cfg = await getEconomy();
  switch (reason) {
    case "start_reading": {
      const used = await countEventsSince(
        tx,
        userId,
        reason,
        sql`now() - interval '1 day'`,
      );
      return { used, limit: cfg.transitions.startReading.dailyCap };
    }
    case "finish_reading": {
      const used = await countEventsSince(
        tx,
        userId,
        reason,
        sql`now() - interval '7 days'`,
      );
      return { used, limit: cfg.transitions.finishReading.weeklyCap };
    }
    default:
      return null;
  }
}

async function countEventsSince(
  tx: Tx,
  userId: string,
  reason: ShardReason,
  sinceExpr: ReturnType<typeof sql>,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(shardEvents)
    .where(
      and(
        eq(shardEvents.userId, userId),
        eq(shardEvents.reason, reason),
        gte(shardEvents.createdAt, sinceExpr),
      ),
    );
  return row?.count ?? 0;
}

async function readBalance(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ shards: shardBalances.shards })
    .from(shardBalances)
    .where(eq(shardBalances.userId, userId))
    .limit(1);
  return row?.shards ?? 0;
}

// Exported for tests.
export const _internals = { capCheck, countEventsSince, readBalance };
