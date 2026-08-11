import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────────────────────────────────────
// Postgres → SQLite (Cloudflare D1) type mapping
//
// This schema was migrated off Neon Postgres. The substitutions, once, so the
// rest of the file reads without commentary:
//
//   uuid().defaultRandom()  → text().$defaultFn(crypto.randomUUID)
//   timestamp(withTimezone) → integer({ mode: "timestamp" })  [epoch SECONDS]
//   boolean()               → integer({ mode: "boolean" })    [0/1]
//   jsonb()                 → text({ mode: "json" })
//   pgEnum()                → text({ enum: [...] })
//   bigint() / smallint()   → integer()
//   text().array()          → text({ mode: "json" }).$type<Array<string>>()
//
// UUID primary keys are kept (as text) rather than switching to autoincrement
// integers: the migrated rows carry their original ids, every FK already
// points at them, and Better Auth is configured to mint `crypto.randomUUID()`
// so newly-created rows match the existing shape.
//
// Timestamps are epoch SECONDS, not milliseconds — `mode: "timestamp"` is
// seconds and `mode: "timestamp_ms"` is milliseconds. Everything here uses
// seconds, and the `unixepoch()` SQL default agrees. Mixing the two silently
// produces dates in 1970 or the year 56000, so do not change one without the
// other.
//
// SQLite requires expression defaults to be parenthesised, hence
// `sql`(unixepoch())`` rather than `sql`unixepoch()``.
// ──────────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// Enums
//
// SQLite has no enum type. Drizzle's `{ enum: [...] }` is a TypeScript-level
// constraint only — it narrows the column's type but emits no CHECK. That is
// the same practical guarantee the app had before (values were always written
// through typed helpers), minus database-level rejection of a bad literal.
// ──────────────────────────────────────────────────────────────────────────────

export const CARD_RARITIES = [
  "common",
  "uncommon",
  "rare",
  "foil",
  "legendary",
] as const;

export const READ_STATUSES = ["unread", "reading", "read"] as const;

/**
 * Independent reading-log state. Distinct from `collection_cards` (which
 * tracks cards the user owns, acquired via pack rips). A user can mark
 * any book in the catalog as TBR / currently reading / finished without
 * owning the card, and owning a card doesn't automatically add it to
 * their reading list. The two domains overlap but are not the same.
 *
 * TBR is the user's to-read queue; `reading` is in-progress; `finished`
 * is completed. DNF / abandoned is intentionally omitted in v1.
 */
export const READING_STATUSES = ["tbr", "reading", "finished"] as const;

export type CardRarity = (typeof CARD_RARITIES)[number];
export type ReadStatusValue = (typeof READ_STATUSES)[number];
export type ReadingStatusValue = (typeof READING_STATUSES)[number];

// ──────────────────────────────────────────────────────────────────────────────
// Auth tables (Better Auth core schema)
//
// Better Auth canonical table names are singular (user, session, account,
// verification). We keep our existing plural `users` because every FK in the
// schema already says `user_id` → `users.id`. The mapping is done at the
// adapter layer in `src/lib/auth/server.ts` via `usePlural: true`.
//
// Our application-specific user fields (`username`, `display_name`,
// `avatar_url`) live on this table as Better Auth `additionalFields`. The
// username is derived in a `databaseHooks.user.create.before` hook on first
// sign-in.
// ──────────────────────────────────────────────────────────────────────────────

export const users = sqliteTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // Better Auth core fields.
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  // Our app fields.
  username: text("username").notNull().unique(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Better Auth `session` table. One row per live session cookie.
 * Sessions cascade-delete with the user. Expired rows are swept by
 * Better Auth itself on each `getSession()` call.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Better Auth `account` table. One row per (user, oauth-provider) link
 * — e.g. a Google account connected to a Tome user. For email/password
 * auth this is where the password hash would live; we don't use that.
 */
export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp",
    }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("accounts_user_idx").on(t.userId),
    unique("accounts_provider_uq").on(t.providerId, t.accountId),
  ],
);

/**
 * Better Auth `verification` table. Short-lived rows used for email
 * verification, password reset, and OAuth state. Not user-cascaded — rows
 * are transient and Better Auth cleans them up by `expiresAt`.
 */
export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

// ──────────────────────────────────────────────────────────────────────────────
// Social graph
// ──────────────────────────────────────────────────────────────────────────────

export const follows = sqliteTable(
  "follows",
  {
    followerId: text("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followeeId: text("followee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [primaryKey({ columns: [t.followerId, t.followeeId] })],
);

// ──────────────────────────────────────────────────────────────────────────────
// Books / Cards (shared, global)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * One row per book. The "card" identity is the book itself — every user sees
 * the same suit/rarity/mood for a given book. Personal data lives on
 * `collection_cards`.
 */
export const books = sqliteTable(
  "books",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hardcoverId: integer("hardcover_id").notNull().unique(),
    title: text("title").notNull(),
    /**
     * Was `text[]` on Postgres. SQLite has no array type, so this is a JSON
     * array. Reads deserialize transparently through Drizzle; what it costs
     * us is the ability to search inside it from SQL — Postgres could do
     * `EXISTS (SELECT 1 FROM unnest(authors) a WHERE a ILIKE $1)`, and SQLite
     * cannot without json_each gymnastics that no index can serve.
     *
     * `authorsText` below is the answer to that. Keep them in lockstep: every
     * write to `authors` must write `authorsText` too. `setAuthors()` in
     * src/db/authors.ts is the single helper that does this — use it rather
     * than assigning either column directly.
     */
    authors: text("authors", { mode: "json" })
      .$type<Array<string>>()
      .notNull()
      .default(sql`'[]'`),
    /**
     * Denormalized, space-joined, lowercased copy of `authors`, maintained
     * solely so author search is a plain indexable `LIKE`. Never read this
     * for display — it is a search key, not data.
     */
    authorsText: text("authors_text").notNull().default(""),
    coverUrl: text("cover_url"),
    description: text("description"),
    pageCount: integer("page_count"),
    publishedYear: integer("published_year"),

    genre: text("genre").notNull(),
    rarity: text("rarity", { enum: CARD_RARITIES }).notNull(),
    /** Curated controlled vocabulary (max 3 enforced in app layer). */
    moodTags: text("mood_tags", { mode: "json" })
      .$type<Array<string>>()
      .notNull()
      .default(sql`'[]'`),

    /** Hardcover ratings count — input to rarity bucket. */
    ratingsCount: integer("ratings_count").notNull().default(0),
    /**
     * Hardcover average rating (0–5), stored as text to preserve precision
     * without pulling in a numeric/decimal helper. Nullable: brand-new books
     * can have no ratings yet. Input to the rarity hybrid score alongside
     * `ratingsCount`; books below the min-ratings floor (see
     * `src/lib/cards/rarity.ts`) are capped at `rare` regardless of average.
     */
    averageRating: text("average_rating"),

    rawMetadata: text("raw_metadata", { mode: "json" }),
    /**
     * Who ingested this book and when. Null for admin-ingested rows
     * (the original editorial catalog) and for rows created before this
     * column existed. Populated when a signed-in user ingests a book
     * on-demand from the pack builder so we can rate-limit and, later,
     * flag user-ingested rows for admin review.
     */
    ingestedByUserId: text("ingested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ingestedAt: integer("ingested_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    /**
     * Soft-delete tombstone. Null = live; non-null = removed from
     * curation surfaces (admin search defaults, builder local search,
     * new-pack-membership writes) while preserving every existing
     * reference (`pack_books`, `collections`, `reading_log`,
     * `shard_events`). Existing user state therefore keeps rendering
     * — a deleted catalog row doesn't ghost a pull or a TBR — but
     * the book can no longer be picked into anything new. Restoring
     * is a single UPDATE setting this back to NULL.
     *
     * Hardcover ingest dedup intentionally does NOT filter on this:
     * re-ingesting a soft-deleted hardcover_id revives the row in
     * place rather than colliding on the unique constraint.
     */
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
  },
  (t) => [
    index("books_rarity_idx").on(t.rarity),
    index("books_genre_idx").on(t.genre),
    // Covers the per-user throttle query: "how many books has this user
    // ingested in the last hour?" → scans by (ingested_by, ingested_at).
    index("books_ingested_by_at_idx").on(t.ingestedByUserId, t.ingestedAt),
    // Serves the author search (`authors_text LIKE '%needle%'`). A trailing
    // wildcard cannot use this index, but it keeps the scan to one narrow
    // column instead of the whole row.
    index("books_authors_text_idx").on(t.authorsText),
    // Partial index over live rows. Every catalog-facing query filters on
    // `deleted_at IS NULL`; making that the index predicate keeps the index
    // small and lets the planner skip the tombstone scan. SQLite supports
    // partial indexes, so this survives the migration unchanged.
    index("books_live_created_idx")
      .on(t.createdAt)
      .where(sql`deleted_at IS NULL`),
  ],
);

// ──────────────────────────────────────────────────────────────────────────────
// Packs
//
// A pack is either editorial (Tome-authored, `creator_id` NULL) or
// user-built (`creator_id` set). Drafts live in this same table with
// `is_public = false`; publishing flips the flag, stamps `published_at`,
// and freezes membership — creators can still edit name/description, but
// `pack_books` rows are immutable post-publish (enforced in server fns,
// not the DB, so we can still run data migrations).
//
// Slugs are scoped per-creator: each user has their own namespace, plus
// the editorial namespace (creator_id IS NULL) is its own. Like Postgres,
// SQLite treats NULLs as distinct in ordinary unique constraints, so we
// keep the two partial unique indexes rather than one composite unique.
// ──────────────────────────────────────────────────────────────────────────────

export const packs = sqliteTable(
  "packs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * NULL = editorial (Tome-authored); otherwise the user who built the
     * pack. Deleting the creator nulls this out so their published packs
     * remain accessible as orphaned editorial rather than vanishing.
     */
    creatorId: text("creator_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * Drafts are private to the creator. Flipping to true requires passing
     * the composition validator; un-publishing flips it back (and allows
     * edits again). Editorial packs are always public.
     */
    isPublic: integer("is_public", { mode: "boolean" })
      .notNull()
      .default(false),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    /**
     * Creator-curated genre tags (1–3) shown on the public pack page and
     * used for discovery. Distinct from per-book `books.genre` — a pack's
     * tags describe the curated collection, not any single book in it.
     */
    genreTags: text("genre_tags", { mode: "json" })
      .$type<Array<string>>()
      .notNull()
      .default(sql`'[]'`),
    /**
     * Denormalized trending signal: rip count over the last 7 days.
     * Bumped by `recordRipFn`; the reset mechanism (scheduled job) is
     * TODO — for now this grows unbounded and sort-by-trending is
     * effectively sort-by-all-time. Accepted so the schema is stable for
     * when the job lands.
     */
    ripCountWeek: integer("rip_count_week").notNull().default(0),
    coverImageUrl: text("cover_image_url"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("packs_creator_idx").on(t.creatorId),
    index("packs_public_idx").on(t.isPublic),
    // Per-creator slug uniqueness (user namespace).
    uniqueIndex("packs_creator_slug_uq")
      .on(t.creatorId, t.slug)
      .where(sql`creator_id IS NOT NULL`),
    // Editorial slug uniqueness (shared Tome namespace).
    uniqueIndex("packs_editorial_slug_uq")
      .on(t.slug)
      .where(sql`creator_id IS NULL`),
  ],
);

export const packBooks = sqliteTable(
  "pack_books",
  {
    packId: text("pack_id")
      .notNull()
      .references(() => packs.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "restrict" }),
    /**
     * Creator-chosen ordering inside the pack. Not exposed in the rip
     * animation (which shuffles), but shown in the pack detail view and
     * the builder's drag-to-reorder list.
     */
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.packId, t.bookId] })],
);

// ──────────────────────────────────────────────────────────────────────────────
// Collections (a user's owned cards)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Personal layer: one row per (user, book) the user owns as a card.
 * Counts duplicates so the rip animation can show "you already own
 * this — converted to shards".
 *
 * Note: reading-state (have-read, currently-reading, TBR) does NOT live
 * here. It lives on `reading_entries`, which is independent of card
 * ownership — a user can log a book they've never ripped. Acquiring a
 * card does not implicitly add it to the reading list, and vice versa.
 */
export const collectionCards = sqliteTable(
  "collection_cards",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull().default(1),
    firstAcquiredFromPackId: text("first_acquired_from_pack_id").references(
      () => packs.id,
      { onDelete: "set null" },
    ),
    firstAcquiredAt: integer("first_acquired_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [unique("collection_user_book_uq").on(t.userId, t.bookId)],
);

// ──────────────────────────────────────────────────────────────────────────────
// Reading log (a user's TBR / reading / finished list)
//
// Independent from `collection_cards`. A user can log any book in the
// catalog here — owned or not — to earn start/finish shard grants, track
// their queue, and rate/note books. `started_at` / `finished_at` are
// stamped on transitions for UI display; the shard ledger
// (`shard_events.created_at`) is still the canonical timestamp for grant
// windows. Partial unique index on `shard_events` enforces that each
// book earns each transition at most once ever — removing and re-adding
// a row here does not re-grant shards.
// ──────────────────────────────────────────────────────────────────────────────

export const readingEntries = sqliteTable(
  "reading_entries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "restrict" }),
    status: text("status", { enum: READING_STATUSES }).notNull().default("tbr"),
    /** Stamped when status first transitions into `reading`. Null until then. */
    startedAt: integer("started_at", { mode: "timestamp" }),
    /** Stamped when status first transitions into `finished`. Null until then. */
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    rating: integer("rating"), // 1..5, validated in app
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    unique("reading_entries_user_book_uq").on(t.userId, t.bookId),
    // Common query: "show my reading list filtered by status, ordered
    // by when I last touched it." Covers the /reading list views.
    index("reading_entries_user_status_updated_idx").on(
      t.userId,
      t.status,
      t.updatedAt,
    ),
  ],
);

// ──────────────────────────────────────────────────────────────────────────────
// Pack rips (audit log + bonus tracking)
// ──────────────────────────────────────────────────────────────────────────────

export const packRips = sqliteTable(
  "pack_rips",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    packId: text("pack_id")
      .notNull()
      .references(() => packs.id, { onDelete: "restrict" }),
    rippedAt: integer("ripped_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    /**
     * Snapshot of the rip result so animations can replay & we can audit.
     * Was `uuid[]`; now a JSON array of id strings.
     */
    pulledBookIds: text("pulled_book_ids", { mode: "json" })
      .$type<Array<string>>()
      .notNull(),
    duplicates: integer("duplicates").notNull().default(0),
    shardsAwarded: integer("shards_awarded").notNull().default(0),
  },
  (t) => [
    index("pack_rips_user_idx").on(t.userId, t.rippedAt),
    // Supports the trending sort on Discover: "public packs ordered by
    // rip count over the last 7 days." The query filters on
    // `pack_id IN (...) AND ripped_at > <cutoff>`, which is a textbook
    // (pack_id, ripped_at) lookup.
    index("pack_rips_pack_idx").on(t.packId, t.rippedAt),
  ],
);

// ──────────────────────────────────────────────────────────────────────────────
// Shard ledger + economy config
//
// Every shard change — welcome grants, reading-transition rewards, pack
// purchases, dupe refunds — is a row in `shard_events`. Balance and cap
// windows are derived from the ledger:
//
//   balance   = SUM(delta) WHERE user_id = ?
//   daily cap = COUNT(*)  WHERE user_id = ? AND reason = ?
//                                AND created_at > unixepoch('now', '-1 day')
//
// `shard_balances` survives as a write-through cache so the Header can
// read balance in one indexed row without a reduction. The cache is
// always reconstructible from the ledger if it drifts.
//
// The partial unique index on (user_id, reason, ref_book_id) enforces
// "each book earns each transition at most once, ever" at the database
// level. Un-reading and re-starting the same book cannot double-grant
// because the insert will conflict. Dupe refunds and rip debits share
// the table but skip this constraint (different reasons).
// ──────────────────────────────────────────────────────────────────────────────

export const shardEvents = sqliteTable(
  "shard_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Signed integer. Positive for grants, negative for pack purchases.
     * Summed across a user to derive balance.
     */
    delta: integer("delta").notNull(),
    /**
     * String enum kept as free `text` so new reasons don't require a
     * migration. App-layer validation keeps this tight. Current reasons:
     * welcome_grant, start_reading, finish_reading, dupe_refund, rip.
     */
    reason: text("reason").notNull(),
    /**
     * Optional references to what triggered the event. start/finish grants
     * point at a book; rip debits + dupe refunds point at a pack and/or a
     * specific rip row. Nullable because not every reason ties back to a
     * specific row (welcome_grant, future manual adjustments).
     */
    refBookId: text("ref_book_id").references(() => books.id, {
      onDelete: "set null",
    }),
    refPackId: text("ref_pack_id").references(() => packs.id, {
      onDelete: "set null",
    }),
    refRipId: text("ref_rip_id").references(() => packRips.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    // Cap-window queries scan by (user, reason, time). This covers
    // them and the balance sum (which needs only `user_id`).
    index("shard_events_user_reason_created_idx").on(
      t.userId,
      t.reason,
      t.createdAt,
    ),
    // Enforces once-ever-per-book for the two reasons that need it.
    // Partial index so rip debits / dupe refunds (same book, many times)
    // don't conflict.
    //
    // SQLite matches an upsert's conflict target against a partial index by
    // the target columns plus the WHERE predicate, exactly as Postgres did,
    // so `onConflictDoNothing` in src/lib/economy/ledger.ts must keep
    // repeating this predicate verbatim. Keep the two in sync.
    uniqueIndex("shard_events_once_per_book_uq")
      .on(t.userId, t.reason, t.refBookId)
      .where(sql`reason in ('start_reading', 'finish_reading')`),
  ],
);

/**
 * Running balance cache — one row per user. Derived state, updated on every
 * ledger insert. If this ever drifts from the ledger, the ledger wins and the
 * cache can be rebuilt via
 * `SELECT user_id, SUM(delta) FROM shard_events GROUP BY user_id`.
 */
export const shardBalances = sqliteTable("shard_balances", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  shards: integer("shards").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Key/value singleton for tunable economy numbers — shard yields, caps,
 * pack cost, welcome grant, etc. One row per logical config bundle
 * (currently only `'current'`). Value is a JSON blob shaped by
 * `EconomyConfig` in `src/lib/economy/config.ts`.
 *
 * We read through a per-isolate cache rather than hitting this table
 * on every server-fn call — config is read hundreds of times more
 * often than it's written.
 */
export const economyConfig = sqliteTable("economy_config", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ──────────────────────────────────────────────────────────────────────────────
// Relations
// ──────────────────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  collection: many(collectionCards),
  readingEntries: many(readingEntries),
  authoredPacks: many(packs),
  rips: many(packRips),
  shardBalance: one(shardBalances, {
    fields: [users.id],
    references: [shardBalances.userId],
  }),
  shardEvents: many(shardEvents),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const booksRelations = relations(books, ({ many }) => ({
  inPacks: many(packBooks),
  collectionRows: many(collectionCards),
  readingEntries: many(readingEntries),
}));

export const packsRelations = relations(packs, ({ many, one }) => ({
  books: many(packBooks),
  rips: many(packRips),
  creator: one(users, {
    fields: [packs.creatorId],
    references: [users.id],
  }),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Junction-table relations
//
// Drizzle requires both sides of a many-to-many to be declared so studio /
// relational queries can resolve them. Each junction row is a `one(...)`
// toward each end.
// ──────────────────────────────────────────────────────────────────────────────

export const packBooksRelations = relations(packBooks, ({ one }) => ({
  pack: one(packs, {
    fields: [packBooks.packId],
    references: [packs.id],
  }),
  book: one(books, {
    fields: [packBooks.bookId],
    references: [books.id],
  }),
}));

export const collectionCardsRelations = relations(
  collectionCards,
  ({ one }) => ({
    user: one(users, {
      fields: [collectionCards.userId],
      references: [users.id],
    }),
    book: one(books, {
      fields: [collectionCards.bookId],
      references: [books.id],
    }),
    firstAcquiredFromPack: one(packs, {
      fields: [collectionCards.firstAcquiredFromPackId],
      references: [packs.id],
    }),
  }),
);

export const readingEntriesRelations = relations(readingEntries, ({ one }) => ({
  user: one(users, {
    fields: [readingEntries.userId],
    references: [users.id],
  }),
  book: one(books, {
    fields: [readingEntries.bookId],
    references: [books.id],
  }),
}));

export const packRipsRelations = relations(packRips, ({ one }) => ({
  user: one(users, { fields: [packRips.userId], references: [users.id] }),
  pack: one(packs, { fields: [packRips.packId], references: [packs.id] }),
}));

export const followsRelations = relations(follows, ({ one }) => ({
  follower: one(users, {
    fields: [follows.followerId],
    references: [users.id],
    relationName: "follower",
  }),
  followee: one(users, {
    fields: [follows.followeeId],
    references: [users.id],
    relationName: "followee",
  }),
}));

export const shardEventsRelations = relations(shardEvents, ({ one }) => ({
  user: one(users, { fields: [shardEvents.userId], references: [users.id] }),
  book: one(books, { fields: [shardEvents.refBookId], references: [books.id] }),
  pack: one(packs, { fields: [shardEvents.refPackId], references: [packs.id] }),
  rip: one(packRips, {
    fields: [shardEvents.refRipId],
    references: [packRips.id],
  }),
}));
