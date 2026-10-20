CREATE TYPE "public"."key_env" AS ENUM('test', 'live');--> statement-breakpoint
CREATE TYPE "public"."key_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "api_key_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key_id" uuid,
	"family_id" uuid,
	"org_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"event" text NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key_families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"name" text NOT NULL,
	"public_id" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"last4" text NOT NULL,
	"env" "key_env" DEFAULT 'test' NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "key_status" DEFAULT 'active' NOT NULL,
	"idempotency_key" text,
	"expires_at" timestamp with time zone,
	"grace_until" timestamp with time zone,
	"rotated_from" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "api_key_events" ADD CONSTRAINT "api_key_events_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_events" ADD CONSTRAINT "api_key_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_families" ADD CONSTRAINT "api_key_families_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_family_id_api_key_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."api_key_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_rotated_from_api_keys_id_fk" FOREIGN KEY ("rotated_from") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_events_org_idx" ON "api_key_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "api_key_events_key_idx" ON "api_key_events" USING btree ("key_id","created_at");--> statement-breakpoint
CREATE INDEX "api_key_families_org_idx" ON "api_key_families" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_public_id_uniq" ON "api_keys" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "api_keys_family_idx" ON "api_keys" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_idempotency_uniq" ON "api_keys" USING btree ("org_id","idempotency_key");