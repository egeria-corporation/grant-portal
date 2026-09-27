CREATE TABLE `calendar_feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text,
	`label` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_feeds_token_uq` ON `calendar_feeds` (`token_hash`);--> statement-breakpoint
CREATE INDEX `calendar_feeds_user_idx` ON `calendar_feeds` (`user_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text,
	`kind` text NOT NULL,
	`payload_json` text,
	`delivery` text NOT NULL,
	`email_id` text,
	`created_at` integer NOT NULL,
	`emailed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_user_pending_idx` ON `notifications` (`user_id`,`emailed_at`);--> statement-breakpoint
CREATE TABLE `updates` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`schedule_id` text,
	`subject` text NOT NULL,
	`intro` text,
	`blocks_json` text NOT NULL,
	`content_json` text,
	`status` text NOT NULL,
	`send_at` integer,
	`sent_at` integer,
	`reviewed_by` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `updates_client_created_idx` ON `updates` (`client_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `clients` ADD `reminders_json` text;--> statement-breakpoint
ALTER TABLE `emails` ADD `category` text;