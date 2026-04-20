CREATE TYPE "public"."card_rarity" AS ENUM('common', 'uncommon', 'rare', 'foil', 'legendary');--> statement-breakpoint
CREATE TYPE "public"."deck_visibility" AS ENUM('public', 'unlisted', 'private');--> statement-breakpoint
CREATE TYPE "public"."pack_kind" AS ENUM('editorial', 'deck');--> statement-breakpoint
CREATE TYPE "public"."read_status" AS ENUM('unread', 'reading', 'read');--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hardcover_id" bigint NOT NULL,
	"title" text NOT NULL,
	"authors" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"cover_url" text,
	"description" text,
	"page_count" integer,
	"published_year" smallint,
	"genre" text NOT NULL,
	"rarity" "card_rarity" NOT NULL,
	"mood_tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"ratings_count" integer DEFAULT 0 NOT NULL,
	"raw_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_hardcover_id_unique" UNIQUE("hardcover_id")
);
--> statement-breakpoint
CREATE TABLE "collection_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" "read_status" DEFAULT 'unread' NOT NULL,
	"rating" smallint,
	"note" text,
	"first_acquired_from_pack_id" uuid,
	"first_acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_user_book_uq" UNIQUE("user_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "deck_books" (
	"deck_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "deck_books_deck_id_book_id_pk" PRIMARY KEY("deck_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "decks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cover_book_id" uuid,
	"visibility" "deck_visibility" DEFAULT 'private' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decks_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" uuid NOT NULL,
	"followee_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_id_followee_id_pk" PRIMARY KEY("follower_id","followee_id")
);
--> statement-breakpoint
CREATE TABLE "pack_books" (
	"pack_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	CONSTRAINT "pack_books_pack_id_book_id_pk" PRIMARY KEY("pack_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "pack_credits" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"available" integer DEFAULT 0 NOT NULL,
	"last_daily_granted_at" timestamp with time zone,
	"bonuses_granted_today" integer DEFAULT 0 NOT NULL,
	"bonuses_day" text,
	"has_onboarded" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_rips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"ripped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pulled_book_ids" uuid[] NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"shards_awarded" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "pack_kind" NOT NULL,
	"source_deck_id" uuid,
	"cover_image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "shard_balances" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"shards" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "collection_cards" ADD CONSTRAINT "collection_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_cards" ADD CONSTRAINT "collection_cards_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_cards" ADD CONSTRAINT "collection_cards_first_acquired_from_pack_id_packs_id_fk" FOREIGN KEY ("first_acquired_from_pack_id") REFERENCES "public"."packs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deck_books" ADD CONSTRAINT "deck_books_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deck_books" ADD CONSTRAINT "deck_books_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_cover_book_id_books_id_fk" FOREIGN KEY ("cover_book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_id_users_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_books" ADD CONSTRAINT "pack_books_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_books" ADD CONSTRAINT "pack_books_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_credits" ADD CONSTRAINT "pack_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_rips" ADD CONSTRAINT "pack_rips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_rips" ADD CONSTRAINT "pack_rips_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shard_balances" ADD CONSTRAINT "shard_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "books_rarity_idx" ON "books" USING btree ("rarity");--> statement-breakpoint
CREATE INDEX "books_genre_idx" ON "books" USING btree ("genre");--> statement-breakpoint
CREATE INDEX "decks_user_idx" ON "decks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pack_rips_user_idx" ON "pack_rips" USING btree ("user_id","ripped_at");--> statement-breakpoint
CREATE INDEX "packs_kind_idx" ON "packs" USING btree ("kind");