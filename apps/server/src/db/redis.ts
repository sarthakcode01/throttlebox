import Redis from 'ioredis';
import { config } from '../config.js';

// One retry, not three. Every Redis caller on the request path fails open
// (or falls back), and each retry it waits through is latency added to a
// live request during an outage.
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: false,
});

redis.on('error', (err) => {
  // ioredis emits on every reconnect; don't crash the process.
  console.error('[redis] error:', err.message);
});

export type RedisClient = typeof redis;
