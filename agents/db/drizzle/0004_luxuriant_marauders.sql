CREATE TABLE `changelog` (
	`lsn` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`op` text NOT NULL,
	`id` text NOT NULL,
	`image` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `replica_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`applied_lsn` integer DEFAULT 0 NOT NULL,
	`pulled_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `replicas` (
	`id` text PRIMARY KEY NOT NULL,
	`region` text NOT NULL,
	`applied_lsn` integer DEFAULT 0 NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `collections` ADD `replication` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `collections` ADD `rep_epoch` integer DEFAULT 0 NOT NULL;