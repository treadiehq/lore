CREATE TABLE "memory_conflicts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"proposal_memory_id" uuid NOT NULL,
	"target_memory_id" uuid NOT NULL,
	"detector" text NOT NULL,
	"severity" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "memory_conflicts_detector_check" CHECK ("memory_conflicts"."detector" IN ('deterministic', 'lexical', 'semantic', 'llm')),
	CONSTRAINT "memory_conflicts_severity_check" CHECK ("memory_conflicts"."severity" IN ('blocking', 'warning')),
	CONSTRAINT "memory_conflicts_resolution_check" CHECK ("memory_conflicts"."resolution" IS NULL OR "memory_conflicts"."resolution" IN ('approve', 'use_proposal', 'keep_both', 'reject')),
	CONSTRAINT "memory_conflicts_resolution_metadata_check" CHECK (("memory_conflicts"."resolution" IS NULL AND "memory_conflicts"."resolved_at" IS NULL) OR ("memory_conflicts"."resolution" IS NOT NULL AND "memory_conflicts"."resolved_at" IS NOT NULL)),
	CONSTRAINT "memory_conflicts_not_self_check" CHECK ("memory_conflicts"."proposal_memory_id" <> "memory_conflicts"."target_memory_id")
);
--> statement-breakpoint
CREATE TABLE "memory_proposals" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"policy_mode" text NOT NULL,
	"reason" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" text,
	"reviewer_id" text,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"decision_target_memory_id" uuid,
	CONSTRAINT "memory_proposals_policy_mode_check" CHECK ("memory_proposals"."policy_mode" IN ('trust_tiered', 'proposal_only')),
	CONSTRAINT "memory_proposals_decision_check" CHECK ("memory_proposals"."decision" IS NULL OR "memory_proposals"."decision" IN ('approve', 'use_proposal', 'keep_both', 'reject')),
	CONSTRAINT "memory_proposals_decision_metadata_check" CHECK ((
        "memory_proposals"."decision" IS NULL
        AND "memory_proposals"."reviewer_id" IS NULL
        AND "memory_proposals"."decision_reason" IS NULL
        AND "memory_proposals"."decided_at" IS NULL
        AND "memory_proposals"."decision_target_memory_id" IS NULL
      ) OR (
        "memory_proposals"."decision" IS NOT NULL
        AND "memory_proposals"."reviewer_id" IS NOT NULL
        AND "memory_proposals"."decision_reason" IS NOT NULL
        AND "memory_proposals"."decided_at" IS NOT NULL
        AND (
          ("memory_proposals"."decision" = 'use_proposal' AND "memory_proposals"."decision_target_memory_id" IS NOT NULL)
          OR ("memory_proposals"."decision" <> 'use_proposal' AND "memory_proposals"."decision_target_memory_id" IS NULL)
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "memories" DROP CONSTRAINT "memories_status_check";--> statement-breakpoint
DROP INDEX "memories_fingerprint_idx";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "learning_mode" text DEFAULT 'trust_tiered' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "llm_conflict_analysis_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_conflicts" ADD CONSTRAINT "memory_conflicts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_conflicts" ADD CONSTRAINT "memory_conflicts_proposal_memory_id_memories_id_fk" FOREIGN KEY ("proposal_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_conflicts" ADD CONSTRAINT "memory_conflicts_target_memory_id_memories_id_fk" FOREIGN KEY ("target_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_decision_target_memory_id_memories_id_fk" FOREIGN KEY ("decision_target_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_conflicts_edge_idx" ON "memory_conflicts" USING btree ("workspace_id","proposal_memory_id","target_memory_id","detector");--> statement-breakpoint
CREATE INDEX "memory_conflicts_proposal_idx" ON "memory_conflicts" USING btree ("proposal_memory_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_conflicts_target_idx" ON "memory_conflicts" USING btree ("target_memory_id");--> statement-breakpoint
CREATE INDEX "memory_conflicts_workspace_idx" ON "memory_conflicts" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_proposals_workspace_idx" ON "memory_proposals" USING btree ("workspace_id","proposed_at");--> statement-breakpoint
CREATE INDEX "memory_proposals_decision_target_idx" ON "memory_proposals" USING btree ("decision_target_memory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memories_fingerprint_idx" ON "memories" USING btree ("workspace_id","fingerprint") WHERE "memories"."status" IN ('active', 'proposed', 'suppressed');--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_status_check" CHECK ("memories"."status" IN ('active', 'proposed', 'suppressed', 'superseded', 'deleted'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_learning_mode_check" CHECK ("workspaces"."learning_mode" IN ('trust_tiered', 'proposal_only'));