CREATE TABLE `templates` (
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`html` text NOT NULL,
	`text` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`tenant_id`, `name`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transactional_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`template` text NOT NULL,
	`address_hash` text NOT NULL,
	`status` text NOT NULL,
	`message_id` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
