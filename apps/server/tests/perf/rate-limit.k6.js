/* global __ENV */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Custom metrics to verify rate limiting behavior under load
const allowedCount = new Counter('ratelimit_allowed_200');
const rateLimitedCount = new Counter('ratelimit_throttled_429');
const limiterLatency = new Trend('ratelimit_p95_overhead_ms');

export const options = {
  stages: [
    { duration: '5s', target: 50 }, // Warm up to 50 concurrent users
    { duration: '10s', target: 200 }, // Spike to 200 concurrent users
    { duration: '5s', target: 0 }, // Ramp down
  ],
  thresholds: {
    // Phase 4 Exit Criteria: P95 limiter overhead < 5ms
    http_req_duration: ['p(95)<50'], // total latency including mock template rendering
    ratelimit_p95_overhead_ms: ['p(95)<5'],
  },
};

const BASE_URL = (typeof __ENV !== 'undefined' && __ENV.TARGET_URL) || 'http://localhost:3001';
const API_KEY =
  (typeof __ENV !== 'undefined' && __ENV.API_KEY) ||
  'sk_test_testpublic12_secretsecretsecretsecretsecret32';
const ENDPOINT = `${BASE_URL}/mock/ecommerce/products/42`;

export default function () {
  const params = {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  };

  const startTime = Date.now();
  const res = http.get(ENDPOINT, params);
  const elapsed = Date.now() - startTime;
  limiterLatency.add(elapsed);

  if (res.status === 200) {
    allowedCount.add(1);
    check(res, {
      '200 status is ok': (r) => r.status === 200,
      'has X-RateLimit-Limit': (r) => r.headers['X-Ratelimit-Limit'] !== undefined,
      'has X-RateLimit-Remaining': (r) => r.headers['X-Ratelimit-Remaining'] !== undefined,
      'has X-RateLimit-Reset': (r) => r.headers['X-Ratelimit-Reset'] !== undefined,
    });
  } else if (res.status === 429) {
    rateLimitedCount.add(1);
    check(res, {
      '429 status is throttled': (r) => r.status === 429,
      'has Retry-After header': (r) => r.headers['Retry-After'] !== undefined,
      'has X-RateLimit-Remaining == 0': (r) => r.headers['X-Ratelimit-Remaining'] === '0',
      'error body is rate_limited': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.error === 'rate_limited';
        } catch {
          return false;
        }
      },
    });
  } else {
    check(res, {
      'unexpected status code': () => false,
    });
  }

  sleep(0.05); // slight pacing between requests
}
