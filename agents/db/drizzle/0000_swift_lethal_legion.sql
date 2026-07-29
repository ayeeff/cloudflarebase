CREATE TABLE `collection_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`config` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`name` text PRIMARY KEY NOT NULL,
	`read_access` text DEFAULT 'auth' NOT NULL,
	`write_access` text DEFAULT 'auth' NOT NULL,
	`docs` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`reported_at` integer
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`owner` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `documents_updated_at` ON `documents` (`updated_at`);--> statement-breakpoint
CREATE INDEX `documents_owner` ON `documents` (`owner`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`conn_id` text NOT NULL,
	`sub_id` text NOT NULL,
	`query` text NOT NULL,
	`owner_sub` text,
	`token_exp` integer,
	`last_membership` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`conn_id`, `sub_id`)
);
--> statement-breakpoint
CREATE INDEX `subscriptions_conn` ON `subscriptions` (`conn_id`);