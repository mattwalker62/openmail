CREATE TABLE `campaign_recipients` (
	`campaign_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`email` text NOT NULL,
	`unsubscribe_token` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`claimed_at` integer,
	`claim_batch` text,
	`message_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	PRIMARY KEY(`campaign_id`, `contact_id`),
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `campaign_recipients_status_idx` ON `campaign_recipients` (`campaign_id`,`status`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`draft_version` integer NOT NULL,
	`list_id` text NOT NULL,
	`from_address` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`campaign_type` text,
	`policy_id` text,
	`status` text NOT NULL,
	`pause_reason` text,
	`recipient_count` integer,
	`approved_at` integer,
	`approved_by` text,
	`origin` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `campaigns_tenant_status_idx` ON `campaigns` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `dispatches` (
	`campaign_id` text PRIMARY KEY NOT NULL,
	`cursor` text DEFAULT '' NOT NULL,
	`lease_until` integer,
	`done` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`subject` text NOT NULL,
	`html` text NOT NULL,
	`text` text,
	`version` integer DEFAULT 1 NOT NULL,
	`origin` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`api_key_id` text NOT NULL,
	`campaign_type` text NOT NULL,
	`list_id` text NOT NULL,
	`from_address` text NOT NULL,
	`max_per_day` integer DEFAULT 1 NOT NULL,
	`baseline_campaign_id` text,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `contacts` ADD `address_hash` text;