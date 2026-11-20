import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig() {
  vi.resetModules();
  return import('../../src/config.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('environment validation', () => {
  it('loads with the current (valid) environment', async () => {
    const { config } = await loadConfig();
    expect(config.PORT).toBeGreaterThan(0);
    expect(config.TRUST_PROXY_HOPS).toBeGreaterThanOrEqual(0);
    expect(config.SESSION_TTL_SECONDS).toBeGreaterThan(0);
  });

  it('refuses to boot when KEY_PEPPER equals SESSION_SECRET', async () => {
    vi.stubEnv('SESSION_SECRET', 'the-same-secret-value-1234');
    vi.stubEnv('KEY_PEPPER', 'the-same-secret-value-1234');
    await expect(loadConfig()).rejects.toThrow(/KEY_PEPPER must differ from SESSION_SECRET/);
  });

  it('refuses a too-short pepper', async () => {
    vi.stubEnv('KEY_PEPPER', 'short');
    await expect(loadConfig()).rejects.toThrow(/KEY_PEPPER/);
  });

  it('refuses a malformed DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', 'not a url');
    await expect(loadConfig()).rejects.toThrow(/DATABASE_URL/);
  });

  it('refuses an out-of-range TRUST_PROXY_HOPS', async () => {
    vi.stubEnv('TRUST_PROXY_HOPS', '99');
    await expect(loadConfig()).rejects.toThrow(/TRUST_PROXY_HOPS/);
  });
});
