CREATE TABLE `restore_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection` text NOT NULL,
	`bookmark` text NOT NULL,
	`reason` text NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `restore_points_collection` ON `restore_points` (`collection`);