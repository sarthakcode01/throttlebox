CREATE TABLE "org_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_alerted_threshold" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_logs" (
	"time" timestamp with time zone DEFAULT now() NOT NULL,
	"key_id" uuid,
	"org_id" uuid NOT NULL,
	"service_id" uuid,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status_code" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"rate_limited" boolean DEFAULT false NOT NULL,
	"trace_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_webhooks" ADD CONSTRAINT "org_webhooks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_service_id_mock_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."mock_services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_webhooks_org_idx" ON "org_webhooks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "request_logs_time_idx" ON "request_logs" USING btree ("time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "request_logs_org_time_idx" ON "request_logs" USING btree ("org_id","time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "request_logs_key_time_idx" ON "request_logs" USING btree ("key_id","time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "request_logs_service_time_idx" ON "request_logs" USING btree ("service_id","time" DESC NULLS LAST);
--> statement-breakpoint
SELECT create_hypertable('request_logs', 'time', if_not_exists => TRUE);--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS usage_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS bucket,
  org_id,
  key_id,
  service_id,
  count(*)::int AS requests,
  count(*) FILTER (WHERE status_code >= 400)::int AS errors,
  count(*) FILTER (WHERE rate_limited = true)::int AS throttled,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) AS p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99
FROM request_logs
GROUP BY bucket, org_id, key_id, service_id
WITH NO DATA;
