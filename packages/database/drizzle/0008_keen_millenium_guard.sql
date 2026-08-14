CREATE TABLE "delivery_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_feedback_action_check" CHECK ("delivery_feedback"."action" IN ('wrong', 'forget'))
);
--> statement-breakpoint
ALTER TABLE "memories" DROP CONSTRAINT "memories_status_check";--> statement-breakpoint
DROP INDEX "memories_fingerprint_idx";--> statement-breakpoint
UPDATE "memories" AS "memory"
SET "workspace_id" = "workspace"."id"
FROM "workspaces" AS "workspace"
WHERE "memory"."workspace_id" IS NULL
  AND "memory"."organization" = "workspace"."organization";--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "memories" WHERE "workspace_id" IS NULL) THEN
		RAISE EXCEPTION 'Cannot require memories.workspace_id while unowned memories remain';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_receipts" ADD COLUMN "query_sha256" text;--> statement-breakpoint
ALTER TABLE "delivery_receipts" ADD COLUMN "retrieval_policy_version" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_receipts" ADD COLUMN "hits" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "suppressed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_feedback" ADD CONSTRAINT "delivery_feedback_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_feedback" ADD CONSTRAINT "delivery_feedback_receipt_id_delivery_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."delivery_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_feedback" ADD CONSTRAINT "delivery_feedback_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_feedback_receipt_memory_action_idx" ON "delivery_feedback" USING btree ("receipt_id","memory_id","action");--> statement-breakpoint
CREATE INDEX "delivery_feedback_workspace_idx" ON "delivery_feedback" USING btree ("workspace_id","created_at");--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "memory_provenance" AS "provenance"
		LEFT JOIN "memories" AS "memory" ON "memory"."id" = "provenance"."memory_id"
		WHERE "memory"."id" IS NULL
	) THEN
		RAISE EXCEPTION 'Cannot add memory provenance foreign key while orphan rows remain';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "memory_provenance" ADD CONSTRAINT "memory_provenance_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memories_fingerprint_idx" ON "memories" USING btree ("workspace_id","fingerprint") WHERE "memories"."status" IN ('active', 'suppressed');--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_suppressed_at_check" CHECK (("memories"."status" = 'suppressed' AND "memories"."suppressed_at" IS NOT NULL) OR ("memories"."status" <> 'suppressed' AND "memories"."suppressed_at" IS NULL));--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_status_check" CHECK ("memories"."status" IN ('active', 'suppressed', 'superseded', 'deleted'));