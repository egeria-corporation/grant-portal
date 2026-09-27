CREATE TABLE `alert_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`client_id` text NOT NULL,
	`og_id` text NOT NULL,
	`data_json` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`opportunity_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_matches_client_status_idx` ON `alert_matches` (`client_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `alert_matches_alert_og_uq` ON `alert_matches` (`alert_id`,`og_id`);--> statement-breakpoint
ALTER TABLE `alerts` ADD `name` text;--> statement-breakpoint
ALTER TABLE `alerts` ADD `mode` text DEFAULT 'review' NOT NULL;--> statement-breakpoint
ALTER TABLE `alerts` ADD `last_status` text;--> statement-breakpoint
ALTER TABLE `alerts` ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `alerts` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `kind` text DEFAULT 'grant' NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `stage_changed_at` integer;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `refreshed_at` integer;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `reports` ADD `pending_review` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `sent_by` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `updated_at` integer;