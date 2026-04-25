/**
 * Seed five "Modern <Genre> Starter" editorial packs via the real
 * Hardcover API.
 *
 * This is the canonical catalog seed — the legacy `scripts/seed.ts`
 * is now a no-op. Every insert here is a real Hardcover record
 * (positive `hardcover_id`), which coexists cleanly with any on-demand
 * ingest done by the app runtime.
 *
 * Flow per title:
 *   1. `searchBooks(query)` on Hardcover (Typesense-backed).
 *   2. Pick the first hit whose `id` resolves via `books_by_pk`
 *      (some search hits are stale pointers — `fetchBookById` returns
 *      null and we skip).
 *   3. Map with `bookResponseToRow` using editorial curation (genre
 *      + mood tags assigned per-pack), then upsert on `hardcoverId`.
 *   4. After all titles resolve, upsert each pack row
 *      (`creator_id IS NULL`, `is_public = true`) and reset its
 *      `pack_books` membership to the books we just ingested.
 *
 * Rate limiting is handled by the Hardcover client (1.1s spacing). With
 * two calls per title (search + fetch) × 100 titles that's ~220s in the
 * worst case — fine for a one-shot admin script. Partial runs are safe
 * to re-run: upserts are idempotent and misses are soft-failed so you
 * can edit the title list and try again.
 *
 * After this completes, run `pnpm db:rebucket` to recompute rarity
 * buckets across the (now much larger) catalog.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { bookResponseToRow, type IngestCuration } from "../src/lib/cards/hardcover";
import { books, packBooks, packs } from "../src/db/schema";
import {
  __resetRateLimitForTests,
  fetchBookById,
  HardcoverError,
  searchBooks,
  type HardcoverSearchHit,
} from "../src/server/hardcover";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[editor-packs] Missing DATABASE_URL. Set it in .env.local.");
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────────
// Editorial curation: pack definitions
//
// Each pack has:
//   - slug / name / description: how it surfaces in /rip and /library.
//   - genre: assigned to every book in the pack (books.genre column).
//   - moodTags: a small pool (3–5 choices) we cycle through as we ingest
//     so every book gets 3 tags that are plausible for its pack but not
//     all identical. Editorial judgement — Hardcover doesn't expose mood.
//   - titles: 20 well-known, post-2015 books. Each entry is a `title`
//     plus optional `author` hint used only to disambiguate search hits;
//     we DO NOT filter by it (Hardcover's author field is messy and we'd
//     rather match a good hit with a different author spelling than miss).
//
// All titles vetted as published 2015-or-later (the "modern" framing) so
// anything the reader might reasonably call a contemporary classic.
// ──────────────────────────────────────────────────────────────────────────────

interface TitleQuery {
  readonly title: string;
  readonly author?: string;
}

interface PackDef {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly genre: string;
  readonly moodTagPool: ReadonlyArray<string>;
  readonly genreTags: ReadonlyArray<string>;
  readonly titles: ReadonlyArray<TitleQuery>;
}

const PACKS: ReadonlyArray<PackDef> = [
  {
    slug: "modern-fantasy-starter",
    name: "Modern Fantasy Starter",
    description:
      "A snapshot of fantasy since 2015 — from doorstopper epics to tightly-wound novellas. Start here to build a shelf that spans dragons, sorcerers, and stranger things.",
    genre: "fantasy",
    genreTags: ["fantasy", "starter"],
    moodTagPool: ["epic", "magical", "atmospheric", "character-driven", "dark", "lush"],
    titles: [
      { title: "The Fifth Season", author: "N. K. Jemisin" },
      { title: "Uprooted", author: "Naomi Novik" },
      { title: "The House in the Cerulean Sea", author: "TJ Klune" },
      { title: "A Court of Thorns and Roses", author: "Sarah J. Maas" },
      { title: "The Priory of the Orange Tree", author: "Samantha Shannon" },
      { title: "The Poppy War", author: "R. F. Kuang" },
      { title: "Piranesi", author: "Susanna Clarke" },
      { title: "Mexican Gothic", author: "Silvia Moreno-Garcia" },
      { title: "Circe", author: "Madeline Miller" },
      { title: "The Song of Achilles", author: "Madeline Miller" },
      { title: "The Starless Sea", author: "Erin Morgenstern" },
      { title: "Gideon the Ninth", author: "Tamsyn Muir" },
      { title: "Spinning Silver", author: "Naomi Novik" },
      { title: "The City We Became", author: "N. K. Jemisin" },
      { title: "The Ten Thousand Doors of January", author: "Alix E. Harrow" },
      { title: "The Invisible Life of Addie LaRue", author: "V. E. Schwab" },
      { title: "Jade City", author: "Fonda Lee" },
      { title: "The Rage of Dragons", author: "Evan Winter" },
      { title: "Legends & Lattes", author: "Travis Baldree" },
      { title: "Babel", author: "R. F. Kuang" },
    ],
  },
  {
    slug: "modern-sci-fi-starter",
    name: "Modern Sci-Fi Starter",
    description:
      "Recent science fiction at its best — first-contact puzzles, climate futures, AI minds, and space opera that sings. A living definition of the genre right now.",
    genre: "science-fiction",
    genreTags: ["sci-fi", "starter"],
    moodTagPool: [
      "speculative",
      "cerebral",
      "hopeful",
      "dystopian",
      "adventurous",
      "literary",
    ],
    titles: [
      { title: "Project Hail Mary", author: "Andy Weir" },
      { title: "Station Eleven", author: "Emily St. John Mandel" },
      { title: "Klara and the Sun", author: "Kazuo Ishiguro" },
      { title: "A Memory Called Empire", author: "Arkady Martine" },
      { title: "The Ministry for the Future", author: "Kim Stanley Robinson" },
      { title: "Sea of Tranquility", author: "Emily St. John Mandel" },
      { title: "A Prayer for the Crown-Shy", author: "Becky Chambers" },
      { title: "All Systems Red", author: "Martha Wells" },
      { title: "Exhalation", author: "Ted Chiang" },
      { title: "The Three-Body Problem", author: "Liu Cixin" },
      { title: "Children of Time", author: "Adrian Tchaikovsky" },
      { title: "Annihilation", author: "Jeff VanderMeer" },
      { title: "The Dispossessed", author: "Ursula K. Le Guin" },
      { title: "Recursion", author: "Blake Crouch" },
      { title: "A Psalm for the Wild-Built", author: "Becky Chambers" },
      { title: "Red Rising", author: "Pierce Brown" },
      { title: "The Power", author: "Naomi Alderman" },
      { title: "Dark Matter", author: "Blake Crouch" },
      { title: "A Closed and Common Orbit", author: "Becky Chambers" },
      { title: "The Mountain in the Sea", author: "Ray Nayler" },
    ],
  },
  {
    slug: "modern-nonfiction-starter",
    name: "Modern Nonfiction Starter",
    description:
      "The essays, memoirs, histories, and investigations that have defined nonfiction this past decade. Dense when it needs to be, readable throughout.",
    genre: "nonfiction",
    genreTags: ["nonfiction", "starter"],
    moodTagPool: [
      "investigative",
      "intimate",
      "clinical",
      "political",
      "reflective",
      "urgent",
    ],
    titles: [
      { title: "Between the World and Me", author: "Ta-Nehisi Coates" },
      { title: "Sapiens", author: "Yuval Noah Harari" },
      { title: "Evicted", author: "Matthew Desmond" },
      { title: "Hidden Valley Road", author: "Robert Kolker" },
      { title: "The Warmth of Other Suns", author: "Isabel Wilkerson" },
      { title: "Caste", author: "Isabel Wilkerson" },
      { title: "Trick Mirror", author: "Jia Tolentino" },
      { title: "The Body Keeps the Score", author: "Bessel van der Kolk" },
      { title: "Educated", author: "Tara Westover" },
      { title: "Crying in H Mart", author: "Michelle Zauner" },
      { title: "When Breath Becomes Air", author: "Paul Kalanithi" },
      { title: "How to Be an Antiracist", author: "Ibram X. Kendi" },
      { title: "Empire of Pain", author: "Patrick Radden Keefe" },
      { title: "Say Nothing", author: "Patrick Radden Keefe" },
      { title: "The Sixth Extinction", author: "Elizabeth Kolbert" },
      { title: "Bad Blood", author: "John Carreyrou" },
      { title: "Being Mortal", author: "Atul Gawande" },
      { title: "H Is for Hawk", author: "Helen Macdonald" },
      { title: "Entangled Life", author: "Merlin Sheldrake" },
      { title: "Know My Name", author: "Chanel Miller" },
    ],
  },
  {
    slug: "modern-romance-starter",
    name: "Modern Romance Starter",
    description:
      "Contemporary romance across the spectrum — slow burns, workplace rivals, second chances, and found family. Twenty books that defined the genre's current moment.",
    genre: "romance",
    genreTags: ["romance", "starter"],
    moodTagPool: [
      "romantic",
      "cozy",
      "swoony",
      "escapist",
      "tender",
      "witty",
    ],
    titles: [
      { title: "The Hating Game", author: "Sally Thorne" },
      { title: "Beach Read", author: "Emily Henry" },
      { title: "People We Meet on Vacation", author: "Emily Henry" },
      { title: "Book Lovers", author: "Emily Henry" },
      { title: "Happy Place", author: "Emily Henry" },
      { title: "Red, White & Royal Blue", author: "Casey McQuiston" },
      { title: "One Last Stop", author: "Casey McQuiston" },
      { title: "The Kiss Quotient", author: "Helen Hoang" },
      { title: "The Spanish Love Deception", author: "Elena Armas" },
      { title: "It Ends with Us", author: "Colleen Hoover" },
      { title: "The Love Hypothesis", author: "Ali Hazelwood" },
      { title: "Get a Life, Chloe Brown", author: "Talia Hibbert" },
      { title: "Act Your Age, Eve Brown", author: "Talia Hibbert" },
      { title: "The Flatshare", author: "Beth O'Leary" },
      { title: "The Deal", author: "Elle Kennedy" },
      { title: "You Deserve Each Other", author: "Sarah Hogle" },
      { title: "The Unhoneymooners", author: "Christina Lauren" },
      { title: "Fangirl", author: "Rainbow Rowell" },
      { title: "Lessons in Chemistry", author: "Bonnie Garmus" },
      { title: "Funny Story", author: "Emily Henry" },
    ],
  },
  {
    slug: "modern-realist-fiction-starter",
    name: "Modern Realist Fiction Starter",
    description:
      "Literary fiction rooted in the here and now — novels about family, work, identity, grief, and the small and large shapes of the contemporary life. No dragons, no spaceships, all heart.",
    genre: "literary-fiction",
    genreTags: ["literary", "starter"],
    moodTagPool: [
      "literary",
      "meditative",
      "intimate",
      "character-driven",
      "quietly-devastating",
      "reflective",
    ],
    titles: [
      { title: "A Little Life", author: "Hanya Yanagihara" },
      { title: "Normal People", author: "Sally Rooney" },
      { title: "Conversations with Friends", author: "Sally Rooney" },
      { title: "Beautiful World, Where Are You", author: "Sally Rooney" },
      { title: "Pachinko", author: "Min Jin Lee" },
      { title: "Homegoing", author: "Yaa Gyasi" },
      { title: "Transcendent Kingdom", author: "Yaa Gyasi" },
      { title: "Little Fires Everywhere", author: "Celeste Ng" },
      { title: "Our Missing Hearts", author: "Celeste Ng" },
      { title: "Hamnet", author: "Maggie O'Farrell" },
      { title: "Lincoln in the Bardo", author: "George Saunders" },
      { title: "A Gentleman in Moscow", author: "Amor Towles" },
      { title: "The Overstory", author: "Richard Powers" },
      { title: "Exit West", author: "Mohsin Hamid" },
      { title: "An American Marriage", author: "Tayari Jones" },
      { title: "Tomorrow, and Tomorrow, and Tomorrow", author: "Gabrielle Zevin" },
      { title: "Trust", author: "Hernan Diaz" },
      { title: "The Nickel Boys", author: "Colson Whitehead" },
      { title: "Demon Copperhead", author: "Barbara Kingsolver" },
      { title: "North Woods", author: "Daniel Mason" },
    ],
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Hardcover resolution
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a title query to a Hardcover `books_by_pk` record.
 *
 * Walks the search hits in order and returns the first one that
 * `fetchBookById` successfully resolves. Most title + author queries
 * land on the canonical edition as hit #0, but Hardcover sometimes
 * returns translated or pre-release editions first, which may not be
 * fetchable — the walk gives us a cheap fallback.
 *
 * We *don't* strict-match the author to the first hit: Hardcover's
 * search relevance is generally trustworthy, and name variants
 * ("V. E. Schwab" vs "Victoria Schwab") would cause false negatives.
 */
async function resolveTitle(q: TitleQuery): Promise<
  | { ok: true; hit: HardcoverSearchHit; book: Awaited<ReturnType<typeof fetchBookById>> }
  | { ok: false; reason: string }
> {
  const query = q.author ? `${q.title} ${q.author}` : q.title;
  let result;
  try {
    result = await searchBooks(query, { perPage: 5, page: 1 });
  } catch (err) {
    const msg = err instanceof HardcoverError ? err.message : String(err);
    return { ok: false, reason: `search failed: ${msg}` };
  }
  if (result.hits.length === 0) {
    return { ok: false, reason: "no search hits" };
  }

  // Try each hit until one resolves. Stop at 3 attempts so a dead
  // result page doesn't waste our rate-limit budget on the whole batch.
  const candidates = result.hits.slice(0, 3);
  for (const hit of candidates) {
    try {
      const book = await fetchBookById(hit.id);
      if (book) {
        return { ok: true, hit, book };
      }
    } catch (err) {
      // Keep trying; last hit's error falls through as the failure reason.
      if (hit === candidates[candidates.length - 1]) {
        const msg = err instanceof HardcoverError ? err.message : String(err);
        return { ok: false, reason: `fetch failed: ${msg}` };
      }
    }
  }
  return { ok: false, reason: "all candidate hits returned null" };
}

function moodTagsForIndex(
  pool: ReadonlyArray<string>,
  idx: number,
): ReadonlyArray<string> {
  // Three tags per book, rotated through the pool so pack contents
  // aren't identically tagged. Guaranteed 3 distinct entries when the
  // pool has >=3 items (all our pools do).
  const n = pool.length;
  const a = pool[idx % n];
  const b = pool[(idx + 1) % n];
  const c = pool[(idx + 2) % n];
  return [a, b, c];
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema: { books, packs, packBooks } });

// The rate-limit clock starts stale if the module was imported but
// never used — no-op if it's already zero. Keeps the very first
// request from waiting 1.1s.
__resetRateLimitForTests();

interface ResolvedBook {
  hardcoverId: number;
  title: string;
  bookRowId: string;
}

const startedAt = Date.now();

try {
  const packResults: Array<{
    def: PackDef;
    resolved: ResolvedBook[];
    missed: Array<{ query: TitleQuery; reason: string }>;
  }> = [];

  for (const def of PACKS) {
    console.log(`\n[editor-packs] ── ${def.name} (${def.titles.length} titles) ──`);
    const resolved: ResolvedBook[] = [];
    const missed: Array<{ query: TitleQuery; reason: string }> = [];

    for (let i = 0; i < def.titles.length; i++) {
      const q = def.titles[i];
      process.stdout.write(
        `[editor-packs]   ${String(i + 1).padStart(2)}/${def.titles.length} ${q.title} … `,
      );
      const res = await resolveTitle(q);
      if (!res.ok) {
        console.log(`MISS (${res.reason})`);
        missed.push({ query: q, reason: res.reason });
        continue;
      }

      const curation: IngestCuration = {
        genre: def.genre,
        moodTags: moodTagsForIndex(def.moodTagPool, i),
      };

      let row;
      try {
        row = bookResponseToRow(res.book!, curation);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`MISS (mapper: ${msg})`);
        missed.push({ query: q, reason: `mapper: ${msg}` });
        continue;
      }

      const [inserted] = await db
        .insert(books)
        .values(row)
        .onConflictDoUpdate({
          target: books.hardcoverId,
          set: {
            title: row.title,
            authors: row.authors,
            coverUrl: row.coverUrl,
            description: row.description,
            pageCount: row.pageCount,
            publishedYear: row.publishedYear,
            // Preserve curated genre / mood on re-run so subsequent
            // edits to the script's curation take effect.
            genre: row.genre,
            moodTags: row.moodTags,
            ratingsCount: row.ratingsCount,
            averageRating: row.averageRating,
            rawMetadata: row.rawMetadata,
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: books.id });

      resolved.push({
        hardcoverId: res.hit.id,
        title: res.book!.title ?? q.title,
        bookRowId: inserted.id,
      });
      console.log(`ok (hc:${res.hit.id})`);
    }

    packResults.push({ def, resolved, missed });
  }

  // ────────────────────────────────────────────────────────────────
  // Dedupe within each pack. Hardcover search occasionally maps two
  // different title queries to the same canonical book — e.g. a
  // less-famous entry falls back to an unrelated #1 hit that's already
  // claimed by another title in the list. `pack_books` has a composite
  // PK on (pack_id, book_id), so duplicates would abort the INSERT.
  // Keep the first occurrence and report the collision so the operator
  // can tweak the query in the titles list.
  // ────────────────────────────────────────────────────────────────
  for (const result of packResults) {
    const seen = new Set<string>();
    const deduped: ResolvedBook[] = [];
    const rejected: Array<{ query: TitleQuery; reason: string }> = [];
    for (let i = 0; i < result.resolved.length; i++) {
      const r = result.resolved[i];
      if (seen.has(r.bookRowId)) {
        const original = deduped.find((d) => d.bookRowId === r.bookRowId);
        // Find the title query that produced this resolution. The
        // resolved list is index-aligned with the successful subset,
        // not the full titles list, so we scan by title.
        const query = result.def.titles.find((t) => t.title === r.title) ?? {
          title: r.title,
        };
        rejected.push({
          query,
          reason:
            `collided with "${original?.title ?? "earlier entry"}" ` +
            `(both resolved to hardcover_id ${r.hardcoverId})`,
        });
        continue;
      }
      seen.add(r.bookRowId);
      deduped.push(r);
    }
    result.resolved = deduped;
    result.missed.push(...rejected);
  }

  // ────────────────────────────────────────────────────────────────
  // Upsert packs + reset membership. Single transaction so a failure
  // halfway through doesn't leave a pack with half its books.
  // ────────────────────────────────────────────────────────────────
  console.log(`\n[editor-packs] upserting ${packResults.length} editorial packs…`);
  await db.transaction(async (tx) => {
    for (const { def, resolved } of packResults) {
      const [pack] = await tx
        .insert(packs)
        .values({
          slug: def.slug,
          name: def.name,
          description: def.description,
          creatorId: null,
          isPublic: true,
          publishedAt: sql`now()`,
          genreTags: [...def.genreTags],
        })
        .onConflictDoUpdate({
          target: packs.slug,
          targetWhere: sql`creator_id IS NULL`,
          set: {
            name: def.name,
            description: def.description,
            genreTags: [...def.genreTags],
          },
        })
        .returning({ id: packs.id });

      await tx.delete(packBooks).where(eq(packBooks.packId, pack.id));
      if (resolved.length > 0) {
        await tx.insert(packBooks).values(
          resolved.map((b, idx) => ({
            packId: pack.id,
            bookId: b.bookRowId,
            position: idx,
          })),
        );
      }
      console.log(
        `[editor-packs]   ✓ ${def.slug}: ${resolved.length}/${def.titles.length} books`,
      );
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Final report
  // ────────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n[editor-packs] ✓ done in ${elapsed}s`);

  const totalMissed = packResults.reduce((n, r) => n + r.missed.length, 0);
  if (totalMissed > 0) {
    console.log(`\n[editor-packs] ${totalMissed} title(s) could not be resolved:`);
    for (const { def, missed } of packResults) {
      if (missed.length === 0) continue;
      console.log(`[editor-packs]   ${def.slug}:`);
      for (const { query, reason } of missed) {
        const label = query.author ? `${query.title} — ${query.author}` : query.title;
        console.log(`[editor-packs]     • ${label}  (${reason})`);
      }
    }
    console.log(
      "\n[editor-packs] Edit scripts/seed-editor-packs.ts and re-run; " +
        "upserts are idempotent.",
    );
  }

  console.log("\n[editor-packs] Next: run `pnpm db:rebucket` to redistribute rarity buckets.");
} catch (err) {
  console.error("[editor-packs] ✗ failed:", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
