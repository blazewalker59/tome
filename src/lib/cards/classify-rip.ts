/**
 * Pure classification helper for the rip-commit path.
 *
 * Splits a server-validated set of pulled book IDs into:
 *   - `newBookIds`: distinct books the user didn't already own and
 *     hadn't already gained earlier in this same rip.
 *   - `duplicateBookIds`: every other pulled id, in pull order, with
 *     repeats preserved (each duplicate yields its own shard refund
 *     in the ledger, so position-stable repeats matter).
 *
 * Pulled IDs may legitimately repeat within a single rip (the rolling
 * pool samples with replacement), and a book that was new on the
 * first roll becomes a duplicate the second time it appears in the
 * same pull. The previous inline implementation in `recordRipFn`
 * mixed indices between the filtered-new array and the original pull
 * array, which mis-classified pulls like `[ownedB, unownedA, unownedA]`
 * as 0 new / 3 dupes when the correct answer is 1 new / 2 dupes.
 *
 * This helper is deterministic, has no I/O, and is exercised by
 * `src/__tests__/server/classify-rip.test.ts`.
 */

export interface RipClassification {
  /** Distinct, in-pull-order. Used to write `collection_cards` rows. */
  newBookIds: string[];
  /** Every duplicated pull, in pull order, repeats preserved. Each
   *  entry corresponds to one `dupe_refund` shard event. */
  duplicateBookIds: string[];
}

/**
 * Classify a pull list against the user's pre-rip ownership.
 *
 * Contract:
 *   - First occurrence of an unowned book in the pull = new card.
 *   - Subsequent occurrences (or any occurrence of an already-owned
 *     book) = duplicate.
 *
 * @param pulledBookIds  The exact ids the rip is committing, in roll
 *   order. Already validated as ⊆ pack membership at the call site.
 * @param ownedBeforeRip  Books the user owned before this rip began.
 */
export function classifyRip(
  pulledBookIds: ReadonlyArray<string>,
  ownedBeforeRip: ReadonlySet<string>,
): RipClassification {
  const newBookIds: string[] = [];
  const duplicateBookIds: string[] = [];
  const gainedThisRip = new Set<string>();

  for (const id of pulledBookIds) {
    if (ownedBeforeRip.has(id) || gainedThisRip.has(id)) {
      duplicateBookIds.push(id);
    } else {
      newBookIds.push(id);
      gainedThisRip.add(id);
    }
  }

  return { newBookIds, duplicateBookIds };
}
