CREATE TABLE `apps` (
	`name` text PRIMARY KEY NOT NULL,
	`subdomain` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_deploy_at` integer,
	`deploy_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deploys` (
	`id` text PRIMARY KEY NOT NULL,
	`app_name` text NOT NULL,
	`subdomain` text NOT NULL,
	`status` text NOT NULL,
	`has_worker` integer NOT NULL,
	`asset_count` integer NOT NULL,
	`asset_bytes` integer NOT NULL,
	`module_bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
