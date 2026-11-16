import { describe, expect, it } from 'vitest';
import {
  sampleLatency,
  sampleNormal,
  sampleUniform,
  shouldDropSocket,
  shouldInjectError,
} from '../../src/chaos/sampling.js';

describe('Chaos Sampling & Mathematical Distributions', () => {
  describe('sampleNormal (Box-Muller transformation)', () => {
    it('returns values bounded within min and max', () => {
      for (let i = 0; i < 500; i++) {
        const val = sampleNormal(200, 50, 50, 400);
        expect(val).toBeGreaterThanOrEqual(50);
        expect(val).toBeLessThanOrEqual(400);
      }
    });

    it('approximates the expected mean over a large sample', () => {
      const targetMean = 250;
      const targetStddev = 40;
      let sum = 0;
      const count = 2000;

      for (let i = 0; i < count; i++) {
        sum += sampleNormal(targetMean, targetStddev, 0, 1000);
      }

      const observedMean = sum / count;
      // Should be within +/- 5% of target mean
      expect(Math.abs(observedMean - targetMean)).toBeLessThan(15);
    });

    it('returns exact mean when stddev is 0', () => {
      const val = sampleNormal(150, 0, 0, 500);
      expect(val).toBe(150);
    });

    it('safely handles inverted min/max bounds without nan', () => {
      const val = sampleNormal(200, 50, 500, 100);
      expect(val).toBeGreaterThanOrEqual(100);
      expect(val).toBeLessThanOrEqual(500);
      expect(Number.isNaN(val)).toBe(false);
    });
  });

  describe('sampleUniform', () => {
    it('returns values strictly between min and max', () => {
      for (let i = 0; i < 200; i++) {
        const val = sampleUniform(100, 300);
        expect(val).toBeGreaterThanOrEqual(100);
        expect(val).toBeLessThanOrEqual(300);
      }
    });

    it('safely handles inverted min/max parameters', () => {
      const val = sampleUniform(300, 100);
      expect(val).toBeGreaterThanOrEqual(100);
      expect(val).toBeLessThanOrEqual(300);
      expect(Number.isNaN(val)).toBe(false);
    });
  });

  describe('sampleLatency with configuration', () => {
    it('returns 0 when latency is disabled or config is null', () => {
      expect(sampleLatency(null)).toBe(0);
      expect(sampleLatency({ enabled: false, distribution: 'normal', meanMs: 200, stddevMs: 50 })).toBe(0);
    });

    it('samples fixed latency correctly', () => {
      const delay = sampleLatency({
        enabled: true,
        distribution: 'fixed',
        meanMs: 120,
        stddevMs: 0,
      });
      expect(delay).toBe(120);
    });

    it('samples normal latency correctly', () => {
      const delay = sampleLatency({
        enabled: true,
        distribution: 'normal',
        meanMs: 200,
        stddevMs: 30,
        minMs: 50,
        maxMs: 500,
      });
      expect(delay).toBeGreaterThanOrEqual(50);
      expect(delay).toBeLessThanOrEqual(500);
    });

    it('samples uniform latency and clamps to safe ceiling', () => {
      const delay = sampleLatency({
        enabled: true,
        distribution: 'uniform',
        meanMs: 20000,
        stddevMs: 0,
      });
      expect(delay).toBeLessThanOrEqual(30000);
      expect(delay).toBeGreaterThanOrEqual(0);
    });

    it('centers uniform latency around meanMs even when maxMs is default 30000', () => {
      let sum = 0;
      const count = 1000;
      for (let i = 0; i < count; i++) {
        const delay = sampleLatency({
          enabled: true,
          distribution: 'uniform',
          meanMs: 200,
          stddevMs: 50,
          maxMs: 30000,
        });
        expect(delay).toBeGreaterThanOrEqual(100);
        expect(delay).toBeLessThanOrEqual(300);
        sum += delay;
      }
      const avg = sum / count;
      expect(Math.abs(avg - 200)).toBeLessThan(15);
    });
  });

  describe('shouldDropSocket (Network Partition)', () => {
    it('returns false when disabled or dropRate is 0', () => {
      expect(shouldDropSocket(null)).toBe(false);
      expect(shouldDropSocket({ enabled: false, dropRate: 1.0 })).toBe(false);
      expect(shouldDropSocket({ enabled: true, dropRate: 0.0 })).toBe(false);
    });

    it('returns true when dropRate is 1.0 (100% drops)', () => {
      expect(shouldDropSocket({ enabled: true, dropRate: 1.0 })).toBe(true);
    });

    it('statistically respects fractional drop rate', () => {
      const rate = 0.2; // 20%
      let droppedCount = 0;
      const trials = 1000;

      for (let i = 0; i < trials; i++) {
        if (shouldDropSocket({ enabled: true, dropRate: rate })) {
          droppedCount++;
        }
      }

      const observedRate = droppedCount / trials;
      // Expect observed rate to be roughly around 0.20 (+/- 0.05)
      expect(Math.abs(observedRate - rate)).toBeLessThan(0.05);
    });
  });

  describe('shouldInjectError', () => {
    it('returns inject: false when disabled or rates are 0', () => {
      expect(shouldInjectError(null)).toEqual({ inject: false });
      expect(
        shouldInjectError({
          enabled: false,
          rate5xx: 1.0,
          rate429: 1.0,
          statusCodes: [500],
        }),
      ).toEqual({ inject: false });
      expect(
        shouldInjectError({
          enabled: true,
          rate5xx: 0.0,
          rate429: 0.0,
          statusCodes: [500],
        }),
      ).toEqual({ inject: false });
    });

    it('injects simulated 429 when rate429 is 1.0', () => {
      const decision = shouldInjectError({
        enabled: true,
        rate5xx: 0.0,
        rate429: 1.0,
        statusCodes: [500],
      });

      expect(decision.inject).toBe(true);
      expect(decision.statusCode).toBe(429);
      expect(decision.is429).toBe(true);
    });

    it('injects 5xx error when rate5xx is 1.0', () => {
      const decision = shouldInjectError({
        enabled: true,
        rate5xx: 1.0,
        rate429: 0.0,
        statusCodes: [503],
      });

      expect(decision.inject).toBe(true);
      expect(decision.statusCode).toBe(503);
      expect(decision.is429).toBe(false);
    });
  });
});
