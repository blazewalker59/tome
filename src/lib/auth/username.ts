/**
 * Derive a username for a new user on first sign-in.
 *
 * This replaces the SQL `handle_new_user()` trigger we had with Supabase.
 * Runs inside Better Auth's `databaseHooks.user.create.before` — so it has
 * access to the user payload Better Auth built from the Google profile but
 * before any row is written.
 *
 * Rules (same as the old trigger, ported to TypeScript):
 *   1. Prefer an explicit `username` / `preferred_username` from the
 *      provider profile if one was passed through (we don't currently
 *      forward these, but future providers might).
 *   2. Fall back to the email local-part.
 *   3. Last resort: the first 8 chars of the user id.
 *
 * The candidate is normalised to lower-case kebab — stripping anything
 * that isn't `[a-z0-9_-]` — and checked against the `users` table for a
 * collision. If taken, we suffix the first 6 chars of the uuid (with
 * dashes removed) and retry once. If THAT is somehow also taken we fall
 * through to the raw 8-char uuid prefix which is effectively unique.
 */
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";

type DB = NeonHttpDatabase<typeof schema>;

const USERNAME_RE = /[^a-z0-9_-]+/g;

function normalise(raw: string): string {
  const slug = raw.toLowerCase().replace(USERNAME_RE, "-").replace(/^-+|-+$/g, "");
  return slug;
}

function uuidChunk(id: string, len: number): string {
  return id.replace(/-/g, "").slice(0, len);
}

export async function deriveUsername(
  db: DB,
  input: {
    id: string;
    email?: string | null;
    name?: string | null;
    // Arbitrary provider profile fields may be forwarded here via
    // Better Auth's `mapProfileToUser` in the future.
    profile?: Record<string, unknown>;
  },
): Promise<string> {
  const profile = input.profile ?? {};
  const emailLocal = input.email?.split("@")[0] ?? null;

  const raw =
    (typeof profile.username === "string" && profile.username) ||
    (typeof profile.preferred_username === "string" && profile.preferred_username) ||
    emailLocal ||
    uuidChunk(input.id, 8);

  let base = normalise(raw);
  if (!base) base = uuidChunk(input.id, 8);

  // First candidate.
  if (!(await isTaken(db, base))) return base;

  // Second try: append uuid suffix.
  const suffixed = `${base}-${uuidChunk(input.id, 6)}`;
  if (!(await isTaken(db, suffixed))) return suffixed;

  // Pathological case — raw uuid prefix is effectively unique.
  return uuidChunk(input.id, 12);
}

async function isTaken(db: DB, username: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);
  return rows.length > 0;
}
