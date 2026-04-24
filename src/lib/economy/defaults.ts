/**
 * Pure types and defaults for the shard economy, with zero server-only
 * imports. Kept separate from `config.ts` so client-side modules (route
 * files that render composition meters, unlock progress, etc.) can
 * import `DEFAULTS` without dragging the db client — and through it
 * the `cloudflare:workers` virtual module — into the client bundle.
 *
 * When you add a new field: update `DEFAULTS` here, update the seed
 * INSERT in the migration that introduced the field, and extend
 * `mergeWithDefaults` in `config.ts` so stored rows missing the key
 * still resolve cleanly.
 */
export interface EconomyConfig {
  /** One-time grant dropped into a brand-new user's ledger on sign-up. */
  welcomeGrant: number;
  /** Baseline cost (shards) to rip one pack. */
  packCost: number;
  /**
   * Dupe-refund shape. Today it's a flat number; typed this way so
   * switching to per-rarity refunds later (`Record<Rarity, number>`)
   * is a data-only change, no migration needed.
   */
  dupeRefund: {
    shardsPerDupe: number;
  };
  /**
   * Per-reading-transition grants. Each entry is { shards, <cap> }.
   * Caps are window-based — "at most N events of this reason in the
   * last day/week" — and derived at query time from the ledger.
   * Once-ever-per-book uniqueness is enforced separately by the
   * partial unique index on `shard_events`.
   */
  transitions: {
    startReading: { shards: number; dailyCap: number };
    finishReading: { shards: number; weeklyCap: number };
  };
  /**
   * Gates on the publish action for user-built packs. Drafts are
   * always unrestricted; only `publishPackFn` consults these. Starts
   * at 3 finished books so the first-session user experience isn't
   * blocked but drive-by accounts can't immediately spam packs.
   */
  publishUnlock: {
    finishedBookThreshold: number;
  };
  /**
   * Composition rules enforced at publish. Kept in config (not hard-
   * coded) so we can tune them without a deploy as we watch what
   * ratio of drafts fail validation. Mirrors the plan defaults.
   */
  packComposition: {
    minBooks: number;
    minUncommonOrAbove: number;
    minRareOrAbove: number;
  };
}

/**
 * Hard-coded defaults. These are the source of truth at module load
 * and the fallback when the db row is missing or malformed. The
 * migration that introduced `economy_config` also seeds a row matching
 * these values, so in production `getEconomy()` reads the row and the
 * defaults only matter in tests / fresh local databases that haven't
 * applied migrations yet.
 */
export const DEFAULTS: EconomyConfig = {
  welcomeGrant: 200,
  packCost: 50,
  dupeRefund: {
    shardsPerDupe: 5,
  },
  transitions: {
    startReading: { shards: 5, dailyCap: 5 },
    finishReading: { shards: 100, weeklyCap: 3 },
  },
  publishUnlock: {
    finishedBookThreshold: 3,
  },
  packComposition: {
    minBooks: 10,
    minUncommonOrAbove: 3,
    minRareOrAbove: 1,
  },
};
