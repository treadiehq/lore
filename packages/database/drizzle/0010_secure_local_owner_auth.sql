CREATE TABLE "auth_owner_bootstraps" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"claimed_by_user_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_password_resets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_password_resets_hash_check" CHECK ("auth_password_resets"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "auth_password_resets_expires_check" CHECK ("auth_password_resets"."expires_at" > "auth_password_resets"."created_at"),
	CONSTRAINT "auth_password_resets_terminal_state_check" CHECK ("auth_password_resets"."consumed_at" IS NULL OR "auth_password_resets"."revoked_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "auth_users" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
UPDATE "auth_users" SET "role" = 'owner';--> statement-breakpoint
ALTER TABLE "auth_users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "auth_owner_bootstraps" ADD CONSTRAINT "auth_owner_bootstraps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_owner_bootstraps" ADD CONSTRAINT "auth_owner_bootstraps_claimed_by_user_id_auth_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_password_resets" ADD CONSTRAINT "auth_password_resets_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_owner_bootstraps_user_idx" ON "auth_owner_bootstraps" USING btree ("claimed_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_password_resets_hash_idx" ON "auth_password_resets" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_password_resets_user_active_idx" ON "auth_password_resets" USING btree ("user_id") WHERE "auth_password_resets"."consumed_at" IS NULL AND "auth_password_resets"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "auth_password_resets_expires_idx" ON "auth_password_resets" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "auth_users" ADD CONSTRAINT "auth_users_role_check" CHECK ("auth_users"."role" IN ('owner', 'member'));--> statement-breakpoint
ALTER TABLE "auth_users" ADD CONSTRAINT "auth_users_password_hash_check" CHECK ("auth_users"."password_hash" IS NULL OR "auth_users"."password_hash" LIKE '$argon2id$%');