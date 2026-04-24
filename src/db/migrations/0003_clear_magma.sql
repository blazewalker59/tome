ALTER TABLE "deck_books" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "deck_books" CASCADE;--> statement-breakpoint
DROP TABLE "decks" CASCADE;--> statement-breakpoint
ALTER TABLE "packs" DROP CONSTRAINT "packs_slug_unique";--> statement-breakpoint
DROP INDEX "packs_kind_idx";--> statement-breakpoint
ALTER TABLE "pack_books" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "creator_id" uuid;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "genre_tags" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "rip_count_week" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill: every pack that existed before this migration is editorial
-- (creator_id stays NULL) and should be treated as published. Without this
-- the seeded `starter-shelf` pack would vanish from the rip page.
UPDATE "packs" SET "is_public" = true, "published_at" = "created_at" WHERE "creator_id" IS NULL;--> statement-breakpoint
ALTER TABLE "packs" ADD CONSTRAINT "packs_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "packs_creator_idx" ON "packs" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "packs_public_idx" ON "packs" USING btree ("is_public");--> statement-breakpoint
CREATE UNIQUE INDEX "packs_creator_slug_uq" ON "packs" USING btree ("creator_id","slug") WHERE creator_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "packs_editorial_slug_uq" ON "packs" USING btree ("slug") WHERE creator_id IS NULL;--> statement-breakpoint
ALTER TABLE "packs" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "packs" DROP COLUMN "source_deck_id";--> statement-breakpoint
DROP TYPE "public"."deck_visibility";--> statement-breakpoint
DROP TYPE "public"."pack_kind";