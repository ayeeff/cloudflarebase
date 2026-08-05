CREATE TABLE `gateway_subs` (
	`conn_id` text NOT NULL,
	`sub_id` text NOT NULL,
	`shard_kind` text NOT NULL,
	`shard_name` text NOT NULL,
	`instance` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`conn_id`, `sub_id`)
);
--> statement-breakpoint
CREATE INDEX `gateway_subs_conn` ON `gateway_subs` (`conn_id`);--> statement-breakpoint
CREATE TABLE `gateways` (
	`id` text PRIMARY KEY NOT NULL,
	`region` text NOT NULL,
	`sockets` integer DEFAULT 0 NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `via` text;