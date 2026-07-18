-- Unified full-text search index (#39). ONE standalone FTS5 virtual table holds a
-- row per searchable text source: each issue (title + body) and each comment (body
-- only), every row keyed back to its parent issue via issue_id. Filter fields
-- (type/state/label) are deliberately NOT denormalized in here - the search query
-- joins hits back to the base tables - so this index churns only when title/body or
-- a comment's text changes. Tokenizer is porter stemming over unicode61 with
-- diacritic folding, so "running" matches "run" and "café" matches "cafe".
CREATE VIRTUAL TABLE `issues_fts` USING fts5(
	title,
	body,
	issue_id UNINDEXED,
	source_kind UNINDEXED,
	source_id UNINDEXED,
	tokenize = 'porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
-- Backfill every existing issue and comment so search works over pre-migration data.
INSERT INTO `issues_fts` (title, body, issue_id, source_kind, source_id)
SELECT title, body, id, 'issue', id FROM `issues`;
--> statement-breakpoint
INSERT INTO `issues_fts` (title, body, issue_id, source_kind, source_id)
SELECT '', body, issue_id, 'comment', id FROM `comments`;
--> statement-breakpoint
-- Keep the index live via triggers. Issues: index a row on insert, re-index only
-- when title/body actually change (AFTER UPDATE OF), and drop ALL rows for the issue
-- on delete - that clears its comment rows too, since FK cascade deletes do not fire
-- the comment triggers (recursive_triggers is off).
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
-- Comments: index a row on insert, re-index only on body change, drop it on delete.
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
