import { describe, expect, it, vi } from "vitest";

/**
 * Reading-log helper tests.
 *
 * Mirrors the shape of `ledger.test.ts`: we cover the pure decision
 * helpers (`decideTransitionGrant`, `computeReadingTimestamps`) with
 * plain unit assertions, and cover the one lightly-async helper
 * (`shouldGrantFinish`) with a minimal fake Drizzle builder that
 * returns whatever the test puts in its slot.
 *
 * The full upsert handler traverses requireSessionUser + Drizzle's
 * transaction wrapper, both of which are covered elsewhere. Mocking
 * enough of the builder chain to exercise the handler end-to-end would
 * drift from the real SQL shape faster than it would catch bugs — so
 * the handler is left to integration coverage and we test the
 * building blocks here.
 */

// Schema mock: shouldGrantFinish references column objects inside
// `eq()` / `desc()` calls; the fake query builder ignores what it's
// passed so any stable placeholder is fine here.
vi.mock("@/db/schema", () => ({
  shardEvents: {
    userId: "user_id",
    reason: "reason",
    refBookId: "ref_book_id",
    createdAt: "created_at",
  },
  readingEntries: {},
  books: {},
}));

vi.mock("@/db/client", () => ({ getDb: async () => ({}) }));

// Session + economy + hardcover are only touched by the server-fn
// handlers, which these tests deliberately don't traverse. Mocking
// them keeps the import graph clean when vitest resolves `reading.ts`.
vi.mock("@/lib/auth/session", () => ({
  requireSessionUser: async () => ({ id: "u1" }),
}));
vi.mock("@/lib/error-logging", () => ({
  withErrorLogging: (_name: string, fn: unknown) => fn,
}));
vi.mock("@/lib/economy/ledger", () => ({
  grantShards: async () => ({ applied: true, delta: 0, newBalance: 0 }),
}));
vi.mock("@/lib/economy/config", () => ({
  getEconomy: async () => ({
    transitions: {
      startReading: { shards: 5 },
      finishReading: { shards: 100 },
    },
  }),
}));
vi.mock("@/lib/hardcover/client", () => ({}));
vi.mock("@/lib/hardcover/ingest", () => ({}));
vi.mock("@/lib/hardcover/search", () => ({}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: () => ({
      handler: (fn: unknown) => fn,
    }),
  }),
}));

import {
  FINISH_GUARD_MS,
  computeReadingTimestamps,
  decideTransitionGrant,
  shouldGrantFinish,
} from "@/server/reading";

describe("decideTransitionGrant", () => {
  // New entry (prior=undefined) covers the first-log case. The two
  // paying transitions need to emit their grants from a clean slate.
  it("emits start_reading on first-log into reading", () => {
    expect(decideTransitionGrant(undefined, "reading")).toBe("start_reading");
  });

  it("emits finish_reading on first-log into finished (retroactive log)", () => {
    expect(decideTransitionGrant(undefined, "finished")).toBe("finish_reading");
  });

  it("emits nothing on first-log into tbr (no shards for shelving)", () => {
    expect(decideTransitionGrant(undefined, "tbr")).toBeNull();
  });

  // Idempotent writes: a user editing a note on an already-reading
  // book shouldn't trigger another grant. The ledger's partial unique
  // index would block it anyway, but suppressing at this layer keeps
  // the grants[] array honest in the returned response.
  it("emits nothing on reading → reading (idempotent edit)", () => {
    expect(decideTransitionGrant("reading", "reading")).toBeNull();
  });

  it("emits nothing on finished → finished (idempotent edit)", () => {
    expect(decideTransitionGrant("finished", "finished")).toBeNull();
  });

  // Cross-status moves. reading → finished is the happy-path loop.
  it("emits finish_reading on reading → finished", () => {
    expect(decideTransitionGrant("reading", "finished")).toBe("finish_reading");
  });

  // tbr → reading is start-of-session after shelving.
  it("emits start_reading on tbr → reading", () => {
    expect(decideTransitionGrant("tbr", "reading")).toBe("start_reading");
  });

  // Un-finishing (accidental) and re-starting should emit start_reading
  // so the user gets credit for the "reading" session again — the
  // ledger's partial unique index still blocks a duplicate grant, so
  // this just shapes the returned response.
  it("emits start_reading on finished → reading (un-finish)", () => {
    expect(decideTransitionGrant("finished", "reading")).toBe("start_reading");
  });
});

describe("computeReadingTimestamps", () => {
  const now = new Date("2026-04-24T12:00:00Z");

  it("stamps startedAt when entering reading for the first time", () => {
    const r = computeReadingTimestamps("reading", undefined, now);
    expect(r.startedAt).toEqual(now);
    expect(r.finishedAt).toBeNull();
  });

  it("preserves the original startedAt on reading → tbr → reading bounce", () => {
    const original = new Date("2026-03-01T00:00:00Z");
    // Bounce to tbr first — startedAt should survive the round-trip.
    const mid = computeReadingTimestamps(
      "tbr",
      { startedAt: original, finishedAt: null },
      now,
    );
    expect(mid.startedAt).toEqual(original);
    const back = computeReadingTimestamps(
      "reading",
      { startedAt: original, finishedAt: null },
      now,
    );
    expect(back.startedAt).toEqual(original);
  });

  it("stamps finishedAt on first entry into finished", () => {
    const original = new Date("2026-03-01T00:00:00Z");
    const r = computeReadingTimestamps(
      "finished",
      { startedAt: original, finishedAt: null },
      now,
    );
    expect(r.startedAt).toEqual(original);
    expect(r.finishedAt).toEqual(now);
  });

  it("preserves the original finishedAt on finished → reading → finished bounce", () => {
    const original = new Date("2026-03-15T00:00:00Z");
    const r = computeReadingTimestamps(
      "finished",
      { startedAt: null, finishedAt: original },
      now,
    );
    expect(r.finishedAt).toEqual(original);
  });

  it("leaves both null for a brand-new tbr entry", () => {
    const r = computeReadingTimestamps("tbr", undefined, now);
    expect(r.startedAt).toBeNull();
    expect(r.finishedAt).toBeNull();
  });
});

// Minimal fake Drizzle query builder for shouldGrantFinish. The real
// chain is: select().from().where().orderBy().limit(1) → rows. Only
// the terminal `.limit()` returns an awaitable result; everything up
// to it is `this`-chainable.
function makeDb(priorCreatedAt: Date | null) {
  const rows = priorCreatedAt === null ? [] : [{ createdAt: priorCreatedAt }];
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return chain;
}

describe("shouldGrantFinish", () => {
  it("suppresses when no prior start_reading event exists (retroactive log — user is shelving a book they already read, no shards)", async () => {
    const db = makeDb(null);
    await expect(shouldGrantFinish(db, "u1", "b1")).resolves.toBe(false);
  });

  it("grants when the start event is exactly FINISH_GUARD_MS old (boundary: inclusive)", async () => {
    // Timestamp the start event exactly one hour before "now". The
    // guard uses >=, so the boundary must grant. If this flips to
    // false, someone tightened the comparison — worth failing loud.
    const db = makeDb(new Date(Date.now() - FINISH_GUARD_MS));
    await expect(shouldGrantFinish(db, "u1", "b1")).resolves.toBe(true);
  });

  it("grants when the start event is well past the window (days ago)", async () => {
    const db = makeDb(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    await expect(shouldGrantFinish(db, "u1", "b1")).resolves.toBe(true);
  });

  it("suppresses when the start event was just a moment ago (one-tap farm)", async () => {
    const db = makeDb(new Date(Date.now() - 1000));
    await expect(shouldGrantFinish(db, "u1", "b1")).resolves.toBe(false);
  });

  it("suppresses just-under the window (boundary: exclusive)", async () => {
    // 1ms short of the window must NOT grant. Together with the
    // inclusive test above this pins the boundary exactly.
    const db = makeDb(new Date(Date.now() - (FINISH_GUARD_MS - 1)));
    await expect(shouldGrantFinish(db, "u1", "b1")).resolves.toBe(false);
  });
});
