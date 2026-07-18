CREATE TABLE `boards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`column_axis` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `boards_project_id_unique` ON `boards` (`project_id`);--> statement-breakpoint
-- Backfill: every project created before this migration needs its one board too.
-- column_axis / timestamps fall back to their column defaults (an empty axis).
INSERT INTO `boards` (`project_id`) SELECT `id` FROM `projects`;