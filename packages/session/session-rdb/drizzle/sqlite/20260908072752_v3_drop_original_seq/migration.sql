CREATE TABLE `t_schema_meta` (
	`f_key` text PRIMARY KEY,
	`f_value` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `t_session_events` DROP COLUMN `f_original_seq`;