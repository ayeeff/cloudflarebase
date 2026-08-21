CREATE TABLE `app_secrets` (
	`app_name` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_name`, `name`)
);
--> statement-breakpoint
CREATE TABLE `app_vars` (
	`app_name` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_name`, `name`)
);
--> statement-breakpoint
CREATE TABLE `build_secrets` (
	`app_name` text NOT NULL,
	`name` text NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_name`, `name`)
);
--> statement-breakpoint
CREATE TABLE `build_vars` (
	`app_name` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_name`, `name`)
);
--> statement-breakpoint
ALTER TABLE `apps` ADD `last_deploy_vars` text;