/**
 * Server functions for reading economy config client-side.
 *
 * Live numbers (pack cost, dupe refund, grant amounts, caps) originate in
 * the `economy_config` singleton and are read through `getEconomy()`
 * server-side. The client needs a subset of these values at render time
 * (to show "50 shards to rip," to preview dupe refund amounts, to gate
 * the rip button on balance) — hence these typed, minimal pass-throughs.
 *
 * We deliberately don't expose the full config blob: caps and welcome
 * grant details aren't needed client-side and changing the shape of that
 * internal config shouldn't require changing any client code.
 */

import { createServerFn } from "@tanstack/react-start";
import { getEconomy } from "@/lib/economy/config";

export interface PublicEconomy {
  /** Cost in shards to rip one pack (baseline, pre-rarity scaling). */
  packCost: number;
  /** Flat shards credited per duplicate on a rip. */
  shardsPerDupe: number;
}

/**
 * Public snapshot of economy numbers the client actually uses. Safe to
 * expose unauthenticated — these are product surface, not secrets.
 */
export const getPublicEconomyFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<PublicEconomy> => {
    const cfg = await getEconomy();
    return {
      packCost: cfg.packCost,
      shardsPerDupe: cfg.dupeRefund.shardsPerDupe,
    };
  },
);
