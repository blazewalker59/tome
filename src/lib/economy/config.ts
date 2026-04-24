import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { economyConfig } from "@/db/schema";
import { DEFAULTS, type EconomyConfig } from "@/lib/economy/defaults";

/**
 * Runtime loader for the shard economy config. The singleton row
 * (`economy_config` keyed `'current'`) lets us shift levers without a
 * deploy — per CORE_LOOP_PLAN.md §1 "Everything lives in config."
 *
 * This module pulls in `@/db/client` and therefore must only be
 * imported from server-side code. Client modules that need the
 * shape or the defaults should import from `@/lib/economy/defaults`.
 */

// Re-export so existing `import { DEFAULTS } from '@/lib/economy/config'`
// call sites in server modules keep working.
export { DEFAULTS, type EconomyConfig };

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
    publishUnlock: {
      finishedBookThreshold:
        raw.publishUnlock?.finishedBookThreshold ??
        DEFAULTS.publishUnlock.finishedBookThreshold,
    },
    packComposition: {
      minBooks: raw.packComposition?.minBooks ?? DEFAULTS.packComposition.minBooks,
      minUncommonOrAbove:
        raw.packComposition?.minUncommonOrAbove ?? DEFAULTS.packComposition.minUncommonOrAbove,
      minRareOrAbove:
        raw.packComposition?.minRareOrAbove ?? DEFAULTS.packComposition.minRareOrAbove,
    },
  };
}

// Exported for tests.
export const _internals = { mergeWithDefaults };
