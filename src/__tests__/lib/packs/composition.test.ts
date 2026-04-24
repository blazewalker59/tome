import { describe, expect, it } from "vitest";
import { checkPackComposition, type Rarity } from "@/lib/packs/composition";

/**
 * Pure composition-validator tests.
 *
 * The rules under test come from `EconomyConfig.packComposition`;
 * fixtures below use a concrete rule object rather than importing
 * the defaults so the tests still pass if we ever tune the thresholds
 * in config — what's being validated is the validator, not the
 * current production values.
 */

const RULES = {
  minBooks: 10,
  minUncommonOrAbove: 3,
  minRareOrAbove: 1,
} as const;

/** Helper: build a rarity array of a given length, padding with `common`. */
function rarities(mix: ReadonlyArray<Rarity>, padTo = 0): Rarity[] {
  const out = [...mix];
  while (out.length < padTo) out.push("common");
  return out;
}

describe("checkPackComposition", () => {
  it("passes on a minimal legal pack (exactly at every threshold)", () => {
    // 10 books, 3 uncommon+, 1 rare+ — all thresholds met at equality.
    const result = checkPackComposition(
      rarities(["rare", "uncommon", "uncommon"], 10),
      RULES,
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.counts).toEqual({
      total: 10,
      uncommonOrAbove: 3,
      rareOrAbove: 1,
    });
  });

  it("flags an empty pack with a too_few_books error only if no rarity buckets are met", () => {
    // Empty pack fails every threshold; surface all three errors so the
    // builder UI can show the full checklist rather than a first-error
    // drip feed.
    const result = checkPackComposition([], RULES);
    expect(result.ok).toBe(false);
    const codes = result.errors.map((e) => e.code).sort();
    expect(codes).toEqual([
      "too_few_books",
      "too_few_rare_or_above",
      "too_few_uncommon_or_above",
    ]);
  });

  it("counts higher rarities as satisfying lower thresholds (no double-counting the bucket, but transitive)", () => {
    // Ten legendaries: satisfies total, uncommon+, rare+ all via the
    // same books. Validator uses `count(rarity >= threshold)` which is
    // what we want.
    const result = checkPackComposition(
      Array<Rarity>(10).fill("legendary"),
      RULES,
    );
    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({
      total: 10,
      uncommonOrAbove: 10,
      rareOrAbove: 10,
    });
  });

  it("rejects a 10-book pack with only commons (no uncommon+, no rare+)", () => {
    const result = checkPackComposition(Array<Rarity>(10).fill("common"), RULES);
    expect(result.ok).toBe(false);
    const codes = result.errors.map((e) => e.code).sort();
    expect(codes).toEqual(["too_few_rare_or_above", "too_few_uncommon_or_above"]);
  });

  it("reports have/need on each error for UI progress meters", () => {
    // 8 books, 2 uncommon+, 0 rare+. All three thresholds fail and we
    // expect the structured have/need numbers to be accurate.
    const result = checkPackComposition(rarities(["uncommon", "uncommon"], 8), RULES);
    const byCode = Object.fromEntries(result.errors.map((e) => [e.code, e]));
    expect(byCode.too_few_books).toMatchObject({ have: 8, need: 10 });
    expect(byCode.too_few_uncommon_or_above).toMatchObject({ have: 2, need: 3 });
    expect(byCode.too_few_rare_or_above).toMatchObject({ have: 0, need: 1 });
  });

  it("treats foil and legendary as satisfying the rare-or-above gate", () => {
    // Rare-or-above is satisfied by anything at rank >= rare (rare,
    // foil, legendary). Tested explicitly because the rank table is
    // duplicated from the pg enum and a drift would silently weaken
    // the gate.
    const foilPack = checkPackComposition(
      rarities(["foil", "uncommon", "uncommon"], 10),
      RULES,
    );
    expect(foilPack.ok).toBe(true);
    expect(foilPack.counts.rareOrAbove).toBe(1);

    const legPack = checkPackComposition(
      rarities(["legendary", "uncommon", "uncommon"], 10),
      RULES,
    );
    expect(legPack.ok).toBe(true);
    expect(legPack.counts.rareOrAbove).toBe(1);
  });

  it("does not flag a pack with >minBooks as over-sized", () => {
    // Thresholds are minimums; there is no upper bound enforced here
    // (storage limits would be a separate concern). A 30-book pack
    // with plenty of rarity variety should pass cleanly.
    const result = checkPackComposition(
      rarities(["rare", "rare", "uncommon", "uncommon", "uncommon"], 30),
      RULES,
    );
    expect(result.ok).toBe(true);
    expect(result.counts.total).toBe(30);
  });
});
