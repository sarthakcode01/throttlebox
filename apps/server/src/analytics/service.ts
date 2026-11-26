import { sql } from '../db/client.js';
import type {
  AnalyticsErrorsBreakdown,
  AnalyticsLatencyBucket,
  AnalyticsOverview,
  AnalyticsUsageBucket,
  RequestLogSummary,
} from '@throttlebox/shared';
import { parseRangeToInterval, type TimeRange } from './types.js';

export async function getOverview(
  orgId: string,
  range: TimeRange = '24h',
): Promise<AnalyticsOverview> {
  const { since } = parseRangeToInterval(range);
  const sinceStr = since.toISOString();

  const [row] = await sql<
    {
      totalRequests: number;
      errorRequests: number;
      throttledRequests: number;
      p95LatencyMs: number;
      activeKeysCount: number;
    }[]
  >`
    SELECT
      count(*)::int AS "totalRequests",
      count(*) FILTER (WHERE status_code >= 400)::int AS "errorRequests",
      count(*) FILTER (WHERE rate_limited = true OR status_code = 429)::int AS "throttledRequests",
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS "p95LatencyMs",
      count(DISTINCT key_id)::int AS "activeKeysCount"
    FROM request_logs
    WHERE org_id = ${orgId} AND time >= ${sinceStr}::timestamptz;
  `;

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

  // Fast path: use TimescaleDB continuous aggregate view `usage_hourly` for ranges >= 24h
  if (range !== '1h') {
    try {
      const caggRows = await sql<
        {
          bucket: Date;
          requests: number;
          errors: number;
          throttled: number;
        }[]
      >`
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

      if (caggRows.length > 0) {
        return caggRows.map((r) => ({
          bucket: new Date(r.bucket).toISOString(),
          requests: r.requests,
          errors: r.errors,
          throttled: r.throttled,
        }));
      }
    } catch {
      // Fallback to request_logs if continuous aggregate view is unavailable or unpopulated
    }
  }

  const rows = await sql<
    {
      bucket: Date;
      requests: number;
      errors: number;
      throttled: number;
    }[]
  >`
    SELECT
      time_bucket(${bucket}::interval, time) AS bucket,
      count(*)::int AS requests,
      count(*) FILTER (WHERE status_code >= 400)::int AS errors,
      count(*) FILTER (WHERE rate_limited = true OR status_code = 429)::int AS throttled
    FROM request_logs
    WHERE org_id = ${orgId} AND time >= ${sinceStr}::timestamptz
      ${keyId ? sql`AND key_id = ${keyId}` : sql``}
      ${serviceId ? sql`AND service_id = ${serviceId}` : sql``}
    GROUP BY bucket
    ORDER BY bucket ASC;
  `;

  return rows.map((r) => ({
    bucket: new Date(r.bucket).toISOString(),
    requests: r.requests,
    errors: r.errors,
    throttled: r.throttled,
  }));
}

export async function getLatencySeries(
  orgId: string,
  range: TimeRange = '24h',
): Promise<AnalyticsLatencyBucket[]> {
  const { bucket, since } = parseRangeToInterval(range);
  const sinceStr = since.toISOString();

  const rows = await sql<
    {
      bucket: Date;
      p50: number;
      p95: number;
      p99: number;
    }[]
  >`
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

  return rows.map((r) => ({
    bucket: new Date(r.bucket).toISOString(),
    p50: r.p50,
    p95: r.p95,
    p99: r.p99,
  }));
}

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
      count(*) FILTER (WHERE status_code >= 200 AND status_code < 300)::int AS "status2xx",
      count(*) FILTER (WHERE status_code >= 400 AND status_code < 500 AND status_code != 429)::int AS "status4xx",
      count(*) FILTER (WHERE status_code = 429 OR rate_limited = true)::int AS "status429",
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

export async function getRecentLogs(
  orgId: string,
  limit = 50,
  offset = 0,
): Promise<{ logs: RequestLogSummary[]; total: number }> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const safeOffset = Math.max(offset, 0);

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

  // Bounded count.
  //
  // This used to be an unbounded `count(*)` over the organisation's entire
  // history on a hypertable with 30-day retention — a full scan on every page
  // load of the logs view. Counting only the retained window the UI can
  // actually page through, and reading the continuous aggregate when the range
  // is long enough, keeps the cost proportional to what is displayed.
  const [totalRow] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM request_logs
    WHERE org_id = ${orgId}
      AND time >= NOW() - INTERVAL '30 days';
  `;

  const logs: RequestLogSummary[] = rows.map((r) => ({
    time: new Date(r.time).toISOString(),
    keyId: r.keyId,
    keyDisplay: r.keyPrefix && r.keyLast4 ? `${r.keyPrefix}.${r.keyLast4}` : null,
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
    total: totalRow?.count ?? 0,
  };
}
