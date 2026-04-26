/**
 * Hardcover search-result ranker.
 *
 * Hardcover's `search` field is backed by Typesense. The hits come back
 * in pure text-relevance order with no quality signal applied — which
 * means a query like "atomic habits" returns the canonical James Clear
 * book at position 1 but immediately follows it with seven summaries,
 * workbooks, and study guides; "sapiens" buries Yuval Noah Harari's
 * book at position 10 behind eight near-empty namesake entries with
 * zero ratings. None of those are useful to a Tome user, who is always
 * trying to add a *real book* to a pack, reading log, or catalog.
 *
 * This module is the single place we re-rank Hardcover hits. The
 * pipeline (per-hit, then sort) is:
 *
 *   1. Drop hits whose author is on the publisher denylist (BookRags,
 *      Blinkist, etc.) — these are bad-faith publishers who never make
 *      a legitimate book. The drop is the only place we destroy data;
 *      everything else is reordering.
 *   2. Mark hits whose *title* matches a derivative pattern ("Summary
 *      of", "Workbook for", "A Guide to", etc.) as `demoted` with a
 *      machine-readable reason. We don't drop these because a real
 *      book might be legitimately titled "Summary of My Life" — better
 *      to bury it at the bottom with a visible badge than disappear it
 *      entirely.
 *   3. Compute a quality score from `ratings_count` (log-compressed)
 *      and `rating` (0–5, normalized to a [0.5, 1.0] multiplier so
 *      unrated books stay at half-weight rather than collapsing to
 *      zero). Sort clean hits by quality desc; demoted hits always sit
 *      below clean ones; demoted hits among themselves preserve
 *      Typesense's order so the original text-relevance signal still
 *      shows through.
 *
 * The ranker is pure: same input → same output, no I/O, no Date.now,
 * no globals. That's what makes the live-fixture tests in
 * `src/__tests__/lib/hardcover/rank.test.ts` work.
 *
 * Activation: callers should only re-rank when there are at least
 * `RERANK_MIN_HITS` candidates. Below that, Typesense's order is
 * trusted — a query with <5 matches has too little signal for the
 * quality formula to add value, and a single niche match shouldn't
 * be repositioned.
 */

import type { HardcoverSearchHit } from "@/server/hardcover";

/**
 * Activation floor. Below this, the ranker is a no-op (returns the
 * input slice unchanged). Above this, the full denylist + rerank
 * pipeline runs.
 *
 * Rationale: a 1- or 2-hit query has no ranking ambiguity to resolve.
 * 5 is the same threshold the local-search-vs-Hardcover gating uses
 * (`LOCAL_SPARSE_THRESHOLD` in user-packs.ts), keeping a single
 * "what's a sparse result set" notion across the codebase.
 */
export const RERANK_MIN_HITS = 5;

/**
 * Why a hit was demoted. The UI uses this as the badge label so users
 * can see *what* the heuristic flagged, not just "low quality." The
 * order of the keys also serves as a precedence — if a hit matches
 * multiple patterns, the first matching one wins.
 */
export type DemoteReason =
  | "summary"
  | "workbook"
  | "study_guide"
  | "analysis"
  | "guide"
  | "review";

/**
 * Author-name fragments that indicate a junk publisher posing as an
 * author. Match is case-insensitive, substring (not whole-word) so
 * "BookRags Editors" / "BookRags" / "BookRags Studios" all hit. Hits
 * whose author list contains ANY of these are dropped from results
 * entirely, not just demoted: a "BookRags Editors" book is never a
 * legitimate book a Tome user would want.
 *
 * Sourced from observed junk in live API responses (Apr 2026):
 * "atomic habits", "sapiens", "thinking fast and slow", "outliers".
 * Each entry is a publisher whose entire output is summary or
 * workbook content — Hardcover unfortunately indexes these under
 * `author_names` instead of a publisher field.
 */
const PUBLISHER_DENYLIST: ReadonlyArray<string> = [
  "bookrags",
  "blinkist",
  "50minutes",
  "essentialinsight summaries",
  "essentialinsight",
  "key notes",
  "podium press",
  "life lessons",
  "companion works",
  "in a nutshell publishing",
  "la moneda publishing",
  "thinker mindset",
  "maxhelp workbooks",
  "joosr",
  "smart reads",
  "daily books",
  "bookhabits",
  "sparknotes",
  "cliffsnotes",
  "instaread",
  "quickread",
  "milkyway media",
];

/**
 * Title patterns that indicate a derivative work. Each entry is
 * `{ pattern, reason }`. The pattern is a regex run against the
 * lowercased title; the reason becomes the `demoteReason` and
 * surfaces in the UI badge.
 *
 * Order matters: matched in declaration order, first hit wins. The
 * most specific patterns ("study guide", "workbook") come before the
 * broader ones ("guide to") so the badge text stays accurate.
 */
const TITLE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  reason: DemoteReason;
}> = [
  // "Summary of X" / "Summary: X" / "SUMMARY OF X" / "Summary by X".
  // Trailing alternation has no `\b` because `:` is non-word, so a
  // word-boundary between `:` and a space fails — `(of|by)\b` for
  // word alternates, bare `:` for the colon variant.
  { pattern: /\bsummary\s*(?::|(?:of|by)\b)/i, reason: "summary" },
  // "Key insights from X" — Blinkist's signature
  { pattern: /\bkey insights from\b/i, reason: "summary" },
  // "Workbook for X" / "Workbook: X"
  { pattern: /\bworkbook\b/i, reason: "workbook" },
  // "Study Guide" / "Sparknotes Study Guide"
  { pattern: /\bstudy guide\b/i, reason: "study_guide" },
  // "An Analysis of X" / "Analysis: X". Same `\b` caveat as Summary.
  { pattern: /\banalysis\s*(?::|(?:of)\b)/i, reason: "analysis" },
  // "A Guide to X" / "Guide to X" — broader, runs after "study guide"
  { pattern: /\bguide to\b/i, reason: "guide" },
  // "Companion to X" — usually a study companion
  { pattern: /\bcompanion to\b/i, reason: "guide" },
  // "Book Review: X" / "Review of X" — Blinkist-style summary reviews
  { pattern: /\bbook review\b/i, reason: "review" },
  // "Cliff's Notes" / "Cliffs Notes" / "Sparknotes" appearing in title
  { pattern: /\b(cliff'?s notes|sparknotes)\b/i, reason: "study_guide" },
];

/**
 * Output of the ranker. Wraps the raw hit with three computed fields
 * the caller can either consume directly (badges) or ignore (just use
 * the order). Score is exposed for debugging / tuning, not used by
 * the UI.
 */
export interface RankedHit {
  hit: HardcoverSearchHit;
  /** True when the hit matched a title-pattern denylist entry. Sits
   *  below all clean hits in the returned order. */
  demoted: boolean;
  /** Machine-readable label for the badge. Null on clean hits. */
  demoteReason: DemoteReason | null;
  /** Quality score; higher is better. Stable shape but the absolute
   *  values are tuning-dependent and shouldn't be exposed in UI. */
  qualityScore: number;
}

/**
 * Re-rank a list of Hardcover search hits. See module header for the
 * full pipeline. Pure: returns a new array; never mutates the input.
 *
 * If `hits.length < RERANK_MIN_HITS`, returns each hit wrapped with
 * `demoted: false` in original order — the threshold guard prevents
 * us from second-guessing Typesense on small result sets while still
 * giving the caller a uniform shape to work with.
 */
export function rankSearchHits(
  hits: ReadonlyArray<HardcoverSearchHit>,
): RankedHit[] {
  // Always drop publisher-author hits — even on small result sets.
  // The denylist is a pure data-quality filter, independent of the
  // re-rank threshold. A 1-hit query that returns "BookRags Editors"
  // is a 0-hit query, not "trust the only match."
  const filtered = hits.filter((h) => !isPublisherAuthor(h.authorNames));

  if (filtered.length < RERANK_MIN_HITS) {
    // Small result set: preserve order, skip the rerank, but still
    // compute the demote flag so the UI can badge derivative-titled
    // hits even in tiny lists.
    return filtered.map((hit, idx) => {
      const reason = matchTitlePattern(hit.title);
      return {
        hit,
        demoted: reason !== null,
        demoteReason: reason,
        qualityScore: qualityScoreOf(hit) - idx * 1e-6,
      };
    });
  }

  // Annotate each hit with its junk classification + score, then sort.
  const annotated = filtered.map((hit, originalPosition) => {
    const reason = matchTitlePattern(hit.title);
    return {
      hit,
      demoted: reason !== null,
      demoteReason: reason,
      qualityScore: qualityScoreOf(hit),
      originalPosition,
    };
  });

  annotated.sort((a, b) => {
    // Demoted hits always rank below clean ones — that's the "hard
    // sink" guarantee. Within each tier we sort by quality desc,
    // tiebreak by original Typesense position so deterministic.
    if (a.demoted !== b.demoted) return a.demoted ? 1 : -1;
    if (b.qualityScore !== a.qualityScore) {
      return b.qualityScore - a.qualityScore;
    }
    return a.originalPosition - b.originalPosition;
  });

  return annotated.map(({ hit, demoted, demoteReason, qualityScore }) => ({
    hit,
    demoted,
    demoteReason,
    qualityScore,
  }));
}

/**
 * Quality formula. Combines popularity (log-compressed `ratings_count`)
 * with average rating (normalized to a [0.5, 1.0] multiplier so an
 * unrated book lands at exactly half the popularity contribution
 * rather than zero). Returns 0 for completely unrated, no-popularity
 * books — those tie among themselves and fall back to original
 * Typesense order via the sort tiebreak.
 *
 * Examples (computed for sanity):
 *   ratings=1670, rating=4.15  → log2(1671) * 0.915 ≈ 9.84
 *   ratings=2,    rating=5.00  → log2(3)    * 1.000 ≈ 1.58
 *   ratings=0,    rating=0.00  → 0
 * That spread is exactly what we need: the canonical book wins by
 * ~6× over a single 5-star namesake.
 */
function qualityScoreOf(hit: HardcoverSearchHit): number {
  const ratings = Math.max(0, hit.ratingsCount ?? 0);
  const rating = Math.max(0, Math.min(5, hit.rating ?? 0));
  const popularity = Math.log2(ratings + 1);
  // 0 → 0.5, 5 → 1.0; linear in between. The 0.5 floor keeps unrated
  // popular books from being eclipsed by lesser-known but rated ones.
  const ratingMultiplier = 0.5 + 0.1 * rating;
  return popularity * ratingMultiplier;
}

/**
 * Test if any author name in the list matches the publisher denylist.
 * Case-insensitive substring match — denylist entries are kept lowercase
 * and we lowercase the input to compare. Substring (rather than equality)
 * because real-world author names append suffixes ("BookRags Editors",
 * "Sparknotes Editorial Team").
 */
function isPublisherAuthor(authors: ReadonlyArray<string>): boolean {
  if (authors.length === 0) return false;
  for (const a of authors) {
    const lc = a.toLowerCase();
    for (const needle of PUBLISHER_DENYLIST) {
      if (lc.includes(needle)) return true;
    }
  }
  return false;
}

/**
 * Run the title against the demote patterns; return the first match's
 * reason, or null if the title looks clean.
 */
function matchTitlePattern(title: string | null): DemoteReason | null {
  if (!title) return null;
  for (const { pattern, reason } of TITLE_PATTERNS) {
    if (pattern.test(title)) return reason;
  }
  return null;
}

/**
 * Human-readable label for a demote reason. Used as the small badge
 * text next to demoted hits. Kept here (not in the UI files) so all
 * surfaces use the same vocabulary.
 */
export function demoteReasonLabel(reason: DemoteReason): string {
  switch (reason) {
    case "summary":
      return "Summary";
    case "workbook":
      return "Workbook";
    case "study_guide":
      return "Study guide";
    case "analysis":
      return "Analysis";
    case "guide":
      return "Guide";
    case "review":
      return "Review";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test surface
// ─────────────────────────────────────────────────────────────────────────────

export const _internals = {
  PUBLISHER_DENYLIST,
  TITLE_PATTERNS,
  isPublisherAuthor,
  matchTitlePattern,
  qualityScoreOf,
};
