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
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { collectionCards } from "@/db/schema";
import { getEconomy } from "@/lib/economy/config";

export interface PublishUnlockStatus {
  eligible: boolean;
  /** How many 'read'-status rows the user currently has. */
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
  // (user_id) makes this cheap. Uses `count(*)::int` so drizzle hands
  // us a plain number rather than a string.
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(collectionCards)
    .where(and(eq(collectionCards.userId, userId), eq(collectionCards.status, "read")));
  const finishedBooks = row?.n ?? 0;
  const threshold = cfg.publishUnlock.finishedBookThreshold;
  return {
    eligible: finishedBooks >= threshold,
    finishedBooks,
    threshold,
  };
}
