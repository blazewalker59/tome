/**
 * Reading-log server functions.
 *
 * The reading log is an independent domain from `collection_cards`:
 *   • Collection = cards you own, acquired via pack rips.
 *   • Reading log = books you're queueing, reading, or have finished.
 *
 * A book can be in both lists, in one, or in neither. Owning a card
 * does not add it to the log; logging a book does not grant a card.
 * This mirrors how real readers think about it — "my shelf" and "my
 * TBR" are not the same thing.
 *
 * Shard rewards on reading transitions are identical to the prior
 * collection-backed flow, but now fire for any catalog book. The
 * partial unique index on `shard_events` (see `src/db/schema.ts`)
 * enforces once-per-book-ever for start/finish grants, so removing
 * and re-adding a reading entry does not re-grant. An additional
 * in-app 1-hour guard prevents the "log → immediately finish"
 * farming pattern: finish_reading only grants if either (a) no
 * start_reading event exists (retroactive log) or (b) a
 * start_reading event exists and is at least an hour old.
 *
 * Anti-abuse stacked layers:
 *   • Once-per-book DB index on start/finish events.
 *   • Daily cap on start_reading (5/day), weekly cap on finish_reading
 *     (3/week), in the ledger's `capCheck`.
 *   • 1-hour guard between a user's start_reading and finish_reading
 *     for the same book (below, `shouldGrantFinish`).
 *   • Per-user hourly cap on Hardcover ingests (10/hr) reused from
 *     the pack builder path.
 */

import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { books, readingEntries, shardEvents } from "@/db/schema";
import { getEconomy } from "@/lib/economy/config";
import { grantShards, type ShardChangeResult } from "@/lib/economy/ledger";
import { requireSessionUser } from "@/lib/auth/session";
import { bookResponseToRow } from "@/lib/cards/hardcover";
import type { Rarity } from "@/lib/packs/composition";
import { fetchBookById, searchBooks, type HardcoverSearchHit } from "./hardcover";
import type { DemoteReason } from "@/lib/hardcover/rank";
import { withErrorLogging } from "./_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export type ReadingStatus = "tbr" | "reading" | "finished";
export const READING_STATUSES: ReadonlyArray<ReadingStatus> = [
  "tbr",
  "reading",
  "finished",
];

export interface ReadingEntry {
  bookId: string;
  status: ReadingStatus;
  rating: number | null;
  note: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
  book: {
    id: string;
    title: string;
    authors: ReadonlyArray<string>;
    coverUrl: string | null;
    genre: string;
    rarity: Rarity;
  };
}

export interface ReadingGrant {
  reason: "start_reading" | "finish_reading";
  amount: number;
  newBalance: number | null;
}

export interface UpsertReadingEntryResult {
  entry: ReadingEntry;
  grants: ReadonlyArray<ReadingGrant>;
  /** When true, a finish transition happened but the 1-hour guard
   *  suppressed the grant. Lets the UI explain "no shards this time
   *  — finish at least an hour after starting". */
  finishGuardSuppressed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anti-farm: minimum time between start and finish
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum elapsed time between a user's `start_reading` event and a
 * `finish_reading` grant for the same book. Without this guard a user
 * could ingest a book, mark it reading, then immediately mark it
 * finished for 105 shards (5 start + 100 finish). The 1-hour window
 * is short enough that an honest "started last night, finished this
 * afternoon" always passes, but long enough to kill the one-tap
 * farming path.
 *
 * Exported so the test suite can exercise both sides of the boundary.
 */
export const FINISH_GUARD_MS = 60 * 60 * 1000;

/**
 * Pure decision function: given the prior status (possibly undefined
 * for a brand-new entry) and the desired next status, report which
 * transition grant — if any — the caller should attempt to mint.
 *
 * Separated from the handler so it can be tested in isolation; the
 * handler composes this with `shouldGrantFinish` to gate finish grants
 * behind the anti-farm window.
 *
 * Rules:
 *   • null/undefined → reading, or tbr → reading, or finished → reading
 *     (un-finish): emit start_reading.
 *   • any-non-finished → finished: emit finish_reading (subject to the
 *     hourly guard, which is enforced outside this function).
 *   • tbr transitions and idempotent writes (reading→reading,
 *     finished→finished): emit nothing.
 */
export function decideTransitionGrant(
  prior: ReadingStatus | undefined,
  next: ReadingStatus,
): "start_reading" | "finish_reading" | null {
  if (next === "reading" && prior !== "reading") return "start_reading";
  if (next === "finished" && prior !== "finished") return "finish_reading";
  return null;
}

/**
 * Pure decision function for started_at / finished_at stamping.
 * Only the FIRST entry into a state sets its timestamp; subsequent
 * bounces (reading → tbr → reading) preserve the original. Matches
 * how Goodreads / StoryGraph treat these fields — users expect
 * "started on March 3rd" to stay March 3rd even after a re-shelve.
 */
export function computeReadingTimestamps(
  next: ReadingStatus,
  prior: { startedAt: Date | null; finishedAt: Date | null } | undefined,
  now: Date,
): { startedAt: Date | null; finishedAt: Date | null } {
  const startedAt =
    next === "reading" && !prior?.startedAt ? now : (prior?.startedAt ?? null);
  const finishedAt =
    next === "finished" && !prior?.finishedAt
      ? now
      : (prior?.finishedAt ?? null);
  return { startedAt, finishedAt };
}

/**
 * Returns true iff a finish_reading grant should fire for this user/book.
 * The caller still has to insert the grant (we don't do it here) — this
 * just reports the policy decision so the caller can decide whether to
 * stamp `finishedAt` and skip the ledger insert.
 *
 * Policy:
 *   • No prior start_reading event → suppress. This is the "I'm logging
 *     a book I already read" path: the user should be able to shelve it
 *     as finished for their records, but they haven't demonstrated any
 *     reading activity inside the system, so no shards are minted.
 *     Without this rule the one-tap farm is trivial — search, tap
 *     Finished, collect 100 shards, repeat.
 *   • Prior start_reading event ≥ FINISH_GUARD_MS old → grant. The
 *     honest "started last night, finished this afternoon" case.
 *   • Prior start_reading event < FINISH_GUARD_MS old → suppress.
 *     Same farm shape, just with an extra start→finish tap.
 *
 * The once-per-book DB index still blocks repeat finish grants even if
 * this check is bypassed, so this layer is about pacing rather than
 * correctness.
 *
 * Exported for direct unit testing; production callers go through
 * upsertReadingEntryFn which invokes it internally.
 */
export async function shouldGrantFinish(
  database: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  bookId: string,
): Promise<boolean> {
  const [prior] = await database
    .select({ createdAt: shardEvents.createdAt })
    .from(shardEvents)
    .where(
      and(
        eq(shardEvents.userId, userId),
        eq(shardEvents.reason, "start_reading"),
        eq(shardEvents.refBookId, bookId),
      ),
    )
    .orderBy(desc(shardEvents.createdAt))
    .limit(1);

  // Flip from the old "no prior = grant" rule to "no prior = suppress".
  // A finish with no preceding start is a retroactive log and shouldn't
  // earn shards; the entry still writes so the user can track it.
  if (!prior) return false;
  return Date.now() - prior.createdAt.getTime() >= FINISH_GUARD_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read: list the user's entries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the signed-in user's reading log, optionally filtered by
 * status. Ordered by most recently updated first so "still reading"
 * and "just logged" rows surface near the top of their tab.
 */
export const listReadingEntriesFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): { status?: ReadingStatus } => {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object") {
      throw new Error("listReadingEntriesFn: input must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (r.status === undefined) return {};
    if (
      typeof r.status !== "string" ||
      !(READING_STATUSES as readonly string[]).includes(r.status)
    ) {
      throw new Error("listReadingEntriesFn: invalid status");
    }
    return { status: r.status as ReadingStatus };
  })
  .handler(
    withErrorLogging(
      "listReadingEntriesFn",
      async ({ data }): Promise<ReadonlyArray<ReadingEntry>> => {
        const user = await requireSessionUser();
        const database = await getDb();

        const conditions = [eq(readingEntries.userId, user.id)];
        if (data.status) {
          conditions.push(eq(readingEntries.status, data.status));
        }

        const rows = await database
          .select({
            bookId: readingEntries.bookId,
            status: readingEntries.status,
            rating: readingEntries.rating,
            note: readingEntries.note,
            startedAt: readingEntries.startedAt,
            finishedAt: readingEntries.finishedAt,
            createdAt: readingEntries.createdAt,
            updatedAt: readingEntries.updatedAt,
            book: {
              id: books.id,
              title: books.title,
              authors: books.authors,
              coverUrl: books.coverUrl,
              genre: books.genre,
              rarity: books.rarity,
            },
          })
          .from(readingEntries)
          .innerJoin(books, eq(readingEntries.bookId, books.id))
          .where(and(...conditions))
          .orderBy(desc(readingEntries.updatedAt));

        return rows.map((r) => ({
          bookId: r.bookId,
          status: r.status as ReadingStatus,
          rating: r.rating ?? null,
          note: r.note ?? null,
          startedAt: r.startedAt?.getTime() ?? null,
          finishedAt: r.finishedAt?.getTime() ?? null,
          createdAt: r.createdAt.getTime(),
          updatedAt: r.updatedAt.getTime(),
          book: { ...r.book, rarity: r.book.rarity as Rarity },
        }));
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Read: single entry (optional, used by book detail)
// ─────────────────────────────────────────────────────────────────────────────

export const getReadingEntryFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): { bookId: string } => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("getReadingEntryFn: input must be an object");
    }
    const r = raw as Record<string, unknown>;
    const bookId = typeof r.bookId === "string" ? r.bookId : "";
    if (bookId.length === 0) throw new Error("bookId is required");
    return { bookId };
  })
  .handler(
    withErrorLogging(
      "getReadingEntryFn",
      async ({ data }): Promise<ReadingEntry | null> => {
        const user = await requireSessionUser();
        const database = await getDb();

        const [row] = await database
          .select({
            bookId: readingEntries.bookId,
            status: readingEntries.status,
            rating: readingEntries.rating,
            note: readingEntries.note,
            startedAt: readingEntries.startedAt,
            finishedAt: readingEntries.finishedAt,
            createdAt: readingEntries.createdAt,
            updatedAt: readingEntries.updatedAt,
            book: {
              id: books.id,
              title: books.title,
              authors: books.authors,
              coverUrl: books.coverUrl,
              genre: books.genre,
              rarity: books.rarity,
            },
          })
          .from(readingEntries)
          .innerJoin(books, eq(readingEntries.bookId, books.id))
          .where(
            and(
              eq(readingEntries.userId, user.id),
              eq(readingEntries.bookId, data.bookId),
            ),
          )
          .limit(1);

        if (!row) return null;
        return {
          bookId: row.bookId,
          status: row.status as ReadingStatus,
          rating: row.rating ?? null,
          note: row.note ?? null,
          startedAt: row.startedAt?.getTime() ?? null,
          finishedAt: row.finishedAt?.getTime() ?? null,
          createdAt: row.createdAt.getTime(),
          updatedAt: row.updatedAt.getTime(),
          book: { ...row.book, rarity: row.book.rarity as Rarity },
        };
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Write: create or update an entry
// ─────────────────────────────────────────────────────────────────────────────

interface UpsertReadingEntryInput {
  bookId: string;
  status?: ReadingStatus;
  rating?: number | null;
  note?: string | null;
}

/**
 * Single write path for the reading log. Creates a row if none exists,
 * otherwise patches the requested fields. Status transitions into
 * `reading` / `finished` emit the same shard grants as the prior
 * collection-backed flow; the 1-hour guard on finish grants is
 * enforced here.
 *
 * Caller can pass any subset of status/rating/note. Omitted fields
 * are left untouched on updates; on inserts, status defaults to 'tbr'.
 */
export const upsertReadingEntryFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): UpsertReadingEntryInput => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("upsertReadingEntryFn: input must be an object");
    }
    const r = raw as Record<string, unknown>;
    const bookId = typeof r.bookId === "string" ? r.bookId : "";
    if (bookId.length === 0) throw new Error("bookId is required");

    const out: UpsertReadingEntryInput = { bookId };

    if (r.status !== undefined) {
      if (
        typeof r.status !== "string" ||
        !(READING_STATUSES as readonly string[]).includes(r.status)
      ) {
        throw new Error("upsertReadingEntryFn: invalid status");
      }
      out.status = r.status as ReadingStatus;
    }

    if (r.rating !== undefined) {
      if (r.rating === null) {
        out.rating = null;
      } else if (
        typeof r.rating === "number" &&
        Number.isInteger(r.rating) &&
        r.rating >= 1 &&
        r.rating <= 5
      ) {
        out.rating = r.rating;
      } else {
        throw new Error(
          "upsertReadingEntryFn: rating must be an integer 1..5 or null",
        );
      }
    }

    if (r.note !== undefined) {
      if (r.note === null) {
        out.note = null;
      } else if (typeof r.note === "string") {
        // Same 2000-char ceiling we used on collection_cards.note.
        out.note = r.note.slice(0, 2000);
      } else {
        throw new Error("upsertReadingEntryFn: note must be a string or null");
      }
    }

    return out;
  })
  .handler(
    withErrorLogging(
      "upsertReadingEntryFn",
      async ({ data }): Promise<UpsertReadingEntryResult> => {
        const user = await requireSessionUser();
        const database = await getDb();

        // Validate the book exists before creating a reading entry.
        // The FK would catch it, but a pre-check lets us surface a
        // cleaner error than "insert or update on table ... violates
        // foreign key constraint".
        const [book] = await database
          .select({ id: books.id })
          .from(books)
          .where(eq(books.id, data.bookId))
          .limit(1);
        if (!book) {
          throw new Error(`Book ${data.bookId} not found`);
        }

        return await database.transaction(async (tx) => {
          // Read current state. Used both to decide transitions and to
          // stamp started_at / finished_at only on first entry into
          // each status (so un-finishing and re-finishing doesn't
          // overwrite the original timestamp).
          const [prior] = await tx
            .select({
              status: readingEntries.status,
              startedAt: readingEntries.startedAt,
              finishedAt: readingEntries.finishedAt,
              rating: readingEntries.rating,
              note: readingEntries.note,
            })
            .from(readingEntries)
            .where(
              and(
                eq(readingEntries.userId, user.id),
                eq(readingEntries.bookId, data.bookId),
              ),
            )
            .limit(1);

          const now = new Date();
          const desiredStatus: ReadingStatus =
            data.status ?? (prior?.status as ReadingStatus | undefined) ?? "tbr";

          // Stamp transitions via the pure helper so the test suite
          // can exercise the same rule in isolation.
          const { startedAt: nextStartedAt, finishedAt: nextFinishedAt } =
            computeReadingTimestamps(
              desiredStatus,
              prior
                ? { startedAt: prior.startedAt, finishedAt: prior.finishedAt }
                : undefined,
              now,
            );

          // Upsert the row. On insert we rely on the schema defaults
          // for created_at; on update we explicitly bump updated_at.
          if (prior) {
            await tx
              .update(readingEntries)
              .set({
                status: desiredStatus,
                rating: data.rating !== undefined ? data.rating : prior.rating,
                note: data.note !== undefined ? data.note : prior.note,
                startedAt: nextStartedAt,
                finishedAt: nextFinishedAt,
                updatedAt: now,
              })
              .where(
                and(
                  eq(readingEntries.userId, user.id),
                  eq(readingEntries.bookId, data.bookId),
                ),
              );
          } else {
            await tx.insert(readingEntries).values({
              userId: user.id,
              bookId: data.bookId,
              status: desiredStatus,
              rating: data.rating ?? null,
              note: data.note ?? null,
              startedAt: nextStartedAt,
              finishedAt: nextFinishedAt,
              // created_at + updated_at default to now().
            });
          }

          // Grant logic. Uses the pure transition helper to decide
          // which grant — if any — applies, then gates finish grants
          // behind the anti-farm window.
          const grants: Array<ReadingGrant> = [];
          let finishGuardSuppressed = false;
          const oldStatus = prior?.status as ReadingStatus | undefined;
          const transition = decideTransitionGrant(oldStatus, desiredStatus);
          const cfg = await getEconomy();

          if (transition === "start_reading") {
            const r = await grantShards(
              tx,
              user.id,
              "start_reading",
              cfg.transitions.startReading.shards,
              { bookId: data.bookId },
            );
            pushGrantIfApplied(grants, "start_reading", r);
          } else if (transition === "finish_reading") {
            // Guard BEFORE grantShards. Suppressing a grant is
            // different from "granted 0" because the partial unique
            // index on shard_events would then block future legitimate
            // grants for this (user, book). Letting the row stay
            // un-inserted preserves the once-per-book invariant: a
            // legitimate finish later still qualifies.
            //
            // Use the transaction handle for this read, NOT the outer
            // `database`. Our Neon pool runs with `max: 1`, so any
            // query on the outer connection while the transaction is
            // open will wait forever for the pool's single socket to
            // free up — the exact hang we saw when users tapped
            // Finished. The read is a plain SELECT on `shard_events`
            // (different table than the one being written), so the
            // transaction's snapshot gives us a consistent view
            // without any lock contention.
            const allowed = await shouldGrantFinish(
              tx,
              user.id,
              data.bookId,
            );
            if (allowed) {
              const r = await grantShards(
                tx,
                user.id,
                "finish_reading",
                cfg.transitions.finishReading.shards,
                { bookId: data.bookId },
              );
              pushGrantIfApplied(grants, "finish_reading", r);
            } else {
              finishGuardSuppressed = true;
            }
          }

          // Re-read the row so the returned shape matches listReadingEntriesFn.
          const [updated] = await tx
            .select({
              bookId: readingEntries.bookId,
              status: readingEntries.status,
              rating: readingEntries.rating,
              note: readingEntries.note,
              startedAt: readingEntries.startedAt,
              finishedAt: readingEntries.finishedAt,
              createdAt: readingEntries.createdAt,
              updatedAt: readingEntries.updatedAt,
              book: {
                id: books.id,
                title: books.title,
                authors: books.authors,
                coverUrl: books.coverUrl,
                genre: books.genre,
                rarity: books.rarity,
              },
            })
            .from(readingEntries)
            .innerJoin(books, eq(readingEntries.bookId, books.id))
            .where(
              and(
                eq(readingEntries.userId, user.id),
                eq(readingEntries.bookId, data.bookId),
              ),
            )
            .limit(1);

          if (!updated) {
            throw new Error("upsertReadingEntryFn: entry vanished after write");
          }

          return {
            entry: {
              bookId: updated.bookId,
              status: updated.status as ReadingStatus,
              rating: updated.rating ?? null,
              note: updated.note ?? null,
              startedAt: updated.startedAt?.getTime() ?? null,
              finishedAt: updated.finishedAt?.getTime() ?? null,
              createdAt: updated.createdAt.getTime(),
              updatedAt: updated.updatedAt.getTime(),
              book: { ...updated.book, rarity: updated.book.rarity as Rarity },
            },
            grants,
            finishGuardSuppressed,
          };
        });
      },
    ),
  );

function pushGrantIfApplied(
  into: Array<ReadingGrant>,
  reason: ReadingGrant["reason"],
  r: ShardChangeResult,
): void {
  if (r.applied) {
    into.push({ reason, amount: r.delta, newBalance: r.newBalance });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete: remove an entry entirely
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove a book from the reading log. Does not refund shards — the
 * ledger entries stay so the once-per-book guard continues to apply.
 * Callers that just want to "unfinish" a book should patch the status
 * back to `reading` or `tbr` via upsert instead.
 */
export const deleteReadingEntryFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): { bookId: string } => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("deleteReadingEntryFn: input must be an object");
    }
    const r = raw as Record<string, unknown>;
    const bookId = typeof r.bookId === "string" ? r.bookId : "";
    if (bookId.length === 0) throw new Error("bookId is required");
    return { bookId };
  })
  .handler(
    withErrorLogging(
      "deleteReadingEntryFn",
      async ({ data }): Promise<{ removed: boolean }> => {
        const user = await requireSessionUser();
        const database = await getDb();
        const rows = await database
          .delete(readingEntries)
          .where(
            and(
              eq(readingEntries.userId, user.id),
              eq(readingEntries.bookId, data.bookId),
            ),
          )
          .returning({ bookId: readingEntries.bookId });
        return { removed: rows.length > 0 };
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Search: local + Hardcover fallback for the log flow
//
// Mirrors the pack builder's two-phase search. Reused shape so the UI
// can share most of its result-row rendering.
// ─────────────────────────────────────────────────────────────────────────────

export const LOCAL_SPARSE_THRESHOLD = 5;
const USER_INGEST_HOURLY_CAP = 10;

export interface LocalSearchHit {
  id: string;
  title: string;
  authors: ReadonlyArray<string>;
  coverUrl: string | null;
  genre: string;
  rarity: Rarity;
  /** Whether the signed-in user already has this in their reading log. */
  alreadyInLog: boolean;
}

/**
 * Local catalog search for the logging UI. Unlike
 * `searchBooksForBuilderFn`, this has no pack-exclusion and returns
 * the user's existing-in-log flag so the UI can show "already logged"
 * instead of a primary add button.
 */
export const searchForReadingLogFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): { query: string } => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("searchForReadingLogFn: input must be an object");
    }
    const r = raw as Record<string, unknown>;
    const query = typeof r.query === "string" ? r.query.trim() : "";
    if (query.length < 2) {
      throw new Error("Search query must be at least 2 characters");
    }
    return { query };
  })
  .handler(
    withErrorLogging(
      "searchForReadingLogFn",
      async ({ data }): Promise<ReadonlyArray<LocalSearchHit>> => {
        const user = await requireSessionUser();
        const database = await getDb();
        const like = `%${data.query}%`;

        const rows = await database
          .select({
            id: books.id,
            title: books.title,
            authors: books.authors,
            coverUrl: books.coverUrl,
            genre: books.genre,
            rarity: books.rarity,
          })
          .from(books)
          .where(
            or(
              ilike(books.title, like),
              sql`EXISTS (SELECT 1 FROM unnest(${books.authors}) AS a WHERE a ILIKE ${like})`,
            ),
          )
          .limit(20);

        if (rows.length === 0) return [];

        // One round-trip to learn which of these are already in the
        // caller's log. Saves 20 per-row queries from the client.
        const ids = rows.map((r) => r.id);
        const existing = await database
          .select({ bookId: readingEntries.bookId })
          .from(readingEntries)
          .where(
            and(
              eq(readingEntries.userId, user.id),
              inArray(readingEntries.bookId, ids),
            ),
          );
        const inLog = new Set(existing.map((e) => e.bookId));

        return rows.map((r) => ({
          ...r,
          rarity: r.rarity as Rarity,
          alreadyInLog: inLog.has(r.id),
        }));
      },
    ),
  );

export interface ReadingHardcoverHit {
  hardcoverId: number;
  title: string;
  authors: ReadonlyArray<string>;
  coverUrl: string | null;
  releaseYear: number | null;
  /** If the book is in our local catalog, points at its row so the
   *  UI can add it directly via upsertReadingEntry instead of
   *  ingesting again. */
  alreadyInCatalogBookId: string | null;
  /** Set when the hit was demoted by the quality reranker — the UI
   *  shows a small badge ("Summary", "Workbook", …) next to the title. */
  demoted: boolean;
  demoteReason: DemoteReason | null;
}

/**
 * Hardcover fallback for the reading log. Same rate-limiting and
 * dedup posture as the pack builder's equivalent.
 */
export const searchHardcoverForReadingLogFn = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown): { query: string } => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("searchHardcoverForReadingLogFn: input must be an object");
    }
    const r = raw as Record<string, unknown>;
    const query = typeof r.query === "string" ? r.query.trim() : "";
    if (query.length < 2) {
      throw new Error("Search query must be at least 2 characters");
    }
    return { query };
  })
  .handler(
    withErrorLogging(
      "searchHardcoverForReadingLogFn",
      async ({ data }): Promise<ReadonlyArray<ReadingHardcoverHit>> => {
        await requireSessionUser();

        let result: { hits: ReadonlyArray<HardcoverSearchHit> };
        try {
          result = await searchBooks(data.query, { page: 1, perPage: 20 });
        } catch (err) {
          throw new Error(
            err instanceof Error
              ? `Hardcover search failed: ${err.message}`
              : "Hardcover search failed",
          );
        }

        if (result.hits.length === 0) return [];

        const database = await getDb();
        const ids = result.hits.map((h) => h.id);
        const existing = await database
          .select({ id: books.id, hardcoverId: books.hardcoverId })
          .from(books)
          .where(inArray(books.hardcoverId, ids));
        const byHardcoverId = new Map<number, string>(
          existing.map((e) => [e.hardcoverId, e.id]),
        );

        return result.hits.map((h) => ({
          hardcoverId: h.id,
          title: h.title ?? "Untitled",
          authors: h.authorNames,
          coverUrl: h.coverUrl,
          releaseYear: h.releaseYear,
          alreadyInCatalogBookId: byHardcoverId.get(h.id) ?? null,
          demoted: h.demoted,
          demoteReason: h.demoteReason,
        }));
      },
    ),
  );

export interface IngestHardcoverForReadingLogResult {
  bookId: string;
  created: boolean;
}

/**
 * User-initiated Hardcover ingest for the reading log. Returns the
 * local book id. Unlike the builder path, this does NOT auto-mark the
 * book as read/reading — the caller follows up with upsertReadingEntry
 * if they want to. Keeping the two calls separate means adding a TBR
 * entry from Hardcover is one user gesture but zero shard grants,
 * which matches the plan ("TBR is free").
 */
export const ingestHardcoverForReadingLogFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown): { hardcoverId: number } => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("ingestHardcoverForReadingLogFn: input must be an object");
    }
    const r = raw as Record<string, unknown>;
    const hardcoverId = Number(r.hardcoverId);
    if (!Number.isInteger(hardcoverId) || hardcoverId <= 0) {
      throw new Error(`Invalid Hardcover id: ${r.hardcoverId}`);
    }
    return { hardcoverId };
  })
  .handler(
    withErrorLogging(
      "ingestHardcoverForReadingLogFn",
      async ({ data }): Promise<IngestHardcoverForReadingLogResult> => {
        const user = await requireSessionUser();
        const database = await getDb();

        // Dedup: already in catalog? Just return its id. Saves the
        // Hardcover fetch and doesn't count against the throttle.
        const [existing] = await database
          .select({ id: books.id })
          .from(books)
          .where(eq(books.hardcoverId, data.hardcoverId))
          .limit(1);
        if (existing) {
          return { bookId: existing.id, created: false };
        }

        // Per-user hourly throttle. Same policy as the builder ingest
        // — counting only rows stamped with this user's id.
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const [{ count: recentCount }] = await database
          .select({ count: sql<number>`count(*)::int` })
          .from(books)
          .where(
            and(
              eq(books.ingestedByUserId, user.id),
              gt(books.ingestedAt, oneHourAgo),
            ),
          );
        if (recentCount >= USER_INGEST_HOURLY_CAP) {
          throw new Error(
            `You've added ${recentCount} books from Hardcover in the last hour. ` +
              `Try again later (limit ${USER_INGEST_HOURLY_CAP}/hour).`,
          );
        }

        const hardcoverBook = await fetchBookById(data.hardcoverId);
        if (!hardcoverBook) {
          throw new Error(
            `Hardcover book ${data.hardcoverId} not found. It may have ` +
              `been removed or the id is wrong.`,
          );
        }

        // Same genre="unknown" + empty mood tags + common-rarity
        // posture as the builder ingest. Curation is an admin task.
        const row = bookResponseToRow(hardcoverBook, {
          genre: "unknown",
          moodTags: [],
        });
        const [upserted] = await database
          .insert(books)
          .values({
            ...row,
            ingestedByUserId: user.id,
            ingestedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: books.hardcoverId,
            set: {
              title: row.title,
              authors: row.authors,
              coverUrl: row.coverUrl,
              description: row.description,
              pageCount: row.pageCount,
              publishedYear: row.publishedYear,
              ratingsCount: row.ratingsCount,
              averageRating: row.averageRating,
              rawMetadata: row.rawMetadata,
              updatedAt: sql`now()`,
              // Provenance fields are write-once — see user-packs.ts.
            },
          })
          .returning({
            id: books.id,
            created: sql<boolean>`(xmax = 0)`,
          });

        if (!upserted) {
          throw new Error(
            `Upsert of hardcoverId=${data.hardcoverId} returned no row`,
          );
        }
        return { bookId: upserted.id, created: Boolean(upserted.created) };
      },
    ),
  );
