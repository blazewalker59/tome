import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { economyConfig } from "@/db/schema";

/**
 * Tunable numbers for the shard economy. Lives in a single db row
 * (`economy_config` singleton keyed `'current'`) so we can shift the
 * levers without a deploy — per CORE_LOOP_PLAN.md §1 "Everything
 * lives in config."
 *
 * Fields are intentionally explicit rather than a flat bag of
 * numbers: downstream code reads e.g. `cfg.transitions.startReading`
 * and is both typo-proof and self-documenting at call sites.
 *
 * When you add a new field: update `DEFAULTS` (what a fresh instance
 * boots with), update the seed INSERT in the migration that first
 * introduced the field, and note whether old deployments need a data
 * fixup. Missing keys in the db row fall back to `DEFAULTS` because
 * we spread over the defaults at read time.
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
};

/**
 * Per-isolate cache. Cloudflare Workers reuse an isolate across many
 * requests, so re-reading the config from the db on every server-fn
 * call would be pure overhead — the row barely changes. We cache
 * after the first read and don't bother with TTL; if we add an admin
 * UI for editing, it can ping a cache-bust endpoint or we can switch
 * to a short TTL.
 */
let cached: EconomyConfig | null = null;

/**
 * Test helper — the cache survives across tests in the same process
 * otherwise, which causes order-dependent failures.
 */
export function _resetEconomyCache(): void {
  cached = null;
}

/**
 * Reads the economy config, using the cache when populated. Missing
 * keys in the stored row are filled from `DEFAULTS` (deep merge at
 * one level — good enough for the current shape, revisit if we add
 * deeper nesting). If the row doesn't exist at all, returns
 * `DEFAULTS` without caching so the next read retries — this is the
 * only graceful-degradation path; normally the seed INSERT has run.
 */
export async function getEconomy(): Promise<EconomyConfig> {
  if (cached) return cached;
  const database = await getDb();
  const [row] = await database
    .select({ value: economyConfig.value })
    .from(economyConfig)
    .where(eq(economyConfig.key, "current"))
    .limit(1);
  if (!row) return DEFAULTS;
  cached = mergeWithDefaults(row.value as Partial<EconomyConfig>);
  return cached;
}

/**
 * Shallow merge with nested fallbacks. Split out so it's testable in
 * isolation — the db round-trip is the awkward part of getEconomy.
 */
function mergeWithDefaults(raw: Partial<EconomyConfig>): EconomyConfig {
  return {
    welcomeGrant: raw.welcomeGrant ?? DEFAULTS.welcomeGrant,
    packCost: raw.packCost ?? DEFAULTS.packCost,
    dupeRefund: {
      shardsPerDupe: raw.dupeRefund?.shardsPerDupe ?? DEFAULTS.dupeRefund.shardsPerDupe,
    },
    transitions: {
      startReading: {
        shards: raw.transitions?.startReading?.shards ?? DEFAULTS.transitions.startReading.shards,
        dailyCap:
          raw.transitions?.startReading?.dailyCap ?? DEFAULTS.transitions.startReading.dailyCap,
      },
      finishReading: {
        shards: raw.transitions?.finishReading?.shards ?? DEFAULTS.transitions.finishReading.shards,
        weeklyCap:
          raw.transitions?.finishReading?.weeklyCap ??
          DEFAULTS.transitions.finishReading.weeklyCap,
      },
    },
  };
}

// Exported for tests.
export const _internals = { mergeWithDefaults };
