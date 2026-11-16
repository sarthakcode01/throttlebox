CREATE TABLE IF NOT EXISTS "chaos_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"service_id" uuid,
	"key_id" uuid,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"latency" jsonb DEFAULT '{"enabled":false,"distribution":"normal","meanMs":200,"stddevMs":50,"minMs":0,"maxMs":30000}'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '{"enabled":false,"rate5xx":0,"rate429":0,"statusCodes":[500,502,503,504]}'::jsonb NOT NULL,
	"partition" jsonb DEFAULT '{"enabled":false,"dropRate":0}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chaos_rules" ADD CONSTRAINT "chaos_rules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chaos_rules" ADD CONSTRAINT "chaos_rules_service_id_mock_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "mock_services"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chaos_rules" ADD CONSTRAINT "chaos_rules_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "api_keys"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chaos_rules_org_idx" ON "chaos_rules" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chaos_rules_scope_idx" ON "chaos_rules" USING btree ("org_id","service_id","key_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chaos_rules_org_default_idx" ON "chaos_rules" ("org_id") WHERE "service_id" IS NULL AND "key_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chaos_rules_service_idx" ON "chaos_rules" ("org_id", "service_id") WHERE "key_id" IS NULL AND "service_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chaos_rules_key_idx" ON "chaos_rules" ("org_id", "key_id") WHERE "service_id" IS NULL AND "key_id" IS NOT NULL;
