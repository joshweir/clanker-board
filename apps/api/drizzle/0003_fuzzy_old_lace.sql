CREATE TABLE `issue_blocked_by` (
	`issue_id` integer NOT NULL,
	`blocker_id` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `blocker_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocker_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `issues` ADD `parent_id` integer REFERENCES issues(id) ON DELETE set null;