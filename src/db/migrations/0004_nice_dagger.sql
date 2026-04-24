ALTER TABLE "books" ADD COLUMN "ingested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "ingested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_ingested_by_user_id_users_id_fk" FOREIGN KEY ("ingested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "books_ingested_by_at_idx" ON "books" USING btree ("ingested_by_user_id","ingested_at");