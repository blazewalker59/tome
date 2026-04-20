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

export const deckVisibility = pgEnum("deck_visibility", ["public", "unlisted", "private"]);

export const packKind = pgEnum("pack_kind", ["editorial", "deck"]);

// ──────────────────────────────────────────────────────────────────────────────
// Users
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors `auth.users` from Supabase. Populated via trigger or sync on signup.
 * We keep our own row so we can FK against it without crossing schemas.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(), // matches auth.users.id
  username: text("username").notNull().unique(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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

    rawMetadata: jsonb("raw_metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("books_rarity_idx").on(t.rarity), index("books_genre_idx").on(t.genre)],
);

// ──────────────────────────────────────────────────────────────────────────────
// Packs
// ──────────────────────────────────────────────────────────────────────────────

export const packs = pgTable(
  "packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    kind: packKind("kind").notNull(),
    /** Set when kind = 'deck'. */
    sourceDeckId: uuid("source_deck_id"),
    coverImageUrl: text("cover_image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("packs_kind_idx").on(t.kind)],
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
// Decks
// ──────────────────────────────────────────────────────────────────────────────

export const decks = pgTable(
  "decks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    coverBookId: uuid("cover_book_id").references(() => books.id, {
      onDelete: "set null",
    }),
    visibility: deckVisibility("visibility").notNull().default("private"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("decks_user_idx").on(t.userId)],
);

export const deckBooks = pgTable(
  "deck_books",
  {
    deckId: uuid("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.deckId, t.bookId] })],
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

/**
 * Running balance per user. We could derive this from `pack_rips` but a
 * cached counter is cheaper at read time and fine for a single-shard MVP.
 */
export const shardBalances = pgTable("shard_balances", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  shards: integer("shards").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ──────────────────────────────────────────────────────────────────────────────
// Pack credits (daily + earned bonuses)
// ──────────────────────────────────────────────────────────────────────────────

export const packCredits = pgTable("pack_credits", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Free packs available right now (capped in app layer, e.g. max 5). */
  available: integer("available").notNull().default(0),
  /** Used to enforce daily-pack timer. */
  lastDailyGrantedAt: timestamp("last_daily_granted_at", {
    withTimezone: true,
  }),
  /** Idempotency for read-bonus grants. */
  bonusesGrantedToday: integer("bonuses_granted_today").notNull().default(0),
  bonusesDay: text("bonuses_day"), // ISO date "YYYY-MM-DD" in user TZ
  hasOnboarded: boolean("has_onboarded").notNull().default(false),
});

// ──────────────────────────────────────────────────────────────────────────────
// Relations
// ──────────────────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many, one }) => ({
  collection: many(collectionCards),
  decks: many(decks),
  rips: many(packRips),
  shardBalance: one(shardBalances, {
    fields: [users.id],
    references: [shardBalances.userId],
  }),
  packCredit: one(packCredits, {
    fields: [users.id],
    references: [packCredits.userId],
  }),
}));

export const booksRelations = relations(books, ({ many }) => ({
  inPacks: many(packBooks),
  inDecks: many(deckBooks),
  collectionRows: many(collectionCards),
}));

export const packsRelations = relations(packs, ({ many, one }) => ({
  books: many(packBooks),
  rips: many(packRips),
  sourceDeck: one(decks, {
    fields: [packs.sourceDeckId],
    references: [decks.id],
  }),
}));

export const decksRelations = relations(decks, ({ many, one }) => ({
  owner: one(users, { fields: [decks.userId], references: [users.id] }),
  books: many(deckBooks),
  coverBook: one(books, {
    fields: [decks.coverBookId],
    references: [books.id],
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

export const deckBooksRelations = relations(deckBooks, ({ one }) => ({
  deck: one(decks, {
    fields: [deckBooks.deckId],
    references: [decks.id],
  }),
  book: one(books, {
    fields: [deckBooks.bookId],
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
