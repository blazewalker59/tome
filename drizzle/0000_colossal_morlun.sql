CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`id_token` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_uq` ON `accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`hardcover_id` integer NOT NULL,
	`title` text NOT NULL,
	`authors` text DEFAULT '[]' NOT NULL,
	`authors_text` text DEFAULT '' NOT NULL,
	`cover_url` text,
	`description` text,
	`page_count` integer,
	`published_year` integer,
	`genre` text NOT NULL,
	`rarity` text NOT NULL,
	`mood_tags` text DEFAULT '[]' NOT NULL,
	`ratings_count` integer DEFAULT 0 NOT NULL,
	`average_rating` text,
	`raw_metadata` text,
	`ingested_by_user_id` text,
	`ingested_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`ingested_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `books_hardcover_id_unique` ON `books` (`hardcover_id`);--> statement-breakpoint
CREATE INDEX `books_rarity_idx` ON `books` (`rarity`);--> statement-breakpoint
CREATE INDEX `books_genre_idx` ON `books` (`genre`);--> statement-breakpoint
CREATE INDEX `books_ingested_by_at_idx` ON `books` (`ingested_by_user_id`,`ingested_at`);--> statement-breakpoint
CREATE INDEX `books_authors_text_idx` ON `books` (`authors_text`);--> statement-breakpoint
CREATE INDEX `books_live_created_idx` ON `books` (`created_at`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `collection_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`first_acquired_from_pack_id` text,
	`first_acquired_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`first_acquired_from_pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_user_book_uq` ON `collection_cards` (`user_id`,`book_id`);--> statement-breakpoint
CREATE TABLE `economy_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `follows` (
	`follower_id` text NOT NULL,
	`followee_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`follower_id`, `followee_id`),
	FOREIGN KEY (`follower_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`followee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pack_books` (
	`pack_id` text NOT NULL,
	`book_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`pack_id`, `book_id`),
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `pack_rips` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`pack_id` text NOT NULL,
	`ripped_at` integer DEFAULT (unixepoch()) NOT NULL,
	`pulled_book_ids` text NOT NULL,
	`duplicates` integer DEFAULT 0 NOT NULL,
	`shards_awarded` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `pack_rips_user_idx` ON `pack_rips` (`user_id`,`ripped_at`);--> statement-breakpoint
CREATE INDEX `pack_rips_pack_idx` ON `pack_rips` (`pack_id`,`ripped_at`);--> statement-breakpoint
CREATE TABLE `packs` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`creator_id` text,
	`is_public` integer DEFAULT false NOT NULL,
	`published_at` integer,
	`genre_tags` text DEFAULT '[]' NOT NULL,
	`rip_count_week` integer DEFAULT 0 NOT NULL,
	`cover_image_url` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `packs_creator_idx` ON `packs` (`creator_id`);--> statement-breakpoint
CREATE INDEX `packs_public_idx` ON `packs` (`is_public`);--> statement-breakpoint
CREATE UNIQUE INDEX `packs_creator_slug_uq` ON `packs` (`creator_id`,`slug`) WHERE creator_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `packs_editorial_slug_uq` ON `packs` (`slug`) WHERE creator_id IS NULL;--> statement-breakpoint
CREATE TABLE `reading_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`status` text DEFAULT 'tbr' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`rating` integer,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `reading_entries_user_status_updated_idx` ON `reading_entries` (`user_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `reading_entries_user_book_uq` ON `reading_entries` (`user_id`,`book_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `shard_balances` (
	`user_id` text PRIMARY KEY NOT NULL,
	`shards` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `shard_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`ref_book_id` text,
	`ref_pack_id` text,
	`ref_rip_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ref_book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ref_pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ref_rip_id`) REFERENCES `pack_rips`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shard_events_user_reason_created_idx` ON `shard_events` (`user_id`,`reason`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `shard_events_once_per_book_uq` ON `shard_events` (`user_id`,`reason`,`ref_book_id`) WHERE reason in ('start_reading', 'finish_reading');--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`username` text NOT NULL,
	`display_name` text,
	`avatar_url` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);