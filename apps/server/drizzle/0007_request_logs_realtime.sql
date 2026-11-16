-- `chaos_rules` and its indexes are created by 0006. This migration only
-- records them in the drizzle snapshot, so every statement here is
-- idempotent and safe on a database that already has them.
CREATE UNIQUE INDEX IF NOT EXISTS "chaos_rules_org_default_idx" ON "chaos_rules" USING btree ("org_id") WHERE "chaos_rules"."service_id" IS NULL AND "chaos_rules"."key_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chaos_rules_service_idx" ON "chaos_rules" USING btree ("org_id","service_id") WHERE "chaos_rules"."key_id" IS NULL AND "chaos_rules"."service_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chaos_rules_key_idx" ON "chaos_rules" USING btree ("org_id","key_id") WHERE "chaos_rules"."service_id" IS NULL AND "chaos_rules"."key_id" IS NOT NULL;--> statement-breakpoint

-- Foreign keys on a hypertable lock every chunk on a parent delete, and a
-- single orphaned row in a batched INSERT failed the whole batch forever.
ALTER TABLE "request_logs" DROP CONSTRAINT IF EXISTS "request_logs_key_id_api_keys_id_fk";--> statement-breakpoint
ALTER TABLE "request_logs" DROP CONSTRAINT IF EXISTS "request_logs_org_id_orgs_id_fk";--> statement-breakpoint
ALTER TABLE "request_logs" DROP CONSTRAINT IF EXISTS "request_logs_service_id_mock_services_id_fk";--> statement-breakpoint

-- Real-time aggregation: rows newer than the materialization watermark are
-- computed from `request_logs` on read, so the newest hour is never missing
-- from the charts, and the view returns data before the first refresh.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    ALTER MATERIALIZED VIEW usage_hourly SET (timescaledb.materialized_only = false);
  END IF;
END $$;
