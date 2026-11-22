CREATE TABLE `webhook_quarantine` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`reason` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tenants` ADD `sns_topic_arns` text DEFAULT '[]' NOT NULL;