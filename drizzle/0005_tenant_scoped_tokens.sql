DROP INDEX `contacts_unsubscribe_token_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_tenant_unsubscribe_token_idx` ON `contacts` (`tenant_id`,`unsubscribe_token`);--> statement-breakpoint
ALTER TABLE `webhook_quarantine` DROP COLUMN `body`;