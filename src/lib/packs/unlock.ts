/**
 * Publish-eligibility check for user-built packs. "Soft unlock" in the
 * plan's vocabulary: drafts are always allowed, but calling
 * `publishPackFn` requires the user to have finished at least N books
 * (configured via `EconomyConfig.publishUnlock.finishedBookThreshold`).
 *
 * Kept separate from the composition validator so callers can run each
 * gate independently — the UI can show "you've read 1/3 books needed
 * to publish" before the draft even has enough content to trigger
 * composition errors.
 *
 * Since the collection/reading split (migration 0005), "finished books"
 * is sourced from the reading log (`reading_entries.status = 'finished'`)
 * rather than from ownership — finishing a book you've logged without
 * ripping its card still counts. Matches the plan's intent: publishing
 * is gated on *reading*, not on how many packs you've opened.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { readingEntries } from "@/db/schema";
import { getEconomy } from "@/lib/economy/config";

export interface PublishUnlockStatus {
  eligible: boolean;
  /** How many 'finished'-status rows the user has in their reading log. */
  finishedBooks: number;
  /** Threshold from config at the moment of the check. */
  threshold: number;
}

/**
 * Reads both config + the user's finished-book count and returns a
 * structured status. Does not throw for non-eligible callers — publish
 * fns wrap this and raise a user-friendly error; the builder UI calls
 * it directly to render the unlock meter.
 */
export async function getPublishUnlockStatus(
  userId: string,
): Promise<PublishUnlockStatus> {
  const [cfg, database] = await Promise.all([getEconomy(), getDb()]);
  // Count, not row fetch — we only need the number and the index on
  // (user_id, status, updated_at) makes this cheap. Uses `count(*)::int`
  // so drizzle hands us a plain number rather than a string.
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(readingEntries)
    .where(
      and(
        eq(readingEntries.userId, userId),
        eq(readingEntries.status, "finished"),
      ),
    );
  const finishedBooks = row?.n ?? 0;
  const threshold = cfg.publishUnlock.finishedBookThreshold;
  return {
    eligible: finishedBooks >= threshold,
    finishedBooks,
    threshold,
  };
}
