CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket` text NOT NULL,
	`key` text NOT NULL,
	`r2_upload_id` text NOT NULL,
	`part_size` integer NOT NULL,
	`reserved_bytes` integer NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `uploads_created_idx` ON `uploads` (`created_at`);--> statement-breakpoint
CREATE INDEX `uploads_bucket_idx` ON `uploads` (`bucket`);