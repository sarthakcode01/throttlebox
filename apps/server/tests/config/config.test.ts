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
    expect(config.TRUST_PROXY_CIDRS).toBeTypeOf('string');
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

  it('refuses a trusted-proxy entry that is not an IP or CIDR range', async () => {
    vi.stubEnv('TRUST_PROXY_CIDRS', 'not-an-address');
    await expect(loadConfig()).rejects.toThrow(/TRUST_PROXY_CIDRS/);
  });

  it('refuses a trusted-proxy range with an out-of-bounds prefix length', async () => {
    vi.stubEnv('TRUST_PROXY_CIDRS', '10.0.0.0/99');
    await expect(loadConfig()).rejects.toThrow(/TRUST_PROXY_CIDRS/);
  });
});
