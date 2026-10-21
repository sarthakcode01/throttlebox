CREATE TYPE "public"."http_method" AS ENUM('GET', 'POST', 'PUT', 'PATCH', 'DELETE');--> statement-breakpoint
CREATE TABLE "mock_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"method" "http_method" NOT NULL,
	"path" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status_code" integer DEFAULT 200 NOT NULL,
	"response_template" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"weighted_responses" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_seeded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mock_routes" ADD CONSTRAINT "mock_routes_service_id_mock_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."mock_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_services" ADD CONSTRAINT "mock_services_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mock_routes_service_idx" ON "mock_routes" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mock_routes_service_method_path_uniq" ON "mock_routes" USING btree ("service_id","method","path");--> statement-breakpoint
CREATE UNIQUE INDEX "mock_services_org_slug_uniq" ON "mock_services" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "mock_services_org_idx" ON "mock_services" USING btree ("org_id");