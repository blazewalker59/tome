import { describe, expect, it } from "vitest";
import {
  applyRip,
  DEFAULT_PULL_COUNT,
  PULL_WEIGHTS,
  pullPack,
  type PoolEntry,
} from "@/lib/cards/pull";

/**
 * Flat per-dupe refund used across tests. Matches the default in
 * `DEFAULTS.dupeRefund.shardsPerDupe` (CORE_LOOP_PLAN §1), but any
 * positive number would work — these tests only care that the
 * arithmetic `duplicates.length * shardsPerDupe` is respected.
 */
const SHARDS_PER_DUPE = 5;

/**
 * Tiny seeded RNG (mulberry32). We don't care about cryptographic quality —
 * we only need a deterministic, well-distributed stream so test assertions
 * are stable across runs.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const samplePool: PoolEntry[] = [
  { bookId: "b1", rarity: "common" },
  { bookId: "b2", rarity: "common" },
  { bookId: "b3", rarity: "uncommon" },
  { bookId: "b4", rarity: "rare" },
  { bookId: "b5", rarity: "foil" },
  { bookId: "b6", rarity: "legendary" },
];

describe("pullPack", () => {
  it("pulls the default of 5 cards from the pool", () => {
    const result = pullPack({ pool: samplePool, rng: mulberry32(1) });
    expect(result).toHaveLength(DEFAULT_PULL_COUNT);
    for (const pull of result) {
      const entry = samplePool.find((p) => p.bookId === pull.bookId);
      expect(entry).toBeDefined();
      expect(pull.rarity).toBe(entry?.rarity);
    }
  });

  it("respects an explicit count", () => {
    expect(pullPack({ pool: samplePool, count: 1, rng: mulberry32(1) })).toHaveLength(1);
    expect(pullPack({ pool: samplePool, count: 12, rng: mulberry32(1) })).toHaveLength(12);
  });

  it("returns an empty array when count is 0", () => {
    expect(pullPack({ pool: samplePool, count: 0, rng: mulberry32(1) })).toEqual([]);
  });

  it("throws on an empty pool", () => {
    expect(() => pullPack({ pool: [], rng: mulberry32(1) })).toThrow();
  });

  it("is deterministic for a given rng seed", () => {
    const a = pullPack({ pool: samplePool, rng: mulberry32(42) });
    const b = pullPack({ pool: samplePool, rng: mulberry32(42) });
    expect(a).toEqual(b);
  });

  it("produces different results across different seeds", () => {
    const a = pullPack({ pool: samplePool, rng: mulberry32(1) });
    const b = pullPack({ pool: samplePool, rng: mulberry32(2) });
    expect(a).not.toEqual(b);
  });

  it("collapses to the only entry when the pool has size 1", () => {
    const pool: PoolEntry[] = [{ bookId: "solo", rarity: "rare" }];
    const result = pullPack({ pool, count: 7, rng: mulberry32(99) });
    expect(result).toHaveLength(7);
    for (const pull of result) {
      expect(pull).toEqual({ bookId: "solo", rarity: "rare" });
    }
  });

  it("biases pulls toward higher-rarity cards (legendary outdraws common per-slot)", () => {
    // Two cards, equal slot count, but one is common and one is legendary.
    // Over many trials, the legendary should appear ~PULL_WEIGHTS.legendary
    // times more often than the common.
    const pool: PoolEntry[] = [
      { bookId: "c", rarity: "common" },
      { bookId: "L", rarity: "legendary" },
    ];
    const rng = mulberry32(7);
    const trials = 5000;
    let common = 0;
    let legendary = 0;
    for (let i = 0; i < trials; i++) {
      const [pull] = pullPack({ pool, count: 1, rng });
      if (pull.bookId === "c") common++;
      else legendary++;
    }
    const expectedRatio = PULL_WEIGHTS.legendary / PULL_WEIGHTS.common; // 8
    const actualRatio = legendary / common;
    // Allow a generous tolerance for sample variance.
    expect(actualRatio).toBeGreaterThan(expectedRatio * 0.75);
    expect(actualRatio).toBeLessThan(expectedRatio * 1.25);
  });

  it("does NOT erase pool composition: 99 commons + 1 legendary still pulls mostly commons", () => {
    const pool: PoolEntry[] = [];
    for (let i = 0; i < 99; i++) {
      pool.push({ bookId: `c${i}`, rarity: "common" });
    }
    pool.push({ bookId: "L", rarity: "legendary" });

    const rng = mulberry32(11);
    const trials = 2000;
    let legendary = 0;
    for (let i = 0; i < trials; i++) {
      const [pull] = pullPack({ pool, count: 1, rng });
      if (pull.bookId === "L") legendary++;
    }
    // Expected legendary share: 8 / (99 + 8) ≈ 7.5%.
    const share = legendary / trials;
    expect(share).toBeGreaterThan(0.04);
    expect(share).toBeLessThan(0.12);
  });
});

describe("applyRip", () => {
  it("treats every pull as new when the user owns nothing", () => {
    const pulls = [
      { bookId: "b1", rarity: "common" as const },
      { bookId: "b2", rarity: "rare" as const },
    ];
    const result = applyRip({
      pulls,
      ownedBookIds: new Set(),
      shardsPerDupe: SHARDS_PER_DUPE,
    });
    expect(result.newCards).toEqual(pulls);
    expect(result.duplicates).toEqual([]);
    expect(result.shardsEarned).toBe(0);
  });

  it("treats every pull as a duplicate when all are already owned, awarding a flat per-dupe refund", () => {
    const pulls = [
      { bookId: "b1", rarity: "common" as const },
      { bookId: "b2", rarity: "uncommon" as const },
      { bookId: "b3", rarity: "rare" as const },
      { bookId: "b4", rarity: "foil" as const },
      { bookId: "b5", rarity: "legendary" as const },
    ];
    const owned = new Set(pulls.map((p) => p.bookId));
    const result = applyRip({
      pulls,
      ownedBookIds: owned,
      shardsPerDupe: SHARDS_PER_DUPE,
    });

    expect(result.newCards).toEqual([]);
    expect(result.duplicates).toEqual(pulls);
    // Flat refund per dupe — rarity doesn't affect the payout in v1
    // (CORE_LOOP_PLAN §1). Per-rarity tuning is a later change.
    expect(result.shardsEarned).toBe(pulls.length * SHARDS_PER_DUPE);
  });

  it("handles a mix of new and duplicate pulls", () => {
    const pulls = [
      { bookId: "owned-1", rarity: "rare" as const },
      { bookId: "new-1", rarity: "common" as const },
      { bookId: "owned-2", rarity: "legendary" as const },
    ];
    const result = applyRip({
      pulls,
      ownedBookIds: new Set(["owned-1", "owned-2"]),
      shardsPerDupe: SHARDS_PER_DUPE,
    });

    expect(result.newCards).toEqual([{ bookId: "new-1", rarity: "common" }]);
    expect(result.duplicates).toEqual([
      { bookId: "owned-1", rarity: "rare" },
      { bookId: "owned-2", rarity: "legendary" },
    ]);
    expect(result.shardsEarned).toBe(2 * SHARDS_PER_DUPE);
  });

  it("collapses a second copy of the same book pulled in the same rip into shards", () => {
    const pulls = [
      { bookId: "x", rarity: "foil" as const },
      { bookId: "x", rarity: "foil" as const },
      { bookId: "x", rarity: "foil" as const },
    ];
    const result = applyRip({
      pulls,
      ownedBookIds: new Set(),
      shardsPerDupe: SHARDS_PER_DUPE,
    });

    // First copy is new; copies 2 and 3 are dupes-in-pack.
    expect(result.newCards).toEqual([{ bookId: "x", rarity: "foil" }]);
    expect(result.duplicates).toHaveLength(2);
    expect(result.shardsEarned).toBe(2 * SHARDS_PER_DUPE);
  });

  it("scales linearly with shardsPerDupe", () => {
    const pulls = [
      { bookId: "a", rarity: "common" as const },
      { bookId: "b", rarity: "common" as const },
    ];
    const owned = new Set(["a", "b"]);
    const at5 = applyRip({ pulls, ownedBookIds: owned, shardsPerDupe: 5 });
    const at10 = applyRip({ pulls, ownedBookIds: owned, shardsPerDupe: 10 });
    expect(at5.shardsEarned).toBe(10);
    expect(at10.shardsEarned).toBe(20);
  });

  it("awards zero shards when shardsPerDupe is zero", () => {
    const pulls = [{ bookId: "a", rarity: "legendary" as const }];
    const result = applyRip({
      pulls,
      ownedBookIds: new Set(["a"]),
      shardsPerDupe: 0,
    });
    expect(result.duplicates).toHaveLength(1);
    expect(result.shardsEarned).toBe(0);
  });

  it("preserves the original pulls in order", () => {
    const pulls = [
      { bookId: "a", rarity: "common" as const },
      { bookId: "b", rarity: "rare" as const },
    ];
    const result = applyRip({
      pulls,
      ownedBookIds: new Set(["b"]),
      shardsPerDupe: SHARDS_PER_DUPE,
    });
    expect(result.pulls).toEqual(pulls);
    // Must be a copy, not the same reference (defensive).
    expect(result.pulls).not.toBe(pulls);
  });
});
