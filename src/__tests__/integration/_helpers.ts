import { env } from "cloudflare:test";
import type { Database } from "@/db/client";
import type { CardRarity } from "@/db/schema";
import { dbFromD1, setWorkerEnv } from "@/db/client";
import { books, packs, shardBalances, users } from "@/db/schema";
import { setAuthors } from "@/db/authors";

/**
 * Shared fixtures for the D1 integration tests.
 *
 * `setWorkerEnv` is what lets app code that calls `getDb()` internally — the
 * economy config loader, for instance — work here without threading a handle
 * through. It is the same escape hatch `src/server.ts` uses for contexts
 * outside the per-request AsyncLocalStorage scope.
 */
export function testDb(): Database {
  setWorkerEnv({ DB: env.DB });
  return dbFromD1(env.DB);
}

/**
 * Child-before-parent so foreign keys resolve. `d1_migrations` is deliberately
 * excluded — wiping it would make the setup file re-apply the schema.
 */
const TABLES_CHILD_FIRST = [
  "shard_events",
  "shard_balances",
  "collection_cards",
  "reading_entries",
  "pack_rips",
  "pack_books",
  "follows",
  "sessions",
  "accounts",
  "verifications",
  "packs",
  "books",
  "users",
  "economy_config",
] as const;

/**
 * Empty every table between tests.
 *
 * @cloudflare/vitest-pool-workers 0.21 isolates storage per test FILE, not per
 * test, so without this the second test to seed the same user id trips the
 * unique constraint on `users.username`. Truncating explicitly also makes each
 * test's starting state visible in the test itself rather than implied by the
 * pool's behaviour.
 */
export async function resetDb(): Promise<void> {
  await env.DB.batch(
    TABLES_CHILD_FIRST.map((t) => env.DB.prepare(`DELETE FROM "${t}"`)),
  );
}

export const USER_ID = "user-under-test";

/** Insert a user, optionally with a starting balance. */
export async function seedUser(
  db: Database,
  opts: { id?: string; shards?: number } = {},
): Promise<string> {
  const id = opts.id ?? USER_ID;
  await db.insert(users).values({
    id,
    name: "Test Reader",
    email: `${id}@example.test`,
    username: id,
  });
  if (opts.shards !== undefined) {
    await db.insert(shardBalances).values({ userId: id, shards: opts.shards });
  }
  return id;
}

let hardcoverSeq = 1000;

/**
 * Insert a book. Authors go through `setAuthors` so `authors` and
 * `authors_text` stay in lockstep exactly as production writes them.
 */
export async function seedBook(
  db: Database,
  opts: {
    id: string;
    title: string;
    authors?: Array<string>;
    rarity?: CardRarity;
    genre?: string;
  },
): Promise<string> {
  await db.insert(books).values({
    id: opts.id,
    hardcoverId: hardcoverSeq++,
    title: opts.title,
    ...setAuthors(opts.authors ?? ["Anon Author"]),
    genre: opts.genre ?? "fantasy",
    rarity: opts.rarity ?? "common",
  });
  return opts.id;
}

export async function seedPack(
  db: Database,
  opts: { id: string; slug: string; creatorId?: string | null },
): Promise<string> {
  await db.insert(packs).values({
    id: opts.id,
    slug: opts.slug,
    name: opts.slug,
    creatorId: opts.creatorId ?? null,
    isPublic: true,
  });
  return opts.id;
}
