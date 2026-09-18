CREATE TABLE `t_event_usage` (
	`f_event_id` text PRIMARY KEY NOT NULL,
	`f_created_at` integer NOT NULL,
	`f_provider` text,
	`f_model` text,
	`f_input_tokens` integer DEFAULT 0 NOT NULL,
	`f_output_tokens` integer DEFAULT 0 NOT NULL,
	`f_cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`f_reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`f_total_tokens` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_t_event_usage_f_event_id_t_events_f_event_id_fk` FOREIGN KEY (`f_event_id`) REFERENCES `t_events`(`f_event_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_event_usage_created_at` ON `t_event_usage` (`f_created_at`);
