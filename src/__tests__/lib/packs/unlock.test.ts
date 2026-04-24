import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Publish-unlock status tests.
 *
 * `getPublishUnlockStatus` reads two collaborators — the economy
 * config (for the threshold) and the db (for the finished-book count)
 * — and returns a structured `{eligible, finishedBooks, threshold}`.
 * Both collaborators are mocked: standing up a real db requires a
 * Worker context, and the config reader has its own tests. What we
 * care about here is the threshold math and the null-row safety.
 */

let finishedCount: number | null = 0;
let threshold = 3;

vi.mock("@/db/client", () => ({
  getDb: async () => ({
    select: () => ({
      from: () => ({
        where: async () =>
          finishedCount === null ? [] : [{ n: finishedCount }],
      }),
    }),
  }),
}));

vi.mock("@/lib/economy/config", () => ({
  getEconomy: async () => ({
    publishUnlock: { finishedBookThreshold: threshold },
  }),
}));

import { getPublishUnlockStatus } from "@/lib/packs/unlock";

beforeEach(() => {
  finishedCount = 0;
  threshold = 3;
});

describe("getPublishUnlockStatus", () => {
  it("reports not-eligible with zero finished books under a positive threshold", async () => {
    finishedCount = 0;
    threshold = 3;
    await expect(getPublishUnlockStatus("u1")).resolves.toEqual({
      eligible: false,
      finishedBooks: 0,
      threshold: 3,
    });
  });

  it("flips eligible at the threshold boundary (>=, not >)", async () => {
    // Threshold is inclusive — exactly `threshold` finished books is
    // enough to publish. Test both sides of the boundary so a future
    // refactor to `>` would fail loudly.
    finishedCount = 3;
    threshold = 3;
    await expect(getPublishUnlockStatus("u1")).resolves.toMatchObject({
      eligible: true,
      finishedBooks: 3,
    });

    finishedCount = 2;
    await expect(getPublishUnlockStatus("u1")).resolves.toMatchObject({
      eligible: false,
      finishedBooks: 2,
    });
  });

  it("remains eligible well above the threshold", async () => {
    finishedCount = 42;
    threshold = 3;
    await expect(getPublishUnlockStatus("u1")).resolves.toMatchObject({
      eligible: true,
      finishedBooks: 42,
    });
  });

  it("treats a zero threshold as 'publishing always unlocked'", async () => {
    // Operators might turn the unlock off entirely by setting the
    // threshold to 0. Defensive check — the count can be 0 and we
    // still expect eligible=true.
    finishedCount = 0;
    threshold = 0;
    await expect(getPublishUnlockStatus("u1")).resolves.toEqual({
      eligible: true,
      finishedBooks: 0,
      threshold: 0,
    });
  });

  it("treats a missing count row as zero finished books", async () => {
    // Drizzle returns [] when no rows match; the helper coerces to 0
    // rather than NaN/undefined so arithmetic elsewhere can't trip.
    finishedCount = null;
    threshold = 3;
    await expect(getPublishUnlockStatus("u1")).resolves.toEqual({
      eligible: false,
      finishedBooks: 0,
      threshold: 3,
    });
  });
});
