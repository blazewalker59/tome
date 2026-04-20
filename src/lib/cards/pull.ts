/**
 * Pure pack-rip primitives.
 *
 * - `pullPack` performs weighted random sampling (with replacement) from a
 *   pool of books. Weights are derived from the assigned rarity, biasing
 *   pulls toward rarer cards (per SPEC §3 "rare books surface more than they
 *   would uniformly").
 * - `applyRip` consumes a list of pulls and a set of already-owned book IDs,
 *   classifies each pull as `newCard` or `duplicate`, and tallies shards
 *   earned on the duplicates (per SPEC §5 yields).
 *
 * Both functions are deterministic given an injected `rng`. No I/O, no DB,
 * no globals — they're meant to be exercised by the server function that
 * actually opens a pack, and to be trivially testable.
 */

import type { Rarity } from "./rarity";

export interface PoolEntry {
  bookId: string;
  rarity: Rarity;
}

export interface PullResult {
  bookId: string;
  rarity: Rarity;
}

/**
 * Per-rarity sampling weight. Larger numbers = more likely to be pulled
 * relative to a common card from the same pool.
 *
 * Calibrated so that within a balanced pack a legendary is ~8× as likely
 * as a common to be selected on any single pull. The pool composition still
 * dominates: a pack with 100 commons and 1 legendary will pull mostly
 * commons.
 */
export const PULL_WEIGHTS: Record<Rarity, number> = {
  common: 1,
  uncommon: 1.5,
  rare: 2.5,
  foil: 4,
  legendary: 8,
};

/**
 * Shards yielded when a duplicate of a given rarity is rolled. From SPEC §5.
 */
export const SHARD_YIELDS: Record<Rarity, number> = {
  common: 1,
  uncommon: 2,
  rare: 5,
  foil: 10,
  legendary: 25,
};

export const DEFAULT_PULL_COUNT = 5;

export interface PullPackOptions {
  pool: ReadonlyArray<PoolEntry>;
  /** Number of cards to pull. Defaults to 5 (SPEC §3). */
  count?: number;
  /** Injected RNG for deterministic tests. Defaults to `Math.random`. */
  rng?: () => number;
}

export function pullPack({
  pool,
  count = DEFAULT_PULL_COUNT,
  rng = Math.random,
}: PullPackOptions): PullResult[] {
  if (pool.length === 0) {
    throw new Error("pullPack: pool must contain at least one entry");
  }
  if (count <= 0) return [];

  // Cumulative-weight table for O(log n) sampling per pull.
  const cumulative: number[] = Array.from({ length: pool.length });
  let total = 0;
  for (let i = 0; i < pool.length; i++) {
    total += PULL_WEIGHTS[pool[i].rarity];
    cumulative[i] = total;
  }

  const pulls: PullResult[] = [];
  for (let i = 0; i < count; i++) {
    const target = rng() * total;
    const idx = lowerBound(cumulative, target);
    const entry = pool[idx];
    pulls.push({ bookId: entry.bookId, rarity: entry.rarity });
  }
  return pulls;
}

/** Smallest index `i` such that `arr[i] >= target`. Assumes ascending. */
function lowerBound(arr: ReadonlyArray<number>, target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export interface RipOutcome {
  pulls: PullResult[];
  /** Pulls the user did not already own (deduplicated within this rip). */
  newCards: PullResult[];
  /** Pulls that collapsed into shards (already owned, or repeated in-rip). */
  duplicates: PullResult[];
  /** Total shards earned from `duplicates`. */
  shardsEarned: number;
}

export interface ApplyRipOptions {
  pulls: ReadonlyArray<PullResult>;
  /** Book IDs already in the user's collection BEFORE this rip. */
  ownedBookIds: ReadonlySet<string>;
}

export function applyRip({ pulls, ownedBookIds }: ApplyRipOptions): RipOutcome {
  const newCards: PullResult[] = [];
  const duplicates: PullResult[] = [];
  // Track books gained DURING this rip so a second copy in the same pack
  // collapses to shards too.
  const gainedThisRip = new Set<string>();
  let shardsEarned = 0;

  for (const pull of pulls) {
    const alreadyOwned = ownedBookIds.has(pull.bookId) || gainedThisRip.has(pull.bookId);
    if (alreadyOwned) {
      duplicates.push(pull);
      shardsEarned += SHARD_YIELDS[pull.rarity];
    } else {
      newCards.push(pull);
      gainedThisRip.add(pull.bookId);
    }
  }

  return {
    pulls: [...pulls],
    newCards,
    duplicates,
    shardsEarned,
  };
}
