CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`query_json` text NOT NULL,
	`schedule_id` text,
	`last_run_at` integer,
	`last_result_ids_json` text,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `alerts_client_idx` ON `alerts` (`client_id`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`deliverable_version_id` text NOT NULL,
	`user_id` text NOT NULL,
	`decision` text NOT NULL,
	`comment` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`deliverable_version_id`) REFERENCES `deliverable_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approvals_version_idx` ON `approvals` (`deliverable_version_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text DEFAULT 'org_default' NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target` text,
	`ip_hash` text,
	`meta_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_user_id`);--> statement-breakpoint
CREATE TABLE `client_members` (
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `user_id`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `client_members_user_idx` ON `client_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text DEFAULT 'org_default' NOT NULL,
	`name` text NOT NULL,
	`legal_name` text,
	`status` text DEFAULT 'onboarding' NOT NULL,
	`ein_enc` text,
	`ein_last4` text,
	`entity_type` text,
	`is_501c3` integer,
	`ntee` text,
	`geography_json` text,
	`budget_band` text,
	`fye_month` integer,
	`uei_sam_status` text,
	`mission` text,
	`programs_json` text,
	`populations_json` text,
	`focus_tags_json` text,
	`funding_goals_json` text,
	`owner_user_id` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `clients_org_status_idx` ON `clients` (`org_id`,`status`);--> statement-breakpoint
CREATE TABLE `deliverable_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`deliverable_id` text NOT NULL,
	`file_id` text,
	`url` text,
	`version` integer NOT NULL,
	`note_md` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`deliverable_id`) REFERENCES `deliverables`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deliverable_versions_uq` ON `deliverable_versions` (`deliverable_id`,`version`);--> statement-breakpoint
CREATE TABLE `deliverables` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`opportunity_id` text,
	`title` text NOT NULL,
	`side` text NOT NULL,
	`assignee_user_id` text,
	`due_at` integer,
	`status` text DEFAULT 'not_started' NOT NULL,
	`template_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deliverables_client_due_idx` ON `deliverables` (`client_id`,`due_at`);--> statement-breakpoint
CREATE TABLE `doc_request_items` (
	`id` text PRIMARY KEY NOT NULL,
	`doc_request_id` text NOT NULL,
	`label` text NOT NULL,
	`required` integer DEFAULT true NOT NULL,
	`file_id` text,
	`fulfilled_at` integer,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`doc_request_id`) REFERENCES `doc_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `doc_request_items_request_idx` ON `doc_request_items` (`doc_request_id`);--> statement-breakpoint
CREATE TABLE `doc_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`title` text NOT NULL,
	`message` text,
	`due_at` integer,
	`reminder_policy_json` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `doc_requests_client_due_idx` ON `doc_requests` (`client_id`,`due_at`);--> statement-breakpoint
CREATE TABLE `emails` (
	`id` text PRIMARY KEY NOT NULL,
	`to_user_id` text,
	`to_email` text NOT NULL,
	`client_id` text,
	`template` text NOT NULL,
	`subject` text NOT NULL,
	`resend_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `emails_resend_idx` ON `emails` (`resend_id`);--> statement-breakpoint
CREATE INDEX `emails_client_created_idx` ON `emails` (`client_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text,
	`actor_user_id` text,
	`type` text NOT NULL,
	`payload_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_client_created_idx` ON `events` (`client_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text,
	`folder` text,
	`tags_json` text,
	`expires_at` integer,
	`scan_status` text DEFAULT 'none' NOT NULL,
	`upload_status` text DEFAULT 'pending' NOT NULL,
	`shared_with_client` integer DEFAULT true NOT NULL,
	`uploaded_by` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_r2_key_uq` ON `files` (`r2_key`);--> statement-breakpoint
CREATE INDEX `files_client_created_idx` ON `files` (`client_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `files_expires_idx` ON `files` (`expires_at`);--> statement-breakpoint
CREATE TABLE `form_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`client_id` text NOT NULL,
	`answers_json` text,
	`submitted_at` integer,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `form_responses_client_idx` ON `form_responses` (`client_id`);--> statement-breakpoint
CREATE TABLE `forms` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`schema_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`payload_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_runs_status_idx` ON `job_runs` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `magic_links` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`code_hash` text,
	`code_salt` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`ip_hash` text,
	`ua_hash` text,
	`purpose` text NOT NULL,
	`client_id` text,
	`invite_role` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `magic_links_token_hash_uq` ON `magic_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `magic_links_email_idx` ON `magic_links` (`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `magic_links_expires_idx` ON `magic_links` (`expires_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`thread_ref` text,
	`author_user_id` text,
	`body_md` text NOT NULL,
	`attachments_json` text,
	`created_at` integer NOT NULL,
	`read_by_json` text,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_client_created_idx` ON `messages` (`client_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`source` text NOT NULL,
	`og_id` text,
	`title` text NOT NULL,
	`funder_name` text,
	`url` text,
	`amount_min` integer,
	`amount_max` integer,
	`deadline_at` integer,
	`eligibility_notes` text,
	`data_json` text,
	`stage` text DEFAULT 'none' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `opportunities_client_deadline_idx` ON `opportunities` (`client_id`,`deadline_at`);--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`sign_count` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`label` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_uq` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `report_items` (
	`report_id` text NOT NULL,
	`opportunity_id` text NOT NULL,
	`position` integer NOT NULL,
	`note_md` text,
	`tag` text,
	`client_response` text,
	`client_comment` text,
	`responded_at` integer,
	PRIMARY KEY(`report_id`, `opportunity_id`),
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`title` text NOT NULL,
	`intro_md` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`sent_at` integer,
	`schedule_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `reports_client_created_idx` ON `reports` (`client_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text DEFAULT 'org_default' NOT NULL,
	`client_id` text,
	`kind` text NOT NULL,
	`rrule` text NOT NULL,
	`timezone` text,
	`next_run_at` integer,
	`config_json` text,
	`requires_review` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedules_next_run_idx` ON `schedules` (`next_run_at`,`enabled`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`idle_expires_at` integer NOT NULL,
	`abs_expires_at` integer NOT NULL,
	`step_up_at` integer,
	`ip_hash` text,
	`ua_label` text,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`org_id` text DEFAULT 'org_default' NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `staff_assignments` (
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `user_id`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `staff_assignments_user_idx` ON `staff_assignments` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text DEFAULT 'org_default' NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`kind` text NOT NULL,
	`role` text NOT NULL,
	`timezone` text,
	`notif_prefs_json` text,
	`passkey_required` integer DEFAULT false NOT NULL,
	`all_clients` integer DEFAULT false NOT NULL,
	`email_suppressed_at` integer,
	`created_at` integer NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);