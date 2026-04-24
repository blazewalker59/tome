import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Economy config reader tests.
 *
 * `getEconomy()` does three things we care about:
 *   1. Returns `DEFAULTS` when no row exists (fresh/test db).
 *   2. Deep-merges DB values over `DEFAULTS` so partial configs
 *      (e.g. migration adds a new field before the row is updated)
 *      don't leave call sites reading `undefined`.
 *   3. Caches the result per-isolate so we aren't hitting the db on
 *      every server-fn call; `_resetEconomyCache()` clears it.
 *
 * We mock `getDb()` rather than standing up a real database — the
 * real driver needs a Worker context + env vars, and the surface we
 * care about is the translation layer.
 */

// A chainable fake query builder shared between tests. Each test
// assigns `selectResult` to control what the awaited query resolves
// to. Keeping it in module scope (rather than inside each test) means
// the mock factory below can close over it without vitest hoisting
// errors.
type SelectResult = Array<{ value: unknown }>;
let selectResult: SelectResult = [];
const selectCalls = { count: 0 };

function makeFakeDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCalls.count++;
            return selectResult;
          },
        }),
      }),
    }),
  };
}

vi.mock("@/db/client", () => ({
  getDb: async () => makeFakeDb(),
}));

// Schema import is only used for column references inside the query
// builder chain; in the mock above we ignore them entirely, so this
// mock just has to exist to satisfy the import.
vi.mock("@/db/schema", () => ({
  economyConfig: { key: "key", value: "value" },
}));

import { DEFAULTS, getEconomy, _internals, _resetEconomyCache } from "@/lib/economy/config";

afterEach(() => {
  _resetEconomyCache();
  selectResult = [];
  selectCalls.count = 0;
});

describe("getEconomy", () => {
  it("returns DEFAULTS when no row exists", async () => {
    selectResult = [];
    const cfg = await getEconomy();
    expect(cfg).toEqual(DEFAULTS);
  });

  it("returns DEFAULTS without caching when row is missing (so a later seed is picked up)", async () => {
    selectResult = [];
    await getEconomy();
    await getEconomy();
    // Both calls hit the db because the missing-row branch deliberately
    // skips the cache — the seed INSERT is expected to run eventually.
    expect(selectCalls.count).toBe(2);
  });

  it("merges partial DB values over DEFAULTS", async () => {
    selectResult = [{ value: { packCost: 77, welcomeGrant: 10 } }];
    const cfg = await getEconomy();
    expect(cfg.packCost).toBe(77);
    expect(cfg.welcomeGrant).toBe(10);
    // Missing keys fall back to defaults without leaking `undefined`.
    expect(cfg.dupeRefund.shardsPerDupe).toBe(DEFAULTS.dupeRefund.shardsPerDupe);
    expect(cfg.transitions.startReading.shards).toBe(
      DEFAULTS.transitions.startReading.shards,
    );
  });

  it("merges deeply-nested overrides", async () => {
    selectResult = [
      {
        value: {
          transitions: {
            startReading: { shards: 7 },
            finishReading: { weeklyCap: 1 },
          },
        },
      },
    ];
    const cfg = await getEconomy();
    expect(cfg.transitions.startReading.shards).toBe(7);
    // Untouched sibling falls back to DEFAULTS.
    expect(cfg.transitions.startReading.dailyCap).toBe(
      DEFAULTS.transitions.startReading.dailyCap,
    );
    expect(cfg.transitions.finishReading.shards).toBe(
      DEFAULTS.transitions.finishReading.shards,
    );
    expect(cfg.transitions.finishReading.weeklyCap).toBe(1);
  });

  it("caches the result across subsequent calls", async () => {
    selectResult = [{ value: { packCost: 99 } }];
    const first = await getEconomy();
    const second = await getEconomy();
    expect(first).toBe(second); // same reference
    expect(selectCalls.count).toBe(1); // second call served from cache
  });

  it("re-reads the row after _resetEconomyCache", async () => {
    selectResult = [{ value: { packCost: 99 } }];
    await getEconomy();
    _resetEconomyCache();
    selectResult = [{ value: { packCost: 42 } }];
    const cfg = await getEconomy();
    expect(cfg.packCost).toBe(42);
    expect(selectCalls.count).toBe(2);
  });
});

describe("mergeWithDefaults (internal)", () => {
  it("returns exactly DEFAULTS when passed an empty object", () => {
    expect(_internals.mergeWithDefaults({})).toEqual(DEFAULTS);
  });

  it("never mutates the DEFAULTS object", () => {
    const snapshot = structuredClone(DEFAULTS);
    _internals.mergeWithDefaults({ packCost: 1 });
    expect(DEFAULTS).toEqual(snapshot);
  });
});
