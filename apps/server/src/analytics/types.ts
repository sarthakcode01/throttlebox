export interface LogEntryInput {
  time?: Date;
  keyId?: string | null;
  orgId: string;
  serviceId?: string | null;
  method: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  rateLimited?: boolean;
  traceId: string;
}

export type TimeRange = '1h' | '24h' | '7d' | '30d';

export interface AnalyticsFilter {
  orgId: string;
  range?: TimeRange;
  keyId?: string;
  serviceId?: string;
}

export function parseRangeToInterval(range: TimeRange = '24h'): { interval: string; bucket: string; since: Date } {
  const now = new Date();
  switch (range) {
    case '1h':
      return {
        interval: '1 hour',
        bucket: '1 minute',
        since: new Date(now.getTime() - 60 * 60 * 1000),
      };
    case '24h':
      return {
        interval: '24 hours',
        bucket: '1 hour',
        since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      };
    case '7d':
      return {
        interval: '7 days',
        bucket: '6 hours',
        since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      };
    case '30d':
      return {
        interval: '30 days',
        bucket: '1 day',
        since: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      };
    default:
      return {
        interval: '24 hours',
        bucket: '1 hour',
        since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      };
  }
}
