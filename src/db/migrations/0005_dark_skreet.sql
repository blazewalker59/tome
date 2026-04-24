CREATE TYPE "public"."reading_status" AS ENUM('tbr', 'reading', 'finished');--> statement-breakpoint
CREATE TABLE "reading_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"status" "reading_status" DEFAULT 'tbr' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"rating" smallint,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_entries_user_book_uq" UNIQUE("user_id","book_id")
);
--> statement-breakpoint
ALTER TABLE "reading_entries" ADD CONSTRAINT "reading_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_entries" ADD CONSTRAINT "reading_entries_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reading_entries_user_status_updated_idx" ON "reading_entries" USING btree ("user_id","status","updated_at");--> statement-breakpoint
-- Backfill: migrate reading state from collection_cards into the new
-- reading_entries table before dropping the columns. The old
-- `read_status` enum used 'unread'/'reading'/'read'; the new
-- `reading_status` enum uses 'tbr'/'reading'/'finished'. We map:
--   reading → reading, read → finished. 'unread' rows are skipped —
-- the new model treats "on your list" as opt-in, so historical
-- unread rows (which were just the default for ownership) should not
-- silently become TBR entries. Users with a rating or note on an
-- unread row keep the row only if the rating/note is meaningful.
INSERT INTO "reading_entries" ("user_id", "book_id", "status", "rating", "note", "started_at", "finished_at", "created_at", "updated_at")
SELECT
  cc."user_id",
  cc."book_id",
  (CASE cc."status" WHEN 'reading' THEN 'reading' WHEN 'read' THEN 'finished' ELSE 'tbr' END)::reading_status,
  cc."rating",
  cc."note",
  -- Best-effort timestamps: we don't have historical transition
  -- times, so we stamp updated_at as a proxy. New entries created
  -- through the normal flow will stamp these precisely.
  (CASE WHEN cc."status" IN ('reading', 'read') THEN cc."updated_at" ELSE NULL END),
  (CASE WHEN cc."status" = 'read' THEN cc."updated_at" ELSE NULL END),
  cc."updated_at",
  cc."updated_at"
FROM "collection_cards" cc
WHERE cc."status" IN ('reading', 'read')
   OR cc."rating" IS NOT NULL
   OR cc."note" IS NOT NULL
ON CONFLICT ("user_id", "book_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "collection_cards" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "collection_cards" DROP COLUMN "rating";--> statement-breakpoint
ALTER TABLE "collection_cards" DROP COLUMN "note";