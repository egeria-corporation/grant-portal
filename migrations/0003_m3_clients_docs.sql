CREATE TABLE `deliverable_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text DEFAULT 'org_default' NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`items_json` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `file_parts` (
	`file_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`etag` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`file_id`, `part_number`),
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `message_reads` (
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`thread_ref` text DEFAULT '' NOT NULL,
	`last_read_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `user_id`, `thread_ref`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `clients` ADD `client_can_edit` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `clients` ADD `last_activity_at` integer;--> statement-breakpoint
ALTER TABLE `deliverables` ADD `description` text;--> statement-breakpoint
ALTER TABLE `deliverables` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `doc_request_items` ADD `hint` text;--> statement-breakpoint
ALTER TABLE `files` ADD `multipart_upload_id` text;--> statement-breakpoint
ALTER TABLE `files` ADD `completed_at` integer;--> statement-breakpoint
ALTER TABLE `files` ADD `deleted_by` text;