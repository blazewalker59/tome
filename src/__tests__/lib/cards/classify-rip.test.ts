import { describe, expect, it } from "vitest";
import { classifyRip } from "@/lib/cards/classify-rip";

describe("classifyRip", () => {
  it("classifies all-new pulls as new with no dupes", () => {
    const out = classifyRip(["a", "b", "c"], new Set());
    expect(out.newBookIds).toEqual(["a", "b", "c"]);
    expect(out.duplicateBookIds).toEqual([]);
  });

  it("classifies all-owned pulls as dupes with no new", () => {
    const out = classifyRip(["a", "b"], new Set(["a", "b"]));
    expect(out.newBookIds).toEqual([]);
    expect(out.duplicateBookIds).toEqual(["a", "b"]);
  });

  it("collapses repeats within the same rip into dupes", () => {
    // First A is new; second + third A are dupes against the
    // gained-this-rip set even though A wasn't owned before.
    const out = classifyRip(["a", "a", "a"], new Set());
    expect(out.newBookIds).toEqual(["a"]);
    expect(out.duplicateBookIds).toEqual(["a", "a"]);
  });

  it("regression: owned-then-unowned-twice yields 1 new + 2 dupes", () => {
    // Previously the inline logic in recordRipFn would mis-classify
    // this as 0 new + 3 dupes by mixing index spaces between the
    // filtered-new array and the original pull array.
    const out = classifyRip(["b", "a", "a"], new Set(["b"]));
    expect(out.newBookIds).toEqual(["a"]);
    expect(out.duplicateBookIds).toEqual(["b", "a"]);
  });

  it("preserves pull order for both buckets", () => {
    const out = classifyRip(["c", "a", "b", "a"], new Set(["c"]));
    expect(out.newBookIds).toEqual(["a", "b"]);
    expect(out.duplicateBookIds).toEqual(["c", "a"]);
  });

  it("handles empty pulls", () => {
    const out = classifyRip([], new Set(["x"]));
    expect(out.newBookIds).toEqual([]);
    expect(out.duplicateBookIds).toEqual([]);
  });

  it("each duplicate occurrence is a separate ledger entry", () => {
    // Three repeats of an owned book → three shard refunds.
    const out = classifyRip(["a", "a", "a"], new Set(["a"]));
    expect(out.newBookIds).toEqual([]);
    expect(out.duplicateBookIds).toEqual(["a", "a", "a"]);
  });
});
