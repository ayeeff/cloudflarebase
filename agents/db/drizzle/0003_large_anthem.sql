ALTER TABLE `collections` ADD `kind` text DEFAULT 'collection' NOT NULL;--> statement-breakpoint
ALTER TABLE `collections` ADD `columns` text;