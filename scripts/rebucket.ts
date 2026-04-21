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
 *   3. Diff against current values and write ONLY the rows that changed,
 *      inside a single transaction. Churn-free runs become a no-op in
 *      terms of rows touched, which makes `updated_at` meaningful.
 *
 * Same runtime posture as `migrate.ts` / `seed.ts`: Node + `postgres-js`
 * against the pooled Neon URL. Never runs on Workers.
 *
 * Exit codes:
 *   0 — ran to completion (including "0 changes" no-op runs)
 *   1 — missing DATABASE_URL or a query failed
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { books } from "../src/db/schema";
import { assignRarities, type Rarity } from "../src/lib/cards/rarity";

const url = process.env.DATABASE_URL;

if (!url) {
  console.error(
    "[rebucket] Missing DATABASE_URL. Set it in .env.local — see .env.example.",
  );
  process.exit(1);
}

const client = postgres(url, { max: 1 });
const db = drizzle(client);

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
  // per rarity (5 statements max) using `WHERE id = ANY($1)`, instead
  // of N per-row updates. On Neon each round trip is network latency,
  // so this matters even for modest N.
  const changesByRarity = new Map<Rarity, string[]>();
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
    console.log(`[rebucket] ✓ no changes (${rows.length} books already bucketed)`);
  } else {
    console.log(`[rebucket] applying ${changed} changes (${unchanged} already correct)…`);
    await db.transaction(async (tx) => {
      for (const [rarity, ids] of changesByRarity) {
        await tx
          .update(books)
          .set({ rarity, updatedAt: sql`now()` })
          .where(inArray(books.id, ids));
        console.log(`[rebucket]   → ${rarity}: ${ids.length}`);
      }
    });
    console.log("[rebucket] ✓ done");
  }

  // Summary distribution so the operator can sanity-check the outcome.
  const distribution = new Map<Rarity, number>();
  for (const r of assigned.values()) {
    distribution.set(r, (distribution.get(r) ?? 0) + 1);
  }
  const order: Rarity[] = ["legendary", "foil", "rare", "uncommon", "common"];
  console.log("[rebucket] distribution:");
  for (const r of order) {
    const n = distribution.get(r) ?? 0;
    const pct = rows.length === 0 ? 0 : ((n / rows.length) * 100).toFixed(1);
    console.log(`[rebucket]   ${r.padEnd(9)} ${String(n).padStart(4)}  (${pct}%)`);
  }
} catch (err) {
  console.error("[rebucket] ✗ failed:", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
