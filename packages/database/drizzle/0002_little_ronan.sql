CREATE TABLE "connector_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"external_event_id" text NOT NULL,
	"type" text NOT NULL,
	"agent" text NOT NULL,
	"session_id" text NOT NULL,
	"conversation_id" text,
	"payload" jsonb NOT NULL,
	"redacted" boolean DEFAULT false NOT NULL,
	"request_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_events_type_check" CHECK ("connector_events"."type" IN ('paired_turn'))
);
--> statement-breakpoint
CREATE TABLE "delivery_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"memory_ids" uuid[] DEFAULT '{}' NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"response" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_hash_check" CHECK ("idempotency_records"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "idempotency_records_status_check" CHECK ("idempotency_records"."status" IN ('processing', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "memory_provenance" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"message_role" text NOT NULL,
	"source_message_id" text,
	"excerpt" text NOT NULL,
	"redacted" boolean DEFAULT false NOT NULL,
	"confidence" double precision NOT NULL,
	"confirmation" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_provenance_role_check" CHECK ("memory_provenance"."message_role" IN ('assistant', 'user')),
	CONSTRAINT "memory_provenance_confidence_check" CHECK ("memory_provenance"."confidence" >= 0 AND "memory_provenance"."confidence" <= 1),
	CONSTRAINT "memory_provenance_confirmation_check" CHECK ("memory_provenance"."confirmation" IN ('unconfirmed', 'implicit', 'explicit'))
);
--> statement-breakpoint
CREATE TABLE "workspace_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_tokens_hash_check" CHECK ("workspace_tokens"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"organization" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_status_check" CHECK ("workspaces"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_event_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_redacted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "confidence" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "confirmation" text DEFAULT 'unconfirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "reconciliation_key" text;--> statement-breakpoint
ALTER TABLE "connector_events" ADD CONSTRAINT "connector_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_receipts" ADD CONSTRAINT "delivery_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_receipts" ADD CONSTRAINT "delivery_receipts_event_id_connector_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."connector_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_provenance" ADD CONSTRAINT "memory_provenance_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_provenance" ADD CONSTRAINT "memory_provenance_event_id_connector_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."connector_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tokens" ADD CONSTRAINT "workspace_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_events_external_idx" ON "connector_events" USING btree ("workspace_id","connector","external_event_id");--> statement-breakpoint
CREATE INDEX "connector_events_session_idx" ON "connector_events" USING btree ("workspace_id","session_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_receipts_event_idx" ON "delivery_receipts" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "delivery_receipts_workspace_idx" ON "delivery_receipts" USING btree ("workspace_id","delivered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_records_workspace_key_idx" ON "idempotency_records" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_records_expires_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_provenance_event_memory_idx" ON "memory_provenance" USING btree ("event_id","memory_id");--> statement-breakpoint
CREATE INDEX "memory_provenance_memory_idx" ON "memory_provenance" USING btree ("memory_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_tokens_hash_idx" ON "workspace_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "workspace_tokens_workspace_idx" ON "workspace_tokens" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_idx" ON "workspaces" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_organization_idx" ON "workspaces" USING btree ("organization");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_workspace_status_idx" ON "memories" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "memories_reconciliation_key_idx" ON "memories" USING btree ("workspace_id","reconciliation_key");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_confidence_check" CHECK ("memories"."confidence" >= 0 AND "memories"."confidence" <= 1);--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_confirmation_check" CHECK ("memories"."confirmation" IN ('unconfirmed', 'implicit', 'explicit'));