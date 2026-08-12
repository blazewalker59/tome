import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./_helpers";
import { dbFromD1 } from "@/db/client";
import { users } from "@/db/schema";

beforeEach(async () => {
  await resetDb();
});

describe("D1 test harness", () => {
  it("applies the real drizzle migrations", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all<{ name: string }>();
    const names = tables.results.map((r) => r.name);
    // Every table the app depends on, from the same SQL wrangler applies.
    for (const t of [
      "users",
      "books",
      "packs",
      "pack_books",
      "pack_rips",
      "collection_cards",
      "reading_entries",
      "shard_events",
      "shard_balances",
    ]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  it("round-trips through the app's own Drizzle client", async () => {
    const db = dbFromD1(env.DB);
    await db.insert(users).values({
      id: "u1",
      name: "Test",
      email: "t@example.test",
      username: "test",
    });
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    // Proves the schema's type modes survive a real round trip: booleans come
    // back as booleans (integer 0/1 columns) and timestamps as Dates (epoch
    // seconds), not as the raw integers SQLite stores.
    expect(rows[0].emailVerified).toBe(false);
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });
});
