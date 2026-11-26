import type {
  ChaosErrorConfig,
  ChaosLatencyConfig,
  ChaosPartitionConfig,
} from '@throttlebox/shared';

/**
 * Samples a random number from a normal (Gaussian) distribution
 * using the Box-Muller transform.
 *
 * Clamps the output between `min` and `max` (defaults to 0ms and 30,000ms).
 */
export function sampleNormal(mean: number, stddev: number, min = 0, max = 30000): number {
  const safeMean = Number.isFinite(mean) ? mean : 0;
  const safeStddev = Number.isFinite(stddev) ? stddev : 0;
  const safeMin = Math.max(0, Math.min(min, max));
  const safeMax = Math.min(30000, Math.max(min, max));

  if (safeStddev <= 0) {
    return Math.min(Math.max(Math.round(safeMean), safeMin), safeMax);
  }

  const u1 = Math.random();
  const u2 = Math.random();
  // Math.max avoids ln(0) = -Infinity
  const z0 = Math.sqrt(-2.0 * Math.log(Math.max(u1, 1e-9))) * Math.cos(2.0 * Math.PI * u2);
  const sampled = Math.round(safeMean + z0 * safeStddev);
  return Math.min(Math.max(sampled, safeMin), safeMax);
}

/**
 * Samples a random integer uniformly distributed between min and max.
 */
export function sampleUniform(min: number, max: number): number {
  const safeMin = Math.max(0, Math.min(min, max));
  const safeMax = Math.min(30000, Math.max(safeMin, max));
  return Math.round(safeMin + Math.random() * (safeMax - safeMin));
}

/**
 * Calculates artificial delay in milliseconds based on the latency configuration.
 */
export function sampleLatency(config?: ChaosLatencyConfig | null): number {
  if (!config || !config.enabled) {
    return 0;
  }

  const minFloor = Math.max(0, config.minMs ?? 0);
  const maxCeiling = Math.min(30000, config.maxMs ?? 30000);

  switch (config.distribution) {
    case 'fixed':
      return Math.min(Math.max(Math.round(config.meanMs), minFloor), maxCeiling);
    case 'uniform': {
      // If an explicit user-defined maxMs (< 30000) is provided, use minFloor to maxMs.
      // Otherwise, center the uniform distribution on meanMs using stddevMs (halfWidth = sqrt(3) * stddev)
      // so selecting 'Uniform' in the dashboard respects the configured mean delay.
      let uMin: number;
      let uMax: number;
      if (config.maxMs !== undefined && config.maxMs < 30000 && config.maxMs > minFloor) {
        uMin = minFloor;
        uMax = config.maxMs;
      } else {
        const halfWidth =
          config.stddevMs > 0
            ? Math.round(Math.sqrt(3) * config.stddevMs)
            : Math.round(config.meanMs);
        uMin = Math.max(minFloor, config.meanMs - halfWidth);
        uMax = Math.min(maxCeiling, config.meanMs + halfWidth);
      }
      return sampleUniform(uMin, uMax);
    }
    case 'normal':
    default:
      return sampleNormal(config.meanMs, config.stddevMs, minFloor, maxCeiling);
  }
}

/**
 * Determines whether a request should have its socket severed (network partition).
 */
export function shouldDropSocket(config?: ChaosPartitionConfig | null): boolean {
  if (!config || !config.enabled || config.dropRate <= 0) {
    return false;
  }
  return Math.random() < Math.min(1.0, config.dropRate);
}

export interface ErrorInjectionResult {
  inject: boolean;
  statusCode?: number;
  is429?: boolean;
}

/**
 * Evaluates whether an error response (5xx or simulated 429) should be injected.
 */
export function shouldInjectError(config?: ChaosErrorConfig | null): ErrorInjectionResult {
  if (!config || !config.enabled) {
    return { inject: false };
  }

  // 1. Check 429 rate limit simulation
  if (config.rate429 > 0 && Math.random() < Math.min(1.0, config.rate429)) {
    return { inject: true, statusCode: 429, is429: true };
  }

  // 2. Check 5xx server error simulation
  if (config.rate5xx > 0 && Math.random() < Math.min(1.0, config.rate5xx)) {
    // Filter before choosing: rows written before the schema bounded this field
    // can still hold an out-of-range code, and `reply.code(0)` throws.
    const codes = (config.statusCodes ?? []).filter(
      (code) => Number.isInteger(code) && code >= 400 && code <= 599,
    );
    const pool = codes.length > 0 ? codes : [500, 502, 503, 504];
    const picked = pool[Math.floor(Math.random() * pool.length)] ?? 500;
    return { inject: true, statusCode: picked, is429: false };
  }

  return { inject: false };
}
