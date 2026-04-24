import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ──────────────────────────────────────────────────────────────────────────────
// Enums
// ──────────────────────────────────────────────────────────────────────────────

// Genres are open-ended kebab-case strings (e.g. `science-fiction`,
// `historical-fiction`, `biography`) so editorial curators can add new
// genres without a schema change. Stored as plain `text` on `books`.

export const cardRarity = pgEnum("card_rarity", [
  "common",
  "uncommon",
  "rare",
  "foil",
  "legendary",
]);

export const readStatus = pgEnum("read_status", ["unread", "reading", "read"]);

// ──────────────────────────────────────────────────────────────────────────────
// Auth tables (Better Auth core schema)
//
// Better Auth canonical table names are singular (user, session, account,
// verification). We keep our existing plural `users` because every FK in the
// schema already says `user_id` → `users.id`. The mapping `user → users` is
// done at the adapter layer in `src/lib/auth/server.ts` via
// `user: { modelName: 'users' }`.
//
// We configure Better Auth to generate UUIDs (advanced.database.generateId
// = "uuid") so all `id` columns stay `uuid` and every existing FK continues
// to typecheck. That's a big simplification vs flipping everything to text.
//
// Our application-specific user fields (`username`, `display_name`,
// `avatar_url`) live on this table as Better Auth `additionalFields`. The
// username is derived in a `databaseHooks.user.create.before` hook on first
// sign-in, replacing the old `handle_new_user()` SQL trigger.
// ──────────────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  // Better Auth writes this; we declare it NOT NULL + PK.
  id: uuid("id").primaryKey().defaultRandom(),
  // Better Auth core fields.
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Our app fields.
  username: text("username").notNull().unique(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Better Auth `session` table. One row per live session cookie.
 * Sessions cascade-delete with the user. Expired rows are swept by
 * Better Auth itself on each `getSession()` call.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Better Auth `account` table. One row per (user, oauth-provider) link
 * — e.g. a Google account connected to a Tome user. For email/password
 * auth this is where the password hash would live; we don't use that.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

// ──────────────────────────────────────────────────────────────────────────────
// Social graph
// ──────────────────────────────────────────────────────────────────────────────

export const follows = pgTable(
  "follows",
  {
    followerId: uuid("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followeeId: uuid("followee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
export const books = pgTable(
  "books",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hardcoverId: bigint("hardcover_id", { mode: "number" }).notNull().unique(),
    title: text("title").notNull(),
    authors: text("authors")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    coverUrl: text("cover_url"),
    description: text("description"),
    pageCount: integer("page_count"),
    publishedYear: smallint("published_year"),

    genre: text("genre").notNull(),
    rarity: cardRarity("rarity").notNull(),
    /** Curated controlled vocabulary (max 3 enforced in app layer). */
    moodTags: text("mood_tags")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),

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

    rawMetadata: jsonb("raw_metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("books_rarity_idx").on(t.rarity), index("books_genre_idx").on(t.genre)],
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
// the editorial namespace (creator_id IS NULL) is its own. Postgres
// treats NULLs as distinct in ordinary unique constraints, so we use two
// partial unique indexes instead of a single composite unique.
// ──────────────────────────────────────────────────────────────────────────────

export const packs = pgTable(
  "packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * NULL = editorial (Tome-authored); otherwise the user who built the
     * pack. Deleting the creator nulls this out so their published packs
     * remain accessible as orphaned editorial rather than vanishing.
     */
    creatorId: uuid("creator_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * Drafts are private to the creator. Flipping to true requires passing
     * the composition validator; un-publishing flips it back (and allows
     * edits again). Editorial packs are always public.
     */
    isPublic: boolean("is_public").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /**
     * Creator-curated genre tags (1–3) shown on the public pack page and
     * used for discovery. Distinct from per-book `books.genre` — a pack's
     * tags describe the curated collection, not any single book in it.
     */
    genreTags: text("genre_tags")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /**
     * Denormalized trending signal: rip count over the last 7 days.
     * Bumped by `recordRipFn`; the reset mechanism (scheduled job) is
     * TODO — for now this grows unbounded and sort-by-trending is
     * effectively sort-by-all-time. Accepted so the schema is stable for
     * when the job lands.
     */
    ripCountWeek: integer("rip_count_week").notNull().default(0),
    coverImageUrl: text("cover_image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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

export const packBooks = pgTable(
  "pack_books",
  {
    packId: uuid("pack_id")
      .notNull()
      .references(() => packs.id, { onDelete: "cascade" }),
    bookId: uuid("book_id")
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
 * Personal layer: one row per (user, book). Counts duplicates so the rip
 * animation can show "you already own this — converted to shards".
 */
export const collectionCards = pgTable(
  "collection_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull().default(1),
    status: readStatus("status").notNull().default("unread"),
    rating: smallint("rating"), // 1..5, validated in app
    note: text("note"),
    firstAcquiredFromPackId: uuid("first_acquired_from_pack_id").references(() => packs.id, {
      onDelete: "set null",
    }),
    firstAcquiredAt: timestamp("first_acquired_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("collection_user_book_uq").on(t.userId, t.bookId)],
);

// ──────────────────────────────────────────────────────────────────────────────
// Pack rips (audit log + bonus tracking)
// ──────────────────────────────────────────────────────────────────────────────

export const packRips = pgTable(
  "pack_rips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    packId: uuid("pack_id")
      .notNull()
      .references(() => packs.id, { onDelete: "restrict" }),
    rippedAt: timestamp("ripped_at", { withTimezone: true }).notNull().defaultNow(),
    /** Snapshot of the rip result so animations can replay & we can audit. */
    pulledBookIds: uuid("pulled_book_ids").array().notNull(),
    duplicates: integer("duplicates").notNull().default(0),
    shardsAwarded: integer("shards_awarded").notNull().default(0),
  },
  (t) => [index("pack_rips_user_idx").on(t.userId, t.rippedAt)],
);

// ──────────────────────────────────────────────────────────────────────────────
// Shard ledger + economy config
//
// Every shard change — welcome grants, reading-transition rewards, pack
// purchases, dupe refunds — is a row in `shard_events`. Balance and cap
// windows are derived from the ledger:
//
//   balance   = SUM(delta) WHERE user_id = $1
//   daily cap = COUNT(*)  WHERE user_id = $1 AND reason = $2
//                                AND created_at > now() - interval '1 day'
//
// `shard_balances` survives as a write-through cache so the Header can
// read balance in one indexed row without a reduction. Every write to
// the ledger bumps the cache inside the same transaction; the cache
// is always reconstructible from the ledger if it drifts.
//
// The partial unique index on (user_id, reason, ref_book_id) enforces
// "each book earns each transition at most once, ever" at the database
// level. Un-reading and re-starting the same book cannot double-grant
// because the insert will conflict. Dupe refunds and rip debits share
// the table but skip this constraint (different reasons).
// ──────────────────────────────────────────────────────────────────────────────

export const shardEvents = pgTable(
  "shard_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Signed integer. Positive for grants, negative for pack purchases.
     * Summed across a user to derive balance.
     */
    delta: integer("delta").notNull(),
    /**
     * String enum (kept as `text` rather than a pgEnum so we can add new
     * reasons without a migration). App-layer validation keeps this tight.
     * Current reasons: welcome_grant, start_reading, finish_reading,
     * dupe_refund, rip.
     */
    reason: text("reason").notNull(),
    /**
     * Optional references to what triggered the event. start/finish grants
     * point at a book; rip debits + dupe refunds point at a pack and/or a
     * specific rip row. Nullable because not every reason ties back to a
     * specific row (welcome_grant, future manual adjustments).
     */
    refBookId: uuid("ref_book_id").references(() => books.id, {
      onDelete: "set null",
    }),
    refPackId: uuid("ref_pack_id").references(() => packs.id, {
      onDelete: "set null",
    }),
    refRipId: uuid("ref_rip_id").references(() => packRips.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Cap-window queries scan by (user, reason, time). This covers
    // them and the balance sum (which needs only `user_id`).
    index("shard_events_user_reason_created_idx").on(t.userId, t.reason, t.createdAt),
    // Enforces once-ever-per-book for the two reasons that need it.
    // Partial index so rip debits / dupe refunds (same book, many times)
    // don't conflict.
    uniqueIndex("shard_events_once_per_book_uq")
      .on(t.userId, t.reason, t.refBookId)
      .where(sql`reason in ('start_reading', 'finish_reading')`),
  ],
);

/**
 * Running balance cache — one row per user. Derived state: updated
 * inside the same transaction as every ledger insert. If this ever
 * drifts from the ledger, the ledger wins and the cache can be rebuilt
 * via `SELECT user_id, SUM(delta) FROM shard_events GROUP BY user_id`.
 */
export const shardBalances = pgTable("shard_balances", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  shards: integer("shards").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Key/value singleton for tunable economy numbers — shard yields, caps,
 * pack cost, welcome grant, etc. One row per logical config bundle
 * (currently only `'current'`). Value is a JSON blob shaped by
 * `EconomyConfig` in `src/lib/economy/config.ts`.
 *
 * We read through a per-isolate cache rather than hitting this table
 * on every server-fn call — config is read hundreds of times more
 * often than it's written. When we add an admin UI for editing it,
 * the cache is invalidated by bumping `updatedAt`.
 */
export const economyConfig = pgTable("economy_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ──────────────────────────────────────────────────────────────────────────────
// Relations
// ──────────────────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  collection: many(collectionCards),
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

export const collectionCardsRelations = relations(collectionCards, ({ one }) => ({
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
  rip: one(packRips, { fields: [shardEvents.refRipId], references: [packRips.id] }),
}));
