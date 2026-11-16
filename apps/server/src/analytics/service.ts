import { sql } from '../db/client.js';
import type {
  AnalyticsErrorsBreakdown,
  AnalyticsLatencyBucket,
  AnalyticsOverview,
  AnalyticsUsageBucket,
  RequestLogSummary,
} from '@throttlebox/shared';
import { parseRangeToInterval, type TimeRange } from './types.js';

/**
 * Analytics queries.
 *
 * Ranges of a day or more read the `usage_hourly` continuous aggregate,
 * which is a few rows per hour instead of every request. It is set to
 * real-time aggregation (migration 0007), so hours newer than the last
 * refresh are computed from `request_logs` on read and the newest data is
 * never missing. The 1h view reads raw logs, for minute buckets.
 *
 * Percentiles do not combine exactly: the p95 of a day is not any function
 * of the hourly p95s. Across hours, keys and services the aggregate paths
 * report a request-weighted mean of the hourly percentiles. That is an
 * approximation, labelled as such in the dashboard, and it keeps the
 * 7- and 30-day views from scanning the whole hypertable.
 *
 * "Throttled" counts only requests the real rate limiter rejected
 * (`rate_limited`). A 429 injected by the chaos engine is a simulated fault
 * and is counted with the other 4xx responses instead.
 */

const BUCKET_MS: Record<string, number> = {
  '1 minute': 60_000,
  '1 hour': 3_600_000,
  '6 hours': 21_600_000,
  '1 day': 86_400_000,
};

/**
 * Fill buckets that had no traffic with zeros, so a quiet period shows as a
 * drop to zero instead of a straight line drawn across it.
 *
 * `time_bucket` aligns these intervals to UTC multiples of the bucket size,
 * so flooring the epoch time gives the same bucket boundaries.
 */
function zeroFill(
  rows: AnalyticsUsageBucket[],
  bucket: string,
  since: Date,
  until: Date,
): AnalyticsUsageBucket[] {
  const size = BUCKET_MS[bucket];
  if (!size) return rows;

  const byStart = new Map(rows.map((row) => [new Date(row.bucket).getTime(), row]));
  const filled: AnalyticsUsageBucket[] = [];
  for (let t = Math.floor(since.getTime() / size) * size; t <= until.getTime(); t += size) {
    filled.push(
      byStart.get(t) ?? { bucket: new Date(t).toISOString(), requests: 0, errors: 0, throttled: 0 },
    );
  }
  return filled;
}

export async function getOverview(
  orgId: string,
  range: TimeRange = '24h',
): Promise<AnalyticsOverview> {
  const { since } = parseRangeToInterval(range);
  const sinceStr = since.toISOString();

  type Row = {
    totalRequests: number;
    errorRequests: number;
    throttledRequests: number;
    p95LatencyMs: number;
    activeKeysCount: number;
  };

  let row: Row | undefined;

  if (range !== '1h') {
    try {
      [row] = await sql<Row[]>`
        SELECT
          COALESCE(sum(requests), 0)::int AS "totalRequests",
          COALESCE(sum(errors), 0)::int AS "errorRequests",
          COALESCE(sum(throttled), 0)::int AS "throttledRequests",
          COALESCE(sum(p95 * requests) / NULLIF(sum(requests), 0), 0)::int AS "p95LatencyMs",
          count(DISTINCT key_id)::int AS "activeKeysCount"
        FROM usage_hourly
        WHERE org_id = ${orgId} AND bucket >= ${sinceStr}::timestamptz;
      `;
    } catch {
      row = undefined; // No TimescaleDB: fall through to the raw table.
    }
  }

  if (!row) {
    [row] = await sql<Row[]>`
      SELECT
        count(*)::int AS "totalRequests",
        count(*) FILTER (WHERE status_code >= 400)::int AS "errorRequests",
        count(*) FILTER (WHERE rate_limited = true)::int AS "throttledRequests",
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS "p95LatencyMs",
        count(DISTINCT key_id)::int AS "activeKeysCount"
      FROM request_logs
      WHERE org_id = ${orgId} AND time >= ${sinceStr}::timestamptz;
    `;
  }

  const total = row?.totalRequests ?? 0;
  const errorCount = row?.errorRequests ?? 0;
  const errorRate = total > 0 ? Math.round((errorCount / total) * 1000) / 10 : 0;

  return {
    totalRequests: total,
    errorRate,
    p95LatencyMs: row?.p95LatencyMs ?? 0,
    throttledRequests: row?.throttledRequests ?? 0,
    activeKeysCount: row?.activeKeysCount ?? 0,
  };
}

export async function getUsageSeries(
  orgId: string,
  range: TimeRange = '24h',
  keyId?: string,
  serviceId?: string,
): Promise<AnalyticsUsageBucket[]> {
  const { bucket, since } = parseRangeToInterval(range);
  const sinceStr = since.toISOString();
  const until = new Date();

  type Row = { bucket: Date; requests: number; errors: number; throttled: number };
  let rows: Row[] | null = null;

  if (range !== '1h') {
    try {
      rows = await sql<Row[]>`
        SELECT
          time_bucket(${bucket}::interval, bucket) AS bucket,
          COALESCE(sum(requests), 0)::int AS requests,
          COALESCE(sum(errors), 0)::int AS errors,
          COALESCE(sum(throttled), 0)::int AS throttled
        FROM usage_hourly
        WHERE org_id = ${orgId} AND bucket >= ${sinceStr}::timestamptz
          ${keyId ? sql`AND key_id = ${keyId}` : sql``}
          ${serviceId ? sql`AND service_id = ${serviceId}` : sql``}
        GROUP BY 1
        ORDER BY 1 ASC;
      `;
    } catch {
      rows = null; // No continuous aggregate: use the raw table.
    }
  }

  if (!rows) {
    rows = await sql<Row[]>`
      SELECT
        time_bucket(${bucket}::interval, time) AS bucket,
        count(*)::int AS requests,
        count(*) FILTER (WHERE status_code >= 400)::int AS errors,
        count(*) FILTER (WHERE rate_limited = true)::int AS throttled
      FROM request_logs
      WHERE org_id = ${orgId} AND time >= ${sinceStr}::timestamptz
        ${keyId ? sql`AND key_id = ${keyId}` : sql``}
        ${serviceId ? sql`AND service_id = ${serviceId}` : sql``}
      GROUP BY bucket
      ORDER BY bucket ASC;
    `;
  }

  const series = rows.map((r) => ({
    bucket: new Date(r.bucket).toISOString(),
    requests: r.requests,
    errors: r.errors,
    throttled: r.throttled,
  }));

  return zeroFill(series, bucket, since, until);
}

export async function getLatencySeries(
  orgId: string,
  range: TimeRange = '24h',
): Promise<AnalyticsLatencyBucket[]> {
  const { bucket, since } = parseRangeToInterval(range);
  const sinceStr = since.toISOString();

  type Row = { bucket: Date; p50: number; p95: number; p99: number };
  let rows: Row[] | null = null;

  if (range !== '1h') {
    try {
      rows = await sql<Row[]>`
        SELECT
          time_bucket(${bucket}::interval, bucket) AS bucket,
          COALESCE(sum(p50 * requests) / NULLIF(sum(requests), 0), 0)::int AS p50,
          COALESCE(sum(p95 * requests) / NULLIF(sum(requests), 0), 0)::int AS p95,
          COALESCE(sum(p99 * requests) / NULLIF(sum(requests), 0), 0)::int AS p99
        FROM usage_hourly
        WHERE org_id = ${orgId} AND bucket >= ${sinceStr}::timestamptz
        GROUP BY 1
        ORDER BY 1 ASC;
      `;
    } catch {
      rows = null;
    }
  }

  if (!rows) {
    rows = await sql<Row[]>`
      SELECT
        time_bucket(${bucket}::interval, time) AS bucket,
        COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p50,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95,
        COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p99
      FROM request_logs
      WHERE org_id = ${orgId} AND time >= ${sinceStr}::timestamptz
      GROUP BY bucket
      ORDER BY bucket ASC;
    `;
  }

  return rows.map((r) => ({
    bucket: new Date(r.bucket).toISOString(),
    p50: r.p50,
    p95: r.p95,
    p99: r.p99,
  }));
}

/**
 * Status breakdown and top failing paths.
 *
 * This one reads the raw table for every range: the aggregate has no status
 * classes and no paths. It is scoped by the `(org_id, time)` index.
 */
export async function getErrorsBreakdown(
  orgId: string,
  range: TimeRange = '24h',
): Promise<AnalyticsErrorsBreakdown> {
  const { since } = parseRangeToInterval(range);
  const sinceStr = since.toISOString();

  const [counts] = await sql<
    {
      status2xx: number;
      status4xx: number;
      status429: number;
      status5xx: number;
    }[]
  >`
    SELECT
      count(*) FILTER (WHERE status_code < 400)::int AS "status2xx",
      count(*) FILTER (WHERE status_code >= 400 AND status_code < 500 AND status_code != 429)::int AS "status4xx",
      count(*) FILTER (WHERE status_code = 429)::int AS "status429",
      count(*) FILTER (WHERE status_code >= 500)::int AS "status5xx"
    FROM request_logs
    WHERE org_id = ${orgId} AND time >= ${sinceStr}::timestamptz;
  `;

  const topPaths = await sql<
    {
      path: string;
      statusCode: number;
      count: number;
    }[]
  >`
    SELECT
      path,
      status_code AS "statusCode",
      count(*)::int AS count
    FROM request_logs
    WHERE org_id = ${orgId} AND time >= ${sinceStr}::timestamptz AND status_code >= 400
    GROUP BY path, status_code
    ORDER BY count DESC
    LIMIT 5;
  `;

  return {
    // Everything below 400 counts as success, so 1xx/3xx responses are not
    // silently missing from the bar.
    status2xx: counts?.status2xx ?? 0,
    status4xx: counts?.status4xx ?? 0,
    status429: counts?.status429 ?? 0,
    status5xx: counts?.status5xx ?? 0,
    topErrorPaths: topPaths.map((p) => ({
      path: p.path,
      statusCode: p.statusCode,
      count: p.count,
    })),
  };
}

/** How far back the logs view reaches: the raw-log retention window. */
const LOG_RETENTION_DAYS = 30;

/**
 * The number of retained log rows, for pagination.
 *
 * An exact `count(*)` over the hypertable ran every five seconds while the
 * dashboard was open. The aggregate gives the same number from a few rows
 * per hour; the exact count is only the fallback.
 */
async function countRetainedLogs(orgId: string): Promise<number> {
  const since = new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString();
  try {
    const [row] = await sql<{ count: number }[]>`
      SELECT COALESCE(sum(requests), 0)::int AS count
      FROM usage_hourly
      WHERE org_id = ${orgId} AND bucket >= ${since}::timestamptz;
    `;
    return row?.count ?? 0;
  } catch {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM request_logs WHERE org_id = ${orgId};
    `;
    return row?.count ?? 0;
  }
}

export async function getRecentLogs(
  orgId: string,
  limit = 50,
  offset = 0,
): Promise<{ logs: RequestLogSummary[]; total: number }> {
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 100);
  const safeOffset = Math.max(Number.isFinite(offset) ? offset : 0, 0);

  const rows = await sql<
    {
      time: Date;
      keyId: string | null;
      keyPrefix: string | null;
      keyLast4: string | null;
      orgId: string;
      serviceId: string | null;
      serviceSlug: string | null;
      method: string;
      path: string;
      statusCode: number;
      latencyMs: number;
      rateLimited: boolean;
      traceId: string;
    }[]
  >`
    SELECT
      r.time,
      r.key_id AS "keyId",
      k.prefix AS "keyPrefix",
      k.last4 AS "keyLast4",
      r.org_id AS "orgId",
      r.service_id AS "serviceId",
      s.slug AS "serviceSlug",
      r.method,
      r.path,
      r.status_code AS "statusCode",
      r.latency_ms AS "latencyMs",
      r.rate_limited AS "rateLimited",
      r.trace_id AS "traceId"
    FROM request_logs r
    LEFT JOIN api_keys k ON r.key_id = k.id
    LEFT JOIN mock_services s ON r.service_id = s.id
    WHERE r.org_id = ${orgId}
    ORDER BY r.time DESC
    LIMIT ${safeLimit} OFFSET ${safeOffset};
  `;

  const total = await countRetainedLogs(orgId);

  const logs: RequestLogSummary[] = rows.map((r) => ({
    time: new Date(r.time).toISOString(),
    keyId: r.keyId,
    // The same masked form the keys page uses.
    keyDisplay: r.keyPrefix && r.keyLast4 ? `${r.keyPrefix}…${r.keyLast4}` : null,
    orgId: r.orgId,
    serviceId: r.serviceId,
    serviceSlug: r.serviceSlug,
    method: r.method,
    path: r.path,
    statusCode: r.statusCode,
    latencyMs: r.latencyMs,
    rateLimited: r.rateLimited,
    traceId: r.traceId,
  }));

  return {
    logs,
    // Never report fewer rows than are already on screen.
    total: Math.max(total, safeOffset + logs.length),
  };
}
