/**
 * Pure validator for user-pack composition. Consumes just the rarity
 * list of a draft's books plus the config thresholds — no db, no
 * network — so it's trivially testable and can run client-side as the
 * creator builds their pack ("3 more uncommon needed") as well as
 * server-side at the publish gate.
 *
 * Rarity ordering (ascending quality):
 *   common < uncommon < rare < foil < legendary
 *
 * Thresholds are inclusive and cumulative: a `legendary` satisfies the
 * "rare-or-above" requirement, a `rare` satisfies "uncommon-or-above",
 * etc. The counters do NOT double-count — each book contributes to
 * every bucket it qualifies for, which is the same as
 * "count(rarity >= threshold)".
 *
 * Failure mode is a structured list rather than the first error so the
 * builder UI can show every missing criterion at once; an empty array
 * means "publishable". Callers that only care about pass/fail can
 * check `errors.length === 0`.
 */

import type { EconomyConfig } from "@/lib/economy/defaults";

/** Canonical rarity strings used across the schema and card-bucketing code. */
export type Rarity = "common" | "uncommon" | "rare" | "foil" | "legendary";

/**
 * Ordinal used for "X or above" comparisons. Duplicates the order from
 * the pg enum in `src/db/schema.ts` — if that enum grows a new tier,
 * this table must grow too (tests would catch a mismatch).
 */
const RARITY_RANK: Record<Rarity, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  foil: 3,
  legendary: 4,
};

export interface CompositionError {
  /** Stable code for UI to key off (i18n, icon selection, etc.). */
  code: "too_few_books" | "too_few_uncommon_or_above" | "too_few_rare_or_above";
  /** Human string for when the UI doesn't care to localize. */
  message: string;
  /** What the creator currently has. */
  have: number;
  /** What they need. */
  need: number;
}

export interface CompositionCheckResult {
  ok: boolean;
  errors: ReadonlyArray<CompositionError>;
  /** Counters surfaced so the builder UI can render progress bars. */
  counts: {
    total: number;
    uncommonOrAbove: number;
    rareOrAbove: number;
  };
}

/**
 * Validates a draft pack's book list against the config thresholds.
 * Accepts rarities as a plain string array rather than full book rows
 * so callers don't have to hydrate more than they need.
 */
export function checkPackComposition(
  rarities: ReadonlyArray<Rarity>,
  rules: EconomyConfig["packComposition"],
): CompositionCheckResult {
  const total = rarities.length;
  let uncommonOrAbove = 0;
  let rareOrAbove = 0;
  for (const r of rarities) {
    const rank = RARITY_RANK[r];
    if (rank >= RARITY_RANK.uncommon) uncommonOrAbove += 1;
    if (rank >= RARITY_RANK.rare) rareOrAbove += 1;
  }

  const errors: CompositionError[] = [];
  if (total < rules.minBooks) {
    errors.push({
      code: "too_few_books",
      message: `Pack needs at least ${rules.minBooks} books (has ${total}).`,
      have: total,
      need: rules.minBooks,
    });
  }
  if (uncommonOrAbove < rules.minUncommonOrAbove) {
    errors.push({
      code: "too_few_uncommon_or_above",
      message: `Pack needs at least ${rules.minUncommonOrAbove} uncommon-or-better books (has ${uncommonOrAbove}).`,
      have: uncommonOrAbove,
      need: rules.minUncommonOrAbove,
    });
  }
  if (rareOrAbove < rules.minRareOrAbove) {
    errors.push({
      code: "too_few_rare_or_above",
      message: `Pack needs at least ${rules.minRareOrAbove} rare-or-better book (has ${rareOrAbove}).`,
      have: rareOrAbove,
      need: rules.minRareOrAbove,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    counts: { total, uncommonOrAbove, rareOrAbove },
  };
}
