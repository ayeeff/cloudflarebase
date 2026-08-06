PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_collections` (
	`name` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'collection' NOT NULL,
	`read_access` text DEFAULT 'auth' NOT NULL,
	`write_access` text DEFAULT 'auth' NOT NULL,
	`read_permission` text,
	`write_permission` text,
	`validator` text,
	`columns` text,
	`replication` text DEFAULT 'auto' NOT NULL,
	`rep_epoch` integer DEFAULT 0 NOT NULL,
	`docs` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`reported_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_collections`("name", "kind", "read_access", "write_access", "read_permission", "write_permission", "validator", "columns", "replication", "rep_epoch", "docs", "created_at", "reported_at") SELECT "name", "kind", "read_access", "write_access", "read_permission", "write_permission", "validator", "columns", "replication", "rep_epoch", "docs", "created_at", "reported_at" FROM `collections`;--> statement-breakpoint
DROP TABLE `collections`;--> statement-breakpoint
ALTER TABLE `__new_collections` RENAME TO `collections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;