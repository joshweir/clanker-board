CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`actor_id` integer NOT NULL,
	`type` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_issue_created_idx` ON `events` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `comments_issue_created_idx` ON `comments` (`issue_id`,`created_at`);--> statement-breakpoint

-- Materialize a real `opened` event for every pre-launch issue (#79/#82), AFTER
-- the authorId backfill (0008): the sanctioned truthful synthesis from the
-- issue's own createdAt + its (already-backfilled) authorId, so the timeline
-- has one uniform read path with no derive-on-read special case. Fabricates NO
-- other history (label/blocker/parent/state) - `opened` only.
INSERT INTO `events` (`issue_id`, `actor_id`, `type`, `data`, `created_at`)
SELECT `id`, `author_id`, 'opened', '{}', `created_at` FROM `issues`;