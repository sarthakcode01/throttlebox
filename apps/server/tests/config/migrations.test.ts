import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from '../../src/db/client.js';

const drizzleDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

describe('migrations', () => {
  it('every .sql migration is registered in the Drizzle journal (otherwise db:migrate silently skips it)', () => {
    const files = readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    const journal = JSON.parse(readFileSync(resolve(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    expect(journal.entries.map((e) => e.tag).sort()).toEqual(files);
  });

  it('journal indexes are contiguous and timestamps strictly increase', () => {
    const journal = JSON.parse(readFileSync(resolve(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number }[];
    };
    journal.entries.forEach((e, i) => expect(e.idx).toBe(i));
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
    }
  });
});

describe('applied database schema', () => {
  it('has every table the code depends on', async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    const names = rows.map((r) => r.table_name);
    for (const table of [
      'users',
      'sessions',
      'orgs',
      'org_members',
      'plans',
      'api_keys',
      'api_key_families',
      'api_key_events',
      'mock_services',
      'mock_routes',
      'request_logs',
      'org_webhooks',
      'chaos_rules',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('request_logs is a TimescaleDB hypertable', async () => {
    const rows = await sql<{ hypertable_name: string }[]>`
      SELECT hypertable_name FROM timescaledb_information.hypertables`;
    expect(rows.map((r) => r.hypertable_name)).toContain('request_logs');
  });

  it('usage_hourly continuous aggregate exists with its refresh and retention policies', async () => {
    const cagg = await sql<{ view_name: string }[]>`
      SELECT view_name FROM timescaledb_information.continuous_aggregates`;
    expect(cagg.map((r) => r.view_name)).toContain('usage_hourly');

    const jobs = await sql<{ proc_name: string; hypertable_name: string }[]>`
      SELECT proc_name, hypertable_name FROM timescaledb_information.jobs`;
    expect(
      jobs.some(
        (j) =>
          j.proc_name === 'policy_refresh_continuous_aggregate' &&
          j.hypertable_name === 'usage_hourly',
      ),
    ).toBe(true);
    expect(
      jobs.some((j) => j.proc_name === 'policy_retention' && j.hypertable_name === 'request_logs'),
    ).toBe(true);
  });

  it('chaos_rules enforces one rule per (org, service, key) scope', async () => {
    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'chaos_rules'`;
    expect(idx.map((i) => i.indexname)).toContain('chaos_rules_scope_idx');
  });
});
