CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_idx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`external_id` text,
	`unsubscribe_token` text NOT NULL,
	`unsubscribed_at` integer,
	`source` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_tenant_email_idx` ON `contacts` (`tenant_id`,`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_unsubscribe_token_idx` ON `contacts` (`unsubscribe_token`);--> statement-breakpoint
CREATE INDEX `contacts_tenant_external_idx` ON `contacts` (`tenant_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `list_members` (
	`list_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`list_id`, `contact_id`),
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lists_tenant_name_idx` ON `lists` (`tenant_id`,`name`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`tenant_id` text NOT NULL,
	`address_hash` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`tenant_id`, `address_hash`, `kind`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`from_address` text NOT NULL,
	`secret_prefix` text NOT NULL,
	`tx_region` text NOT NULL,
	`tx_configuration_set` text NOT NULL,
	`bulk_region` text NOT NULL,
	`bulk_configuration_set` text NOT NULL,
	`bulk_per_second` integer DEFAULT 14 NOT NULL,
	`context` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_unique` ON `tenants` (`slug`);