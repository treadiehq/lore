CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
UPDATE "memories" AS "memory"
SET "workspace_id" = "workspace"."id"
FROM "workspaces" AS "workspace"
WHERE "memory"."workspace_id" IS NULL
  AND "memory"."organization" = "workspace"."organization";--> statement-breakpoint
ALTER TABLE "delivery_receipts" ADD COLUMN "packing" jsonb;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "memories_embedding_hnsw_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops) WHERE "memories"."status" = 'active' AND "memories"."embedding" IS NOT NULL;