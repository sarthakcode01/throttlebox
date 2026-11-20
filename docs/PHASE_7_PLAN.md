# Phase 7 — Time-Travel Playground: Implementation Plan

## Context

Phases 0–6 are complete and covered by 323 passing tests. Phase 7 is the second "differentiator" in `API_DEVELOPER_PORTAL_PLAN.md` (lines 414–443): an in-dashboard request runner that **captures** every request/response, lets the user **replay** or **fork** past requests, **diff** two runs, and **export** them as a runnable Vitest file (plus a Postman collection).

Exit criterion (from the plan): *send a request → change chaos → replay → see the diff → export a Vitest file that passes locally.*

The design rule that makes it valuable: **a playground request goes through the exact same pipeline as an external call** — key auth → scope → rate limit → chaos → handler → telemetry. Mock responses are deterministic (seeded by org + service + path), so any difference between two runs is caused by something the user changed (chaos, a template edit, a plan change), which is what the diff makes visible.

## Decisions (defaults chosen; easy to change)

| Decision | Choice | Why |
|---|---|---|
| How the runner executes | `fastify.inject()` in-process, authenticated by a **per-boot internal token** + a chosen `keyId` | Real pipeline (limits, chaos, telemetry) with no network hop, no SSRF surface, and no need for the raw key (which is never stored). |
| Which credential is used | User picks one of the org's **active API keys** in the UI; its real scopes apply | Realistic: a read-only key really gets 403 on POST. |
| URL freedom | Only `/mock/<serviceSlug>/<path>` on this server | No free-form URLs → no SSRF. |
| Editor | Plain `<textarea>` with JSON validate/format | Monaco is ~2 MB and awkward with Next SSR; can be swapped in later without API changes. |
| Diff | Own small pure function in `@throttlebox/shared` | Zero deps, unit-testable, used by the web app. |
| Export | Vitest + Postman v2.1. OpenAPI reuses the existing `/docs/:slug/openapi.json` | Avoids duplicating `buildOpenApiDocument`. |
| Storage limits | 500 requests per session, bodies capped at 64 KB (with a `truncated` flag), 30-day retention | Bounded growth. |
| Permissions | New `playground:*`: owner/admin/dev get full access, viewer gets `playground:read` | Matches existing RBAC style. |

## Step 7.0 — Shared groundwork (`packages/shared/src/index.ts`)

- Types: `PlaygroundSession`, `PlaygroundRequest`, `PlaygroundSendRequest`, `PlaygroundExportFormat`, `JsonDiffEntry`.
- `PERMISSIONS`: add `playground:*` to admin and dev, and `playground:read` to viewer.
- `diffJson(a, b): JsonDiffEntry[]`, a recursive deep diff returning `{ path, kind: 'added'|'removed'|'changed', before?, after? }`. Arrays are compared by index.
- `diffRuns(a, b)`: compares status, latency, filtered headers and body. Volatile headers (`date`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `content-length`, `connection`) are ignored by default.
- Tests: `packages/shared/tests/diff.test.ts` (nested objects, arrays, type changes, null vs missing, identical inputs).

## Step 7.1 — Capture schema (`apps/server/src/db/schema.ts`, migration `0007`)

```
playground_sessions  id, org_id → orgs (cascade), created_by → users (set null),
                     name, created_at, updated_at        idx (org_id, created_at desc)

playground_requests  id, session_id → sessions (cascade), org_id (denormalised, for scoping),
                     key_id → api_keys (set null), parent_id → self (set null),
                     kind enum('send','replay','fork'),
                     method, service_slug, path, query jsonb, headers jsonb, body text,
                     outcome enum('ok','dropped','error'),
                     response_status int null, response_headers jsonb, response_body text,
                     response_truncated bool, duration_ms int, created_at
                     idx (session_id, created_at desc), idx (org_id)
```
- A normal table, not a hypertable, because it needs FKs, it's small, and it's queried per session.
- **Migration caution:** `drizzle/meta` has no snapshots for 0005 and 0006, so `drizzle-kit generate` will try to re-emit `chaos_rules`. Run `pnpm db:generate`, delete any `chaos_rules` and Timescale statements from the generated SQL, and keep the new snapshot, which closes the snapshot gap. Confirm the journal entry. `tests/config/migrations.test.ts` already enforces this, and its table list gets the two new tables.
- Storage redaction: never store `authorization`, `cookie`, `x-csrf-token` or the internal header. Run `redact()` (`apps/server/src/keys/redact.ts`) over stored bodies and header values.

## Step 7.2 — Runner and endpoints

**Internal auth for injected requests** (`apps/server/src/keys/middleware.ts`, `apps/server/src/keys/verify.ts`):
- New module `apps/server/src/playground/internalAuth.ts` holds `INTERNAL_TOKEN = randomBytes(32)` per process. It's never logged or returned.
- `requireKeyAuth` gets one extra path: if `x-throttlebox-internal` matches in constant time (`safeEqualString`, `apps/server/src/util/crypto.ts`) and `x-throttlebox-key-id` is present, call a new `loadKeyContextById(keyId)` in `verify.ts`. It reuses the same fail-closed checks (family not revoked, active, not expired, grace window) without the HMAC step, and returns the same `AuthKeyContext`. Any mismatch falls through to the normal bearer path, so external callers see no change.

**Runner** (`apps/server/src/playground/runner.ts`):
- `runPlaygroundRequest(fastify, { orgId, keyId, method, serviceSlug, path, query, headers, body })`:
  - Validates that the key belongs to `orgId`, then builds `/mock/${slug}${path}?${query}`.
  - Calls `fastify.inject()` with the internal headers and user headers taken from an allowlist (drops hop-by-hop, auth, cookie and `x-throttlebox-*`).
  - Measures duration and captures status, headers and body (truncated to 64 KB).
  - Wraps the call in a 35 s timeout, which is the 30 s chaos latency cap plus margin.
  - A destroyed socket from chaos partition, or the timeout, gives `outcome: 'dropped'`.
- **Spike first:** confirm how `inject()` behaves when the chaos middleware calls `reply.hijack()` + `request.raw.destroy()` (does it reject or hang?). The timeout covers either case, and a test pins the behaviour.
- The real `onResponse` telemetry hook (`routes/mock.ts`) fires as normal, so playground traffic shows up in analytics and counts against the plan quota. That's intended.

**Store** (`apps/server/src/playground/store.ts`): session CRUD, `recordRequest`, `listRequests(sessionId, { limit, before })` with cursor pagination, `getRequest`, a per-session cap check, and `purgeOldPlaygroundData(30d)`.

**Routes** (`apps/server/src/routes/playground.ts`, registered under `/api` in `src/index.ts`). They follow the pattern in `routes/chaos.ts`: a `requireAuth` preHandler plus `requirePermission`, zod bodies, 400/403/404 shapes.

| Method | Path | Permission |
|---|---|---|
| GET / POST | `/playground/sessions` | read / run |
| PATCH / DELETE | `/playground/sessions/:id` | run |
| GET | `/playground/sessions/:id/requests?limit&before` | read |
| GET | `/playground/requests/:id` | read |
| POST | `/playground/sessions/:id/send` `{keyId, method, serviceSlug, path, query?, headers?, body?, parentId?}` | run |
| POST | `/playground/requests/:id/replay` `{keyId?}` | run |
| GET | `/playground/sessions/:id/export?format=vitest\|postman&ids=` | read |

Every query is scoped by `org_id` from the session. Ids from another org return 404. `send` with `parentId` records `kind='fork'`.

**Retention:** add `purgeOldPlaygroundData` to a janitor loop. Mirror `apps/server/src/auth/janitor.ts`, then start and stop it in `main()` in `src/index.ts`.

## Step 7.3 — History, replay and fork

- Replay re-runs the stored method, path, query, headers and body verbatim, using the same key by default or an override. It stores a new row with `parent_id = original` and `kind='replay'`.
- Fork is client-side: the stored request pre-fills the builder, and sending it passes `parentId`.
- The timeline shows newest first, with status, duration and badges. The badges come from the stored response headers: chaos injected (`x-throttlebox-chaos-injected`), chaos latency, rate-limited (429) and dropped.

## Step 7.4 — Response diff

- The user selects any two runs, usually a replay and its parent (a "Compare with original" shortcut covers that case).
- The web app calls `diffRuns()` from shared and renders two columns. Added, removed and changed paths are highlighted, along with status, latency and header deltas, and the "noise" headers can be hidden.

## Step 7.5 — Export

`apps/server/src/playground/export/` holds pure functions:
- **`toVitest(requests, { baseUrl })`**: a self-contained `.test.ts` that only imports `vitest`.
  - It reads `THROTTLEBOX_API_KEY` and `THROTTLEBOX_BASE_URL` from env.
  - It generates one `it()` per request, calling `fetch` and asserting the status.
  - It adds a structural schema assertion inferred from the captured body (`inferShape()`: a type per field, recursing into objects and the first array element).
  - It adds `toEqual` on the captured body. That's safe because mock data is deterministic.
  - Requests whose captured outcome was a chaos fault are exported with a comment and `it.skip`, or with the observed status if the user opts in.
- **`toPostman(requests, session)`**: a Postman Collection v2.1 JSON with `{{baseUrl}}` and `{{apiKey}}` variables.
- The route sets `Content-Disposition: attachment; filename=...`.

## Step 7.6 — Web UI (`apps/web`)

- `src/lib/api.ts` gets `listPlaygroundSessions`, `createPlaygroundSession`, `sendPlaygroundRequest`, `replayPlaygroundRequest`, `listPlaygroundRequests`, `getPlaygroundRequest` and `exportPlaygroundSession`. They follow the existing `request<T>()` helper, which already handles CSRF.
- `src/app/dashboard/playground/page.tsx` has three panes and uses TanStack Query like `dashboard/chaos/page.tsx`:
  1. **Sessions and timeline:** create or rename sessions, run history, Replay, Fork, and compare checkboxes.
  2. **Request builder:** key select from `api.listKeys()` (active only), service select from `api.listServices()`, method, path, query and headers key/value rows, and a body textarea with format and validate.
  3. **Response viewer:** status, duration, badges, headers, pretty body.
- Small components in `src/components/playground/`: `RequestBuilder`, `ResponseViewer`, `Timeline`, `DiffView`.
- `src/app/dashboard/layout.tsx` gets a nav item "Time-Travel Playground" at `/dashboard/playground`. `typedRoutes` is on, so the route must exist.
- A link from the Chaos Studio page to "try it in the playground" makes the send → chaos → replay loop obvious.

## Step 7.7 — Docs

Update `docs/API_REFERENCE.md`, `docs/DATABASE.md`, `docs/FEATURES.md` and `docs/ROADMAP.md`, and tick P7 in `PHASES.md`.

## Suggested commit sequence

Each commit should be green on `pnpm typecheck && pnpm lint && pnpm test`.
1. Shared types, permissions and `diffJson`/`diffRuns`, with tests.
2. Schema and migration 0007 (with the snapshot fix) and the store, with tests.
3. Internal auth, `loadKeyContextById` and the runner, plus the inject/partition spike test.
4. Routes: sessions, send, replay and timeline, with tests.
5. Export generators and route, with tests (including running the generated file).
6. Web playground page, nav and diff view.
7. Janitor and docs.

## Tests to add (server, real Postgres + Redis, reusing `tests/helpers/app.ts`)

- `tests/playground/runner.test.ts`:
  - The internal token is rejected when wrong or missing, and an external caller can't use `x-throttlebox-key-id`.
  - A revoked or expired key, or a key from another org, fails closed.
  - Scopes are enforced (a read-only key POSTing gets 403).
  - The rate limit applies (the 101st playground send on free gives 429), and telemetry rows are written.
  - The chaos partition gives `outcome: 'dropped'` without hanging.
  - Injected latency is reflected in the duration.
- `tests/playground/routes.test.ts`:
  - Session CRUD, cross-tenant 404s, and viewer read-only (send gives 403).
  - Stored headers contain no `authorization`, cookie or internal token, and body truncation sets the flag.
  - The cap is enforced, replay links `parent_id`, and fork sets `kind`.
- `tests/playground/export.test.ts`:
  - `inferShape` and Postman structure checks.
  - **The exit criterion as an automated test:** send, enable chaos, replay, and assert the stored responses differ via `diffRuns`. Then export Vitest for the clean run, write it to a temp dir, and spawn `vitest run` on it with `THROTTLEBOX_BASE_URL` pointing at a listening test server and a real key. It must pass.
- `tests/config/migrations.test.ts`: add the two tables to the expected list.
- `packages/shared/tests/diff.test.ts`, plus permission matrix rows for `playground:*`.

## Verification

1. `docker compose up -d && pnpm db:migrate`. Confirm the `playground_*` tables exist and `chaos_rules` wasn't recreated.
2. `pnpm typecheck && pnpm lint && pnpm test`. Everything is green, including the export-runs-and-passes test.
3. Manual run (`pnpm dev`):
   - Register, create a key, open `/dashboard/playground`, and send `GET /mock/ecommerce/products/42`.
   - Turn on 100% 503 in Chaos Studio and replay. The timeline shows a chaos badge and the diff shows the status and body change.
   - Export Vitest, then run it with `THROTTLEBOX_API_KEY=... THROTTLEBOX_BASE_URL=http://localhost:3001 npx vitest run <file>` and confirm it passes.
4. `/dashboard/analytics` shows the playground traffic.

## Out of scope (later phases)

- Monaco editor.
- Playwright E2E for the page (Phase 8).
- Sharing sessions publicly.
- Arbitrary external URLs.
