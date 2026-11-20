# Security

## Implemented controls

| Area                 | Control                                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords            | Argon2id (`@node-rs/argon2`); min length 10                                                                                                                                                                                                                 |
| Sessions             | 256-bit random token; only SHA-256 hash stored in Postgres; Redis cache; httpOnly cookie; sliding expiry (default 7 d); background janitor                                                                                                                  |
| CSRF                 | Double-submit cookie + `X-CSRF-Token`, constant-time compare; skipped for requests with `Authorization` header                                                                                                                                              |
| Credential endpoints | Per-IP limiter (default 20 / 15 min)                                                                                                                                                                                                                        |
| Client IP            | `X-Forwarded-For` ignored unless `TRUST_PROXY_HOPS > 0` (the audit trail records IP)                                                                                                                                                                        |
| API keys             | HMAC-SHA-256 with env-only `KEY_PEPPER`; raw key shown once; indexed `public_id` lookup; `timingSafeEqual` with dummy HMAC on miss; rotation grace window; family kill switch; scopes (default least-privilege); log/error redaction; header-only transport |
| Boot checks          | Server refuses to start if `KEY_PEPPER == SESSION_SECRET` or secrets < 16 chars                                                                                                                                                                             |
| Uniform 401          | One response for every key failure mode (no oracle)                                                                                                                                                                                                         |
| Tenant isolation     | Mock services resolved by `(orgId from key, slug)`; cross-tenant tests exist                                                                                                                                                                                |
| Template engine      | No `eval`; closed faker allowlist; `__proto__/constructor/prototype` refused; own-properties only; per-request `Faker` instance; failures render `undefined`                                                                                                |
| Webhooks             | HMAC-SHA256 signatures; URL validation rejects non-http(s), https-only in production, localhost/.local/.internal, private/loopback/link-local/metadata ranges                                                                                               |
| Errors               | Central handler hides DB/internal messages outside development                                                                                                                                                                                              |
| Headers              | `securityHeaders.ts` adds baseline headers                                                                                                                                                                                                                  |
| Chaos                | Latency clamped to 0–30 000 ms; probabilities clamped to ≤ 1                                                                                                                                                                                                |

## Known open issues

See `SECURITY_AUDIT_2026_11_16.md` (status as of that audit; some may have since changed) and `PROJECT_MISTAKES_AND_TECHNICAL_DEBT_AUDIT.md`. Highlights:

- **Critical**: webhook SSRF guard is a string check (DNS rebinding, redirects, numeric/IPv6 forms); webhook HMAC secret returned in API responses.
- **High**: in-memory auth limiter (per process); session role/org cached up to 7 d; no session binding; cascade FK on hypertable; analytics still scans raw logs; webhook dispatch has no durable queue; no limiter on dashboard `/api/*` (chaos benchmark is a compute amplifier).
- **Medium**: key cache has no pub/sub (revoked key may stay live ≤ 60 s on other instances) and stores `secretHash` in Redis; `touch()` buffer lossy; open registration; weak password policy; no HSTS/CSP; CORS list unvalidated; blocking `KEYS` in chaos invalidation.

## Failure behaviour to be aware of

- Rate limiter **fails open** on Redis errors (availability over strictness).
- Telemetry queue **drops oldest 10%** when over 10 000 entries during DB outages.
- Unauthenticated (401) mock requests are logged to pino, not to `request_logs`.
