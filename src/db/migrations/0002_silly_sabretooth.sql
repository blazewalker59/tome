CREATE TABLE "economy_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shard_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"ref_book_id" uuid,
	"ref_pack_id" uuid,
	"ref_rip_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "pack_credits" CASCADE;--> statement-breakpoint
ALTER TABLE "shard_events" ADD CONSTRAINT "shard_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shard_events" ADD CONSTRAINT "shard_events_ref_book_id_books_id_fk" FOREIGN KEY ("ref_book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shard_events" ADD CONSTRAINT "shard_events_ref_pack_id_packs_id_fk" FOREIGN KEY ("ref_pack_id") REFERENCES "public"."packs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shard_events" ADD CONSTRAINT "shard_events_ref_rip_id_pack_rips_id_fk" FOREIGN KEY ("ref_rip_id") REFERENCES "public"."pack_rips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shard_events_user_reason_created_idx" ON "shard_events" USING btree ("user_id","reason","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shard_events_once_per_book_uq" ON "shard_events" USING btree ("user_id","reason","ref_book_id") WHERE reason in ('start_reading', 'finish_reading');--> statement-breakpoint

-- Seed the default economy config so getEconomy() never has to cold-fall
-- back to hard-coded TS defaults in production. Values mirror the
-- defaults in src/lib/economy/config.ts; keep them in sync when tuning.
INSERT INTO "economy_config" ("key", "value") VALUES (
  'current',
  '{
    "welcomeGrant": 200,
    "packCost": 50,
    "dupeRefund": { "shardsPerDupe": 5 },
    "transitions": {
      "startReading":  { "shards": 5,   "dailyCap": 5 },
      "finishReading": { "shards": 100, "weeklyCap": 3 }
    }
  }'::jsonb
);