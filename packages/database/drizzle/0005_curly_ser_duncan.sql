CREATE TABLE "devin_session_cursors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"session_id" text NOT NULL,
	"project" text,
	"repo" text NOT NULL,
	"cursor" text,
	"pending_assistant_id" text,
	"pending_assistant_content" text,
	"pending_assistant_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devin_session_cursors_status_check" CHECK ("devin_session_cursors"."status" IN ('active', 'paused', 'error')),
	CONSTRAINT "devin_session_cursors_pending_check" CHECK (("devin_session_cursors"."pending_assistant_content" IS NULL AND "devin_session_cursors"."pending_assistant_id" IS NULL AND "devin_session_cursors"."pending_assistant_at" IS NULL) OR ("devin_session_cursors"."pending_assistant_content" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "devin_session_cursors" ADD CONSTRAINT "devin_session_cursors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "devin_session_cursors_workspace_session_idx" ON "devin_session_cursors" USING btree ("workspace_id","organization_id","session_id");--> statement-breakpoint
CREATE INDEX "devin_session_cursors_poll_idx" ON "devin_session_cursors" USING btree ("status","last_polled_at");