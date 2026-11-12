-- TimescaleDB Continuous Aggregate Refresh Policy and Hypertable Retention Policy

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
  ) THEN
    -- Continuous aggregate refresh policy for usage_hourly
    PERFORM add_continuous_aggregate_policy(
      'usage_hourly',
      start_offset => INTERVAL '1 month',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '1 hour',
      if_not_exists => TRUE
    );

    -- Retention policy for raw request_logs hypertable (retain 30 days)
    PERFORM add_retention_policy(
      'request_logs',
      drop_after => INTERVAL '30 days',
      if_not_exists => TRUE
    );
  END IF;
END $$;
