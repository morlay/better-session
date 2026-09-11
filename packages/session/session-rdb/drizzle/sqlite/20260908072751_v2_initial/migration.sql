CREATE TABLE `t_events` (
	`f_id` integer PRIMARY KEY AUTOINCREMENT,
	`f_event_id` text NOT NULL UNIQUE,
	`f_parent_id` text DEFAULT '' NOT NULL,
	`f_type` text DEFAULT '' NOT NULL,
	`f_kind` text DEFAULT '' NOT NULL,
	`f_role` text DEFAULT '' NOT NULL,
	`f_name` text DEFAULT '' NOT NULL,
	`f_action_id` text DEFAULT '' NOT NULL,
	`f_encoding` text DEFAULT '' NOT NULL,
	`f_data` text NOT NULL,
	`f_created_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `t_persistence_state` (
	`f_singleton` integer PRIMARY KEY,
	`f_store_id` text NOT NULL,
	CONSTRAINT "ck_persistence_state_singleton" CHECK(f_singleton = 1)
);
--> statement-breakpoint
CREATE TABLE `t_session_events` (
	`f_id` integer PRIMARY KEY AUTOINCREMENT,
	`f_session_id` text NOT NULL,
	`f_event_id` text NOT NULL,
	`f_sequence` integer NOT NULL,
	`f_surface_op` text,
	`f_original_seq` integer NOT NULL,
	CONSTRAINT `fk_t_session_events_f_session_id_t_sessions_f_session_id_fk` FOREIGN KEY (`f_session_id`) REFERENCES `t_sessions`(`f_session_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_t_session_events_f_event_id_t_events_f_event_id_fk` FOREIGN KEY (`f_event_id`) REFERENCES `t_events`(`f_event_id`) ON DELETE CASCADE,
	CONSTRAINT `uq_session_events_session_sequence` UNIQUE(`f_session_id`,`f_sequence`)
);
--> statement-breakpoint
CREATE TABLE `t_sessions` (
	`f_id` integer PRIMARY KEY AUTOINCREMENT,
	`f_session_id` text NOT NULL UNIQUE,
	`f_head_event_id` text DEFAULT '' NOT NULL,
	`f_head_sequence` integer DEFAULT -1 NOT NULL,
	`f_version` integer NOT NULL,
	`f_created_at` integer NOT NULL,
	`f_cwd` text,
	`f_parent_session` text,
	`f_seed_length` integer,
	`f_origin` text,
	`f_delegation_depth` integer,
	`f_incarnation` text NOT NULL,
	`f_revision` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_kind` ON `t_events` (`f_kind`);--> statement-breakpoint
CREATE INDEX `idx_events_role` ON `t_events` (`f_role`);--> statement-breakpoint
CREATE INDEX `idx_events_name` ON `t_events` (`f_name`);--> statement-breakpoint
CREATE INDEX `idx_events_action_id` ON `t_events` (`f_action_id`);--> statement-breakpoint
CREATE INDEX `idx_session_events_event_id` ON `t_session_events` (`f_event_id`);