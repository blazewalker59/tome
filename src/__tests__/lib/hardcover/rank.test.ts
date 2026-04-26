/**
 * Ranker tests for `@/lib/hardcover/rank`.
 *
 * Drives the ranker with four real-world Hardcover responses captured
 * from the live API in Apr 2026 (`src/__tests__/_setup/msw/fixtures/
 * hardcover-search-junk/*.json`). Each fixture is a raw GraphQL
 * response — we parse it through the same `parseSearchResults` the
 * server uses, then feed the resulting hits to `rankSearchHits`.
 *
 * The fixture-driven assertions exist to lock down the actual user-
 * visible regressions we set out to fix:
 *   - canonical books surface to the top
 *   - well-known summary publishers (BookRags, Blinkist, …) get
 *     dropped entirely
 *   - derivative-titled hits ("Summary of …", "Workbook for …") get
 *     pushed below clean hits with a machine-readable demote reason
 *
 * Pure-function tests (no fixtures) cover the activation threshold,
 * input non-mutation, and the `_internals` helpers.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  RERANK_MIN_HITS,
  rankSearchHits,
  demoteReasonLabel,
  _internals,
  type DemoteReason,
} from "@/lib/hardcover/rank";
import { parseSearchResults } from "@/server/hardcover";
import type { HardcoverSearchHit } from "@/server/hardcover";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture loaders
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_DIR = resolve(
  process.cwd(),
  "src/__tests__/_setup/msw/fixtures/hardcover-search-junk",
);

function loadFixture(name: string): HardcoverSearchHit[] {
  const raw = JSON.parse(
    readFileSync(resolve(FIXTURE_DIR, `${name}.json`), "utf8"),
  ) as { data?: { search?: { results?: unknown } } };
  return [...parseSearchResults(raw.data?.search?.results, 1, 20).hits];
}

// ─────────────────────────────────────────────────────────────────────────────
// Live-fixture: canonical-book-surfaces tests
// ─────────────────────────────────────────────────────────────────────────────

describe("rankSearchHits — live fixtures", () => {
  it("surfaces 'Sapiens' (Yuval Noah Harari) to position 1", () => {
    const hits = loadFixture("sapiens");
    expect(hits.length).toBeGreaterThanOrEqual(RERANK_MIN_HITS);
    const ranked = rankSearchHits(hits);
    const top = ranked[0];
    expect(top).toBeDefined();
    expect(top.hit.title).toMatch(/sapiens/i);
    expect(top.hit.authorNames.join(", ")).toMatch(/harari/i);
    expect(top.demoted).toBe(false);
  });

  it("surfaces 'Atomic Habits' (James Clear) to position 1", () => {
    const hits = loadFixture("atomic-habits");
    const ranked = rankSearchHits(hits);
    const top = ranked[0];
    expect(top.hit.title).toMatch(/atomic habits/i);
    expect(top.hit.authorNames.join(", ")).toMatch(/clear/i);
    expect(top.demoted).toBe(false);
  });

  it("surfaces 'Outliers' (Malcolm Gladwell) to position 1", () => {
    const hits = loadFixture("outliers");
    const ranked = rankSearchHits(hits);
    const top = ranked[0];
    expect(top.hit.title).toMatch(/outliers/i);
    expect(top.hit.authorNames.join(", ")).toMatch(/gladwell/i);
    expect(top.demoted).toBe(false);
  });

  it("surfaces 'Thinking, Fast and Slow' (Daniel Kahneman) to position 1", () => {
    const hits = loadFixture("thinking-fast-and-slow");
    const ranked = rankSearchHits(hits);
    const top = ranked[0];
    expect(top.hit.title).toMatch(/thinking,?\s*fast/i);
    expect(top.hit.authorNames.join(", ")).toMatch(/kahneman/i);
    expect(top.demoted).toBe(false);
  });

  it("hard-sinks demoted hits below all clean hits", () => {
    // For each fixture, verify the predicate "no clean hit appears
    // after a demoted hit" — that's the "hard sink" guarantee.
    for (const name of [
      "atomic-habits",
      "sapiens",
      "outliers",
      "thinking-fast-and-slow",
    ]) {
      const ranked = rankSearchHits(loadFixture(name));
      let sawDemoted = false;
      for (const r of ranked) {
        if (r.demoted) sawDemoted = true;
        else if (sawDemoted) {
          throw new Error(
            `[${name}] clean hit "${r.hit.title}" appeared after a demoted hit`,
          );
        }
      }
    }
  });

  it("drops publisher-author junk (BookRags, Blinkist, …)", () => {
    // The ranker filters publisher hits before sorting — none of the
    // results should contain any denylisted author fragment.
    const denyNeedles = _internals.PUBLISHER_DENYLIST;
    for (const name of [
      "atomic-habits",
      "sapiens",
      "outliers",
      "thinking-fast-and-slow",
    ]) {
      const ranked = rankSearchHits(loadFixture(name));
      for (const r of ranked) {
        const joined = r.hit.authorNames.join(" | ").toLowerCase();
        for (const needle of denyNeedles) {
          expect(
            joined.includes(needle),
            `[${name}] "${r.hit.title}" by "${joined}" leaked past denylist (needle: "${needle}")`,
          ).toBe(false);
        }
      }
    }
  });

  it("flags derivative titles with a demote reason", () => {
    // Atomic Habits is the densest junk case — assert that the
    // result contains at least one demoted hit and that every
    // demoted hit has a non-null reason matching the title.
    const ranked = rankSearchHits(loadFixture("atomic-habits"));
    const demoted = ranked.filter((r) => r.demoted);
    expect(demoted.length).toBeGreaterThan(0);
    for (const r of demoted) {
      expect(r.demoteReason).not.toBeNull();
      // The reason should correspond to a pattern that the title
      // actually matches — sanity-check via the public matcher.
      expect(_internals.matchTitlePattern(r.hit.title)).toBe(r.demoteReason);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure-function behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("rankSearchHits — pure behavior", () => {
  function hit(overrides: Partial<HardcoverSearchHit> = {}): HardcoverSearchHit {
    return {
      id: 1,
      title: "Some Book",
      subtitle: null,
      authorNames: ["Some Author"],
      releaseYear: 2020,
      rating: null,
      ratingsCount: null,
      coverUrl: null,
      slug: null,
      demoted: false,
      demoteReason: null,
      ...overrides,
    };
  }

  it("does not mutate the input array or its hits", () => {
    const input: HardcoverSearchHit[] = [
      hit({ id: 1, title: "Workbook for Atomic Habits" }),
      hit({ id: 2, title: "Atomic Habits", ratingsCount: 1000, rating: 4.5 }),
      hit({ id: 3, title: "Summary of Atomic Habits" }),
      hit({ id: 4, title: "Plain Book A" }),
      hit({ id: 5, title: "Plain Book B" }),
    ];
    const snapshot = JSON.stringify(input);
    rankSearchHits(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("below RERANK_MIN_HITS preserves input order, still flags demote", () => {
    // 4 hits — under the threshold. Order should be unchanged but
    // junk title should still get demoted=true so the badge renders.
    const input = [
      hit({ id: 1, title: "Real Book" }),
      hit({ id: 2, title: "Summary of Real Book" }),
      hit({ id: 3, title: "Another Real Book" }),
      hit({ id: 4, title: "Workbook for Real Book" }),
    ];
    const ranked = rankSearchHits(input);
    expect(ranked.map((r) => r.hit.id)).toEqual([1, 2, 3, 4]);
    expect(ranked[1].demoted).toBe(true);
    expect(ranked[1].demoteReason).toBe("summary");
    expect(ranked[3].demoted).toBe(true);
    expect(ranked[3].demoteReason).toBe("workbook");
  });

  it("publisher denylist applies even below the activation threshold", () => {
    // 2 hits, one is a BookRags entry — should still be dropped, not
    // just demoted. The threshold guards reranking, not data-quality
    // filtering.
    const ranked = rankSearchHits([
      hit({ id: 1, title: "Real", authorNames: ["Real Author"] }),
      hit({ id: 2, title: "Summary", authorNames: ["BookRags Editors"] }),
    ]);
    expect(ranked.map((r) => r.hit.id)).toEqual([1]);
  });

  it("ranks higher quality clean hits ahead of lower quality ones", () => {
    const input: HardcoverSearchHit[] = [
      hit({ id: 1, title: "A", ratingsCount: 1, rating: 5 }),
      hit({ id: 2, title: "B", ratingsCount: 1000, rating: 4 }),
      hit({ id: 3, title: "C", ratingsCount: 100, rating: 4.5 }),
      hit({ id: 4, title: "D", ratingsCount: 0, rating: 0 }),
      hit({ id: 5, title: "E", ratingsCount: 50, rating: 4 }),
    ];
    const ids = rankSearchHits(input).map((r) => r.hit.id);
    // B (1000 ratings) > C (100) > E (50) > A (1, but 5★) > D (0).
    expect(ids).toEqual([2, 3, 5, 1, 4]);
  });

  it("preserves Typesense order as a tiebreak among clean hits", () => {
    // All hits identical popularity → original order preserved.
    const input: HardcoverSearchHit[] = [
      hit({ id: 10, title: "First" }),
      hit({ id: 20, title: "Second" }),
      hit({ id: 30, title: "Third" }),
      hit({ id: 40, title: "Fourth" }),
      hit({ id: 50, title: "Fifth" }),
    ];
    expect(rankSearchHits(input).map((r) => r.hit.id)).toEqual([
      10, 20, 30, 40, 50,
    ]);
  });

  it("specific-pattern badges win over broad ones (study guide vs guide)", () => {
    // "study guide" must match before the looser "guide to" rule.
    const r = _internals.matchTitlePattern("A Study Guide to Sapiens");
    expect(r).toBe<DemoteReason>("study_guide");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _internals
// ─────────────────────────────────────────────────────────────────────────────

describe("_internals.matchTitlePattern", () => {
  const cases: Array<[string, DemoteReason | null]> = [
    ["Summary of Atomic Habits", "summary"],
    ["Summary: Atomic Habits", "summary"],
    ["SUMMARY OF Atomic Habits", "summary"],
    ["Key insights from Atomic Habits", "summary"],
    ["Workbook for Atomic Habits", "workbook"],
    ["Atomic Habits Workbook", "workbook"],
    ["Sparknotes Study Guide: Sapiens", "study_guide"],
    ["A Study Guide for Outliers", "study_guide"],
    ["An Analysis of Sapiens", "analysis"],
    ["Analysis: Sapiens", "analysis"],
    ["A Guide to Outliers", "guide"],
    ["Companion to Sapiens", "guide"],
    ["Book Review: Atomic Habits", "review"],
    // Genuine titles that should NOT trigger:
    ["Atomic Habits", null],
    ["The Subtle Art", null],
    ["Sapiens", null],
    ["Thinking, Fast and Slow", null],
  ];

  for (const [title, expected] of cases) {
    it(`"${title}" → ${expected ?? "null"}`, () => {
      expect(_internals.matchTitlePattern(title)).toBe(expected);
    });
  }
});

describe("_internals.isPublisherAuthor", () => {
  it("matches case-insensitively as substring", () => {
    expect(_internals.isPublisherAuthor(["BookRags Editors"])).toBe(true);
    expect(_internals.isPublisherAuthor(["bookrags"])).toBe(true);
    expect(_internals.isPublisherAuthor(["BLINKIST"])).toBe(true);
    expect(_internals.isPublisherAuthor(["James Clear"])).toBe(false);
    expect(_internals.isPublisherAuthor([])).toBe(false);
  });
});

describe("_internals.qualityScoreOf", () => {
  it("returns 0 for unrated, no-popularity books", () => {
    expect(
      _internals.qualityScoreOf({
        id: 1,
        title: "x",
        subtitle: null,
        authorNames: [],
        releaseYear: null,
        rating: null,
        ratingsCount: null,
        coverUrl: null,
        slug: null,
        demoted: false,
        demoteReason: null,
      }),
    ).toBe(0);
  });

  it("scales with both ratings count and rating", () => {
    const base: HardcoverSearchHit = {
      id: 1,
      title: "x",
      subtitle: null,
      authorNames: [],
      releaseYear: null,
      rating: 4.0,
      ratingsCount: 1000,
      coverUrl: null,
      slug: null,
      demoted: false,
      demoteReason: null,
    };
    const high = _internals.qualityScoreOf(base);
    const lessRatings = _internals.qualityScoreOf({ ...base, ratingsCount: 10 });
    const lowerRated = _internals.qualityScoreOf({ ...base, rating: 1.0 });
    expect(high).toBeGreaterThan(lessRatings);
    expect(high).toBeGreaterThan(lowerRated);
  });
});

describe("demoteReasonLabel", () => {
  it("returns a human label for every reason", () => {
    const reasons: DemoteReason[] = [
      "summary",
      "workbook",
      "study_guide",
      "analysis",
      "guide",
      "review",
    ];
    for (const r of reasons) {
      const label = demoteReasonLabel(r);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/_/); // labels are spelled out, not snake_case
    }
  });
});
