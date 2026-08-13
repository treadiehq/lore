CREATE TABLE "auth_magic_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_magic_links_hash_check" CHECK ("auth_magic_links"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "auth_magic_links_expires_check" CHECK ("auth_magic_links"."expires_at" > "auth_magic_links"."created_at"),
	CONSTRAINT "auth_magic_links_terminal_state_check" CHECK ("auth_magic_links"."consumed_at" IS NULL OR "auth_magic_links"."revoked_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_hash_check" CHECK ("auth_sessions"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "auth_sessions_expires_check" CHECK ("auth_sessions"."expires_at" > "auth_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "auth_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_users_email_normalized_check" CHECK ("auth_users"."email" = lower(btrim("auth_users"."email")) AND length("auth_users"."email") BETWEEN 3 AND 320),
	CONSTRAINT "auth_users_status_check" CHECK ("auth_users"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "auth_magic_links" ADD CONSTRAINT "auth_magic_links_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_users" ADD CONSTRAINT "auth_users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_magic_links_hash_idx" ON "auth_magic_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_magic_links_user_active_idx" ON "auth_magic_links" USING btree ("user_id") WHERE "auth_magic_links"."consumed_at" IS NULL AND "auth_magic_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "auth_magic_links_user_idx" ON "auth_magic_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_magic_links_expires_idx" ON "auth_magic_links" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_hash_idx" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_users_email_idx" ON "auth_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "auth_users_workspace_idx" ON "auth_users" USING btree ("workspace_id");