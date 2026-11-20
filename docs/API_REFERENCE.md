# API Reference

Base URL: `http://localhost:3001`. Dashboard endpoints live under `/api` and use **session cookie + CSRF**. The mock API and OpenAPI docs live outside `/api` and use **Bearer API keys**.

## Authentication modes

| Mode    | How                                                                                                                                                                             | Used by                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Session | httpOnly session cookie. Mutations (non-GET/HEAD/OPTIONS) also require `X-CSRF-Token` equal to the readable CSRF cookie. Requests carrying an `Authorization` header skip CSRF. | `/api/*`                          |
| API key | `Authorization: Bearer sk_{env}_{publicId}_{secret}` (header only)                                                                                                              | `/mock/*`, `/docs/*/openapi.json` |

Role permissions (`packages/shared`): `owner: *`; `admin: keys:*, members:invite, mock:*, chaos:*, org:*, analytics:*`; `dev: keys:create/read/rotate/revoke, mock:*, chaos:*, analytics:*`; `viewer: keys:read, mock:read, analytics:read`.

Key scopes: `mock:read`, `mock:write`, `chaos:write`, `keys:read` (empty = `mock:read`).

## Health

| Method | Path            | Description                                        |
| ------ | --------------- | -------------------------------------------------- |
| GET    | `/health`       | Liveness (no dependency checks)                    |
| GET    | `/health/ready` | Readiness: Postgres + Redis; 503 if either is down |

## Auth & session

| Method | Path                 | Description                                                                           |
| ------ | -------------------- | ------------------------------------------------------------------------------------- |
| POST   | `/api/auth/register` | `{email, password(≥10), name}` → creates user, personal org, session; IP-rate-limited |
| POST   | `/api/auth/login`    | Login; IP-rate-limited (default 20 / 15 min)                                          |
| POST   | `/api/auth/logout`   | Destroys session                                                                      |
| GET    | `/api/me`            | Current user, org, role                                                               |
| GET    | `/api/org/plan`      | Current org plan config                                                               |
| PATCH  | `/api/org/plan`      | Change plan (`free`/`pro`); invalidates caches and publishes `plan:changed`           |

## API keys (`/api`)

| Method | Path                   | Description                                                       |
| ------ | ---------------------- | ----------------------------------------------------------------- |
| POST   | `/keys`                | Create `{name, env: test                                          | live, scopes?}`; raw key returned once; supports `Idempotency-Key` (repeat → 409) |
| GET    | `/keys`                | List (masked: prefix + last4)                                     |
| GET    | `/keys/:id`            | Detail incl. audit events                                         |
| POST   | `/keys/:id/rotate`     | `{graceHours}`; new key returned once, old valid for grace window |
| POST   | `/keys/:id/revoke`     | Immediate revocation                                              |
| POST   | `/families/:id/revoke` | Kill switch: revoke the whole rotation chain                      |

## Mock services (`/api`)

| Method         | Path                        | Description                                                                            |
| -------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| GET / POST     | `/mock/services`            | List / create services                                                                 |
| PATCH / DELETE | `/mock/services/:id`        | Update / delete                                                                        |
| GET / POST     | `/mock/services/:id/routes` | List / create routes                                                                   |
| PATCH / DELETE | `/mock/routes/:id`          | Update / delete (duplicate path → 409)                                                 |
| POST           | `/mock/preview`             | `{serviceSlug, method, path, body?}` → renders as a caller would see it (session auth) |

## Public mock API

| Method                | Path                              | Scope                                            |
| --------------------- | --------------------------------- | ------------------------------------------------ |
| GET                   | `/mock/:serviceSlug/*`            | `mock:read`                                      |
| POST/PUT/PATCH/DELETE | `/mock/:serviceSlug/*`            | `mock:write`                                     |
| GET                   | `/docs/:serviceSlug/openapi.json` | session or API key — OpenAPI 3.1 for the service |

Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; on 429 `Retry-After`. When chaos fires: `X-Throttlebox-Chaos-Latency`, `X-Throttlebox-Chaos-Injected`.

Errors: `401 unauthorized` (uniform body), `403` missing scope, `404 service_not_found`/route not found, `429 rate_limited`, chaos bodies `chaos_fault_injected` / `simulated_rate_limit`.

## Analytics (`/api/analytics`, session)

| Method     | Path                 | Description                                         |
| ---------- | -------------------- | --------------------------------------------------- |
| GET        | `/overview`          | Totals (`range` query, default 24h)                 |
| GET        | `/usage`             | Volume series (uses `usage_hourly` for ≥24h ranges) |
| GET        | `/latency`           | p50/p95/p99 series                                  |
| GET        | `/errors`            | Error breakdown                                     |
| GET        | `/logs`              | Paginated recent request logs (`limit`, `offset`)   |
| GET / POST | `/webhooks`          | List / create quota webhooks (URL SSRF-validated)   |
| DELETE     | `/webhooks/:id`      | Delete                                              |
| POST       | `/webhooks/:id/test` | Send a signed test payload                          |

Webhook payloads are signed with HMAC-SHA256 using the webhook secret (`signPayload`).

## Chaos (`/api/chaos`, session)

| Method | Path               | Description                                                                 |
| ------ | ------------------ | --------------------------------------------------------------------------- |
| GET    | `/chaos`           | Rules for the org (org-wide / per service / per key)                        |
| PUT    | `/chaos`           | Upsert a rule `{serviceId?, keyId?, isEnabled, latency, errors, partition}` |
| POST   | `/chaos/reset`     | Reset rules                                                                 |
| POST   | `/chaos/benchmark` | Run an in-server benchmark of sampling to draw the resilience histogram     |
| DELETE | `/chaos`           | Delete a rule                                                               |

Rule shape (shared types): `latency {enabled, distribution: fixed|normal|uniform, meanMs, stddevMs, minMs, maxMs}`, `errors {enabled, rate5xx, rate429, statusCodes[], customMessage?}`, `partition {enabled, dropRate}`.

## Time-Travel Playground (`/api/playground`, session)

Permissions: `playground:read` (list, history, export) and `playground:run` (create/rename/delete sessions, send, replay). Viewers have read only. Everything is scoped to the caller's organization; another org's ids return 404.

| Method         | Path                                    | Description                                                                                                                                                                                    |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET / POST     | `/playground/sessions`                  | List (with request counts) / create `{name?}`                                                                                                                                                  |
| PATCH / DELETE | `/playground/sessions/:id`              | Rename `{name}` / delete (cascades to its requests)                                                                                                                                            |
| GET            | `/playground/sessions/:id/requests`     | History, newest first. `limit` (≤200), `before` (ISO cursor)                                                                                                                                   |
| GET            | `/playground/requests/:id`              | One captured request and response                                                                                                                                                              |
| POST           | `/playground/sessions/:id/send`         | `{keyId, method, serviceSlug, path, query?, headers?, body?, parentId?}`. Runs through the real pipeline. `parentId` records a **fork**. Returns 201 with the capture                          |
| POST           | `/playground/requests/:id/replay`       | Re-run verbatim `{keyId?}` (override the key). Records a **replay** linked to the original                                                                                                    |
| GET            | `/playground/sessions/:id/export`       | `format=vitest` (default) or `postman`, `ids=a,b` to pick requests, `includeFaults=true`. Sent as an attachment. Without `ids`, repeated runs of the same request collapse to the latest one |

Rules enforced on `send`: the path must start with `/` and may not contain `?`, `#`, backslashes, control characters or `.`/`..` segments; the target is always `/mock/<serviceSlug>/<path>` on this server; the key must belong to the caller's org and keeps its real scopes; at most 500 requests per session (409 `limit_reached`); response bodies over 64 KB are truncated and flagged. `Authorization`, `Cookie`, `X-CSRF-Token`, forwarding headers and `X-Throttlebox-*` request headers are dropped, and `Set-Cookie` is dropped from stored responses. Raw API keys are redacted from stored bodies and header values.

A capture has `outcome`: `ok`, `dropped` (chaos severed the connection, no status) or `error` (35 s timeout).

> Exact request/response bodies are typed in `packages/shared/src/index.ts`; route handlers are in `apps/server/src/routes/`.
