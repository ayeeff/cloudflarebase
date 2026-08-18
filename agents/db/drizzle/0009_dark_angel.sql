CREATE TABLE `view_sources` (
	`table` text PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`applied_lsn` integer DEFAULT 0 NOT NULL,
	`pulled_at` integer DEFAULT 0 NOT NULL,
	`config` text
);
--> statement-breakpoint
ALTER TABLE `collections` ADD `members` text;