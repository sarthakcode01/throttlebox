import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <h1>Throttlebox</h1>
      <p className="lede">
        Mock APIs for developers. Generate a key, call realistic endpoints, and watch your usage in
        real time — with rate limits you can actually test against.
      </p>

      <div className="row">
        <Link href="/login">
          <button>Get started</button>
        </Link>
      </div>

      <h2>What&apos;s inside</h2>
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          <strong>API keys</strong> — generated once, stored as peppered HMAC hashes, revocable and
          rotatable without downtime.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          <strong>Sliding-window rate limiting</strong> — atomic Redis Lua, with{' '}
          <code>X-RateLimit-*</code> headers on every response.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          <strong>Usage analytics</strong> — p50/p95/p99 latency from TimescaleDB continuous
          aggregates.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          <strong>Chaos controls</strong> — inject latency, errors, and dropped connections to prove
          your client is resilient.
        </p>
      </div>
    </main>
  );
}
