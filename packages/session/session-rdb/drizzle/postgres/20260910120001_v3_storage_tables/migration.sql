ALTER TABLE "t_sessions" ADD COLUMN "f_archived_at" bigint;
--> statement-breakpoint
ALTER TABLE "t_sessions" ADD COLUMN "f_title" text;
--> statement-breakpoint
ALTER TABLE "t_sessions" ADD COLUMN "f_title_seq" integer;
--> statement-breakpoint
UPDATE "t_sessions" s SET "f_title" = sub.title, "f_title_seq" = sub.seq
FROM (
  SELECT DISTINCT ON (b.f_session_id) b.f_session_id,
         COALESCE(e.f_data::jsonb -> 'data' ->> 'title', e.f_data::jsonb ->> 'title') AS title,
         b.f_sequence AS seq
  FROM t_session_events b JOIN t_events e ON e.f_event_id = b.f_event_id
  WHERE e.f_type = 'session/title'
  ORDER BY b.f_session_id, b.f_sequence DESC
) sub
WHERE s.f_session_id = sub.f_session_id;
--> statement-breakpoint
CREATE TABLE "t_session_projcache_row" (
	"f_id" serial PRIMARY KEY,
	"f_session_id" text NOT NULL,
	"f_key" text NOT NULL,
	"f_ver" integer NOT NULL,
	"f_seq" integer NOT NULL,
	"f_val" text NOT NULL,
	CONSTRAINT "uq_session_projcache_row_session_key" UNIQUE("f_session_id", "f_key")
);
--> statement-breakpoint
CREATE TABLE "t_storage_units" (
	"f_name" text PRIMARY KEY,
	"f_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "t_workspace_state" (
	"f_singleton" integer PRIMARY KEY,
	"f_initialized" integer NOT NULL,
	"f_pending_operation" text,
	"f_pending_workspace_id" text,
	CONSTRAINT "ck_workspace_state_singleton" CHECK (f_singleton = 1)
);
--> statement-breakpoint
CREATE TABLE "t_workspaces" (
	"f_id" serial PRIMARY KEY,
	"f_workspace_id" text NOT NULL UNIQUE,
	"f_path" text NOT NULL,
	"f_title" text NOT NULL,
	"f_created_at" text NOT NULL,
	"f_updated_at" text NOT NULL,
	"f_position" integer DEFAULT -1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "t_workspace_sessions" (
	"f_id" serial PRIMARY KEY,
	"f_workspace_id" text NOT NULL,
	"f_session_id" text NOT NULL,
	"f_position" integer NOT NULL,
	CONSTRAINT "uq_workspace_sessions_workspace_session" UNIQUE("f_workspace_id", "f_session_id")
);
--> statement-breakpoint
CREATE INDEX "idx_session_projcache_row_key" ON "t_session_projcache_row" ("f_key");
--> statement-breakpoint
CREATE INDEX "idx_workspace_sessions_session_id" ON "t_workspace_sessions" ("f_session_id");
--> statement-breakpoint
ALTER TABLE "t_session_projcache_row" ADD CONSTRAINT "fk_t_session_projcache_row_f_session_id_t_sessions_f_session_id_fk" FOREIGN KEY ("f_session_id") REFERENCES "t_sessions"("f_session_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "t_workspace_sessions" ADD CONSTRAINT "fk_t_workspace_sessions_f_workspace_id_t_workspaces_f_workspace_id_fk" FOREIGN KEY ("f_workspace_id") REFERENCES "t_workspaces"("f_workspace_id") ON DELETE CASCADE;
