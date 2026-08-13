CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"organization" text,
	"project" text,
	"repo" text,
	"category" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source_agent" text NOT NULL,
	"source_session_id" text,
	"source_message_id" text,
	"source_raw_text" text,
	"fingerprint" text NOT NULL,
	"supersedes_memory_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "memories_category_check" CHECK ("memories"."category" IN ('architecture', 'convention', 'correction', 'known_gotcha', 'deprecated', 'behavior', 'other')),
	CONSTRAINT "memories_status_check" CHECK ("memories"."status" IN ('active', 'superseded', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersedes_memory_id_memories_id_fk" FOREIGN KEY ("supersedes_memory_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memories_fingerprint_idx" ON "memories" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "memories_scope_status_idx" ON "memories" USING btree ("organization","project","repo","status");--> statement-breakpoint
CREATE INDEX "memories_status_idx" ON "memories" USING btree ("status");--> statement-breakpoint
CREATE INDEX "memories_supersedes_memory_id_idx" ON "memories" USING btree ("supersedes_memory_id");--> statement-breakpoint
CREATE INDEX "memories_content_search_idx" ON "memories" USING gin (to_tsvector('simple', "content"));