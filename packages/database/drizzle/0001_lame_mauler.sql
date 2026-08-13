ALTER TABLE "memories" DROP CONSTRAINT "memories_category_check";--> statement-breakpoint
DROP INDEX "memories_fingerprint_idx";--> statement-breakpoint
DROP INDEX "memories_scope_status_idx";--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "component" text;--> statement-breakpoint
CREATE UNIQUE INDEX "memories_supersedes_unique_idx" ON "memories" USING btree ("supersedes_memory_id") WHERE "memories"."supersedes_memory_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "memories_fingerprint_idx" ON "memories" USING btree ("fingerprint") WHERE "memories"."status" = 'active';--> statement-breakpoint
CREATE INDEX "memories_scope_status_idx" ON "memories" USING btree ("organization","project","repo","path","component","status");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_deleted_at_check" CHECK (("memories"."status" = 'deleted' AND "memories"."deleted_at" IS NOT NULL) OR ("memories"."status" <> 'deleted' AND "memories"."deleted_at" IS NULL));--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_not_self_superseding_check" CHECK ("memories"."supersedes_memory_id" IS NULL OR "memories"."supersedes_memory_id" <> "memories"."id");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_category_check" CHECK ("memories"."category" IN ('architecture', 'convention', 'correction', 'gotcha', 'known_gotcha', 'deprecated', 'behavior', 'review_feedback', 'other'));