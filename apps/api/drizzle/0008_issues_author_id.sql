-- Every issue gets a truthful author (#73/#81). SQLite cannot ADD a NOT NULL
-- REFERENCES column to a populated table (rejects "NOT NULL... default value
-- NULL", and rejects "REFERENCES... non-NULL default" too), and drizzle's
-- migrator wraps this whole file in one transaction (PRAGMA foreign_keys is a
-- no-op there), so a plain DROP of `issues` while `comments`/`issue_labels`/
-- `issue_blocked_by` still cascade-reference it would wipe them via the
-- implicit pre-drop delete. So every direct cascade-child of `issues` is
-- rebuilt alongside it, id-for-id, and only dropped once nothing references it.

-- 1. H = lowest-id kind=human actor; insert one named "Human" if none exists.
INSERT INTO `actors` (`name`, `kind`)
SELECT 'Human', 'human'
WHERE NOT EXISTS (SELECT 1 FROM `actors` WHERE `kind` = 'human');
--> statement-breakpoint

-- 2. Collapse the lazy "Web" browser identity into H, if one exists and
--    differs from H: reassign its comments + assignments, then delete it.
UPDATE `comments`
SET `actor_id` = (SELECT MIN(`id`) FROM `actors` WHERE `kind` = 'human')
WHERE `actor_id` IN (
	SELECT `id` FROM `actors`
	WHERE `name` = 'Web' AND `kind` = 'human'
		AND `id` != (SELECT MIN(`id`) FROM `actors` WHERE `kind` = 'human')
);
--> statement-breakpoint

UPDATE `issues`
SET `assignee_id` = (SELECT MIN(`id`) FROM `actors` WHERE `kind` = 'human')
WHERE `assignee_id` IN (
	SELECT `id` FROM `actors`
	WHERE `name` = 'Web' AND `kind` = 'human'
		AND `id` != (SELECT MIN(`id`) FROM `actors` WHERE `kind` = 'human')
);
--> statement-breakpoint

DELETE FROM `actors`
WHERE `name` = 'Web' AND `kind` = 'human'
	AND `id` != (SELECT MIN(`id`) FROM `actors` WHERE `kind` = 'human');
--> statement-breakpoint

-- 3. Rebuild `issues` with `author_id` (backfilled to H for every pre-existing
--    row), and its direct cascade-children `comments`, `issue_labels`,
--    `issue_blocked_by`, all pointed at the new table from the start.
CREATE TABLE `issues_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`rank` text NOT NULL,
	`assignee_id` integer,
	`claimed_at` text,
	`parent_id` integer,
	`author_id` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `issues_new`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

INSERT INTO `issues_new` (`id`, `project_id`, `number`, `title`, `type`, `body`, `state`, `rank`, `assignee_id`, `claimed_at`, `parent_id`, `author_id`, `created_at`, `updated_at`)
SELECT `id`, `project_id`, `number`, `title`, `type`, `body`, `state`, `rank`, `assignee_id`, `claimed_at`, `parent_id`,
	(SELECT MIN(`id`) FROM `actors` WHERE `kind` = 'human'),
	`created_at`, `updated_at`
FROM `issues`;
--> statement-breakpoint

CREATE TABLE `comments_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`actor_id` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues_new`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

INSERT INTO `comments_new` (`id`, `issue_id`, `actor_id`, `body`, `created_at`)
SELECT `id`, `issue_id`, `actor_id`, `body`, `created_at` FROM `comments`;
--> statement-breakpoint

CREATE TABLE `issue_labels_new` (
	`issue_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `label_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues_new`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

INSERT INTO `issue_labels_new` (`issue_id`, `label_id`)
SELECT `issue_id`, `label_id` FROM `issue_labels`;
--> statement-breakpoint

CREATE TABLE `issue_blocked_by_new` (
	`issue_id` integer NOT NULL,
	`blocker_id` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `blocker_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues_new`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocker_id`) REFERENCES `issues_new`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

INSERT INTO `issue_blocked_by_new` (`issue_id`, `blocker_id`)
SELECT `issue_id`, `blocker_id` FROM `issue_blocked_by`;
--> statement-breakpoint

-- 4. Drop the old tables (safe: nothing references them anymore) and rename
--    the rebuilt ones into place. Renaming `issues_new` first repoints the
--    other three tables' FK clauses from `issues_new` to `issues` for free.
DROP TABLE `comments`;
--> statement-breakpoint
DROP TABLE `issue_labels`;
--> statement-breakpoint
DROP TABLE `issue_blocked_by`;
--> statement-breakpoint
DROP TABLE `issues`;
--> statement-breakpoint

ALTER TABLE `issues_new` RENAME TO `issues`;
--> statement-breakpoint
ALTER TABLE `comments_new` RENAME TO `comments`;
--> statement-breakpoint
ALTER TABLE `issue_labels_new` RENAME TO `issue_labels`;
--> statement-breakpoint
ALTER TABLE `issue_blocked_by_new` RENAME TO `issue_blocked_by`;
--> statement-breakpoint

-- 5. Recreate the index and FTS5 triggers the drops took with them, verbatim.
CREATE UNIQUE INDEX `issues_project_number_unique` ON `issues` (`project_id`,`number`);
--> statement-breakpoint

CREATE TRIGGER `issues_fts_ai` AFTER INSERT ON `issues` BEGIN
	INSERT INTO `issues_fts` (title, body, issue_id, source_kind, source_id)
	VALUES (new.title, new.body, new.id, 'issue', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER `issues_fts_au` AFTER UPDATE OF title, body ON `issues` BEGIN
	DELETE FROM `issues_fts` WHERE source_kind = 'issue' AND source_id = old.id;
	INSERT INTO `issues_fts` (title, body, issue_id, source_kind, source_id)
	VALUES (new.title, new.body, new.id, 'issue', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER `issues_fts_ad` AFTER DELETE ON `issues` BEGIN
	DELETE FROM `issues_fts` WHERE issue_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `comments_fts_ai` AFTER INSERT ON `comments` BEGIN
	INSERT INTO `issues_fts` (title, body, issue_id, source_kind, source_id)
	VALUES ('', new.body, new.issue_id, 'comment', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER `comments_fts_au` AFTER UPDATE OF body ON `comments` BEGIN
	DELETE FROM `issues_fts` WHERE source_kind = 'comment' AND source_id = old.id;
	INSERT INTO `issues_fts` (title, body, issue_id, source_kind, source_id)
	VALUES ('', new.body, new.issue_id, 'comment', new.id);
END;
--> statement-breakpoint
CREATE TRIGGER `comments_fts_ad` AFTER DELETE ON `comments` BEGIN
	DELETE FROM `issues_fts` WHERE source_kind = 'comment' AND source_id = old.id;
END;