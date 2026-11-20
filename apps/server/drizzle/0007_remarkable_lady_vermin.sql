CREATE TYPE "public"."playground_kind" AS ENUM('send', 'replay', 'fork');--> statement-breakpoint
CREATE TYPE "public"."playground_outcome" AS ENUM('ok', 'dropped', 'error');--> statement-breakpoint
CREATE TABLE "playground_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"key_id" uuid,
	"parent_id" uuid,
	"kind" "playground_kind" DEFAULT 'send' NOT NULL,
	"method" "http_method" NOT NULL,
	"service_slug" text NOT NULL,
	"path" text NOT NULL,
	"query" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text,
	"outcome" "playground_outcome" DEFAULT 'ok' NOT NULL,
	"response_status" integer,
	"response_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_body" text DEFAULT '' NOT NULL,
	"response_truncated" boolean DEFAULT false NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playground_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" uuid,
	"name" text DEFAULT 'Untitled session' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playground_requests" ADD CONSTRAINT "playground_requests_session_id_playground_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."playground_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playground_requests" ADD CONSTRAINT "playground_requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playground_requests" ADD CONSTRAINT "playground_requests_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playground_requests" ADD CONSTRAINT "playground_requests_parent_id_playground_requests_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."playground_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playground_requests_session_idx" ON "playground_requests" USING btree ("session_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "playground_requests_org_idx" ON "playground_requests" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "playground_requests_created_idx" ON "playground_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "playground_sessions_org_idx" ON "playground_sessions" USING btree ("org_id","created_at" DESC NULLS LAST);
