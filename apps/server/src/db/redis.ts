import Redis from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on('error', (err) => {
  // ioredis emits on every reconnect; don't crash the process.
  console.error('[redis] error:', err.message);
});

export type RedisClient = typeof redis;
