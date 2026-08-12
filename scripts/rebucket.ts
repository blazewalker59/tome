/**
 * Recompute rarity buckets for every book in the catalog.
 *
 * Ingestion is intentionally separated from rarity assignment: ingesting
 * a new book (or re-ingesting one to fix its genre) should never reshuffle
 * the global rarity distribution, because rarity is a function of the
 * whole catalog's score distribution, not of any single book. Instead,
 * operators run this script after a batch of ingests (or any time the
 * `ratingsCount` / `averageRating` columns have drifted from Hardcover)
 * to redistribute the five buckets.
 *
 * Mechanics:
 *   1. Load every book's `(id, ratings_count, average_rating)` — the only
 *      columns `assignRarities()` needs. Keeps the working set small.
 *   2. Run the pure `assignRarities()` function to compute new rarities.
 *   3. Diff against current values and write ONLY the rows that changed.
 *      Churn-free runs become a no-op in terms of rows touched, which
 *      makes `updated_at` meaningful.
 *
 * Runs on Node against D1's HTTP API via `./_db` — never on Workers, and
 * never against the local miniflare database.
 *
 * Exit codes:
 *   0 — ran to completion (including "0 changes" no-op runs)
 *   1 — missing D1 credentials or a query failed
 */
import { inArray } from "drizzle-orm";

import { books } from "../src/db/schema";
import { assignRarities } from "../src/lib/cards/rarity";
import { db } from "./_db";
import type { Rarity } from "../src/lib/cards/rarity";

try {
  console.log("[rebucket] loading catalog…");
  const rows = await db
    .select({
      id: books.id,
      ratingsCount: books.ratingsCount,
      averageRating: books.averageRating,
      rarity: books.rarity,
    })
    .from(books);

  console.log(`[rebucket] scoring ${rows.length} books…`);
  const assigned = assignRarities(
    rows.map((r) => ({
      id: r.id,
      ratingsCount: r.ratingsCount ?? 0,
      averageRating: r.averageRating,
    })),
  );

  // Collect diffs grouped by target rarity so we can issue one UPDATE
  // per rarity (5 statements max) using `WHERE id IN (...)`, instead of
  // N per-row updates. Every statement here is an HTTP round trip to
  // D1's API, so this matters even for modest N.
  const changesByRarity = new Map<Rarity, Array<string>>();
  let unchanged = 0;
  for (const row of rows) {
    const next = assigned.get(row.id);
    if (!next) continue; // defensive — assignRarities covers every input
    if (next === row.rarity) {
      unchanged++;
      continue;
    }
    const bucket = changesByRarity.get(next) ?? [];
    bucket.push(row.id);
    changesByRarity.set(next, bucket);
  }

  const changed = rows.length - unchanged;
  if (changed === 0) {
    console.log(
      `[rebucket] ✓ no changes (${rows.length} books already bucketed)`,
    );
  } else {
    console.log(
      `[rebucket] applying ${changed} changes (${unchanged} already correct)…`,
    );
    // Sequential rather than transactional: the sqlite-proxy driver issues
    // one HTTP call per statement and D1's API has no cross-request
    // transaction. Re-running the script is safe (it is idempotent — it
    // recomputes buckets from scratch), so a partial application just means
    // running it again.
    for (const [rarity, ids] of changesByRarity) {
      await db
        .update(books)
        .set({ rarity, updatedAt: new Date() })
        .where(inArray(books.id, ids));
      console.log(`[rebucket]   → ${rarity}: ${ids.length}`);
    }
    console.log("[rebucket] ✓ done");
  }

  // Summary distribution so the operator can sanity-check the outcome.
  const distribution = new Map<Rarity, number>();
  for (const r of assigned.values()) {
    distribution.set(r, (distribution.get(r) ?? 0) + 1);
  }
  const order: Array<Rarity> = [
    "legendary",
    "foil",
    "rare",
    "uncommon",
    "common",
  ];
  console.log("[rebucket] distribution:");
  for (const r of order) {
    const n = distribution.get(r) ?? 0;
    const pct = rows.length === 0 ? 0 : ((n / rows.length) * 100).toFixed(1);
    console.log(
      `[rebucket]   ${r.padEnd(9)} ${String(n).padStart(4)}  (${pct}%)`,
    );
  }
} catch (err) {
  console.error("[rebucket] ✗ failed:", err);
  process.exitCode = 1;
}
