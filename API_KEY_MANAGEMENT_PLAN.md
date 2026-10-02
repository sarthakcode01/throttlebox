# Phase 2 — API Key Management (Detailed Plan)

Covers key generation, secure storage, verification, rotation, revocation, scopes,
and the audit trail.

**Explicitly out of scope for this phase:** Redis caching and rate limiting. The lookup
path here is a direct indexed Postgres query. Phase 4 replaces the hot path with a
Redis-cached prefix lookup and inserts a sliding-window limiter; the schema and module
boundaries below are designed so that swap is a change of _one function_, not a rewrite.

---

## Key design decision: don't use Argon2id for API keys

The original plan says "Argon2id of full key." I'd push back, because the threat model
is different from passwords:

|                    | Password (login)              | API key                              |
| ------------------ | ----------------------------- | ------------------------------------ |
| Entropy            | Low (human-chosen)            | ~192 bits (CSPRNG)                   |
| Attacker goal      | Brute force / dictionary      | Nothing — can't brute force 192 bits |
| Need for slow hash | **Yes**, it's the whole point | **No** — pure latency cost           |
| Cost per call      | ~50–100ms, once per login     | ~50–100ms **on every API request**   |

Argon2id's job is to make each guess expensive. With 192 bits of entropy there are no
guesses to make, so the work factor buys nothing and costs you 50–100ms on the hot path —
which directly contradicts the **<5ms p95 overhead** target in Phase 4 Step 4.6.

**What we use instead: HMAC-SHA-256 with a server-side pepper.**

```
stored = HMAC-SHA-256(key = PEPPER, message = publicId + ":" + secret)
```

- **Fast** — microseconds, so verification is free on the hot path.
- **Peppered** — `PEPPER` lives in an env var, never in the database. A stolen database
  dump (SQL injection, backup leak, a curious admin) produces hashes an attacker
  _cannot verify anything against_, because they lack the pepper. This is strictly
  stronger than a bare SHA-256 of the key.
- **Still one-way** — SHA-256 is preimage-resistant; the 192-bit secret can't be recovered.

OWASP's guidance is explicit on this: use a slow KDF for low-entropy secrets, a fast
hash (or HMAC) for high-entropy tokens. Our keys are the second case.

> **This supersedes Step 2.2 of `API_DEVELOPER_PORTAL_PLAN.md`.** Argon2id stays in the
> codebase for passwords, where it belongs.

---

## 1. Key format

```
sk_live_9Kd2mQxR7tYb4nW8pL3sA_zF1cH6jV0gN5eU
│  │    │                │                │
│  │    │                │                └─ 32 chars, 192 bits CSPRNG (the secret)
│  │    │                └────────────────── 12 chars, base62, ~2^71 (the public id)
│  │    └─────────────────────────────────── env: live | test
│  └──────────────────────────────────────── key type marker
└─────────────────────────────────────────── schema version
```

- **Parsing is unambiguous** — split on `_`, fixed arity. Never parse by "take the first N
  characters", which breaks the moment the env segment length changes.
- **`publicId` is 12 base62 chars** ≈ 3.2 × 10²¹ ≈ 2⁷¹ possibilities. Indexed lookup
  makes it non-enumerable by construction, and it gives a natural cache key for Phase 4.
- **The secret is the only secret.** The public id is a lookup handle, not a credential.

### Why a `publicId` at all

Argon2id has no index — you must verify against every row. Any hashed scheme needs
_some_ indexable field. Options considered:

| Approach                          | Lookup                                                | Verdict                                                                                            |
| --------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Hash the whole key, scan all rows | O(n) verify per row                                   | Unusable past a few hundred keys                                                                   |
| Index a short prefix              | O(log n), but prefix entropy is the security boundary | Works, but a 4-char suffix is only ~14.7M values — enumerable, and collides in bulk                |
| **Explicit `publicId` field**     | O(log n) via unique index                             | **Chosen** — entropy and lookup are decoupled; a short displayed prefix no longer weakens security |

---

## 2. Schema

Three tables. `families` exists so rotation doesn't need a migration later.

```sql
-- A rotation group. Revoking a family kills every key in it (kill switch).
CREATE TABLE api_key_families (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  label       text NOT NULL,              -- "staging-backend" (stable across rotations)
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  family_id     uuid NOT NULL REFERENCES api_key_families(id) ON DELETE CASCADE,

  name          text NOT NULL,            -- user-facing, mutable
  public_id     text NOT NULL UNIQUE,     -- lookup handle (indexed)
  prefix        text NOT NULL,            -- display: "sk_live_9Kd2mQxR7tYb"
  secret_hash   text NOT NULL,            -- HMAC-SHA-256(pepper, publicId:secret)
  last4         text NOT NULL,            -- display only

  env           text NOT NULL DEFAULT 'test',   -- test | live
  scopes        text[] NOT NULL DEFAULT '{}',    -- mock:read, mock:write, chaos:write
  status        text NOT NULL DEFAULT 'active',  -- active | revoked

  expires_at    timestamptz,              -- null = never
  grace_until   timestamptz,              -- set on rotation; old key valid until here
  rotated_from  uuid REFERENCES api_keys(id),

  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_by    uuid REFERENCES users(id)
);

CREATE INDEX api_keys_public_id_idx  ON api_keys (public_id);
CREATE INDEX api_keys_org_idx        ON api_keys (org_id, created_at DESC);
CREATE INDEX api_keys_family_idx     ON api_keys (family_id);
CREATE UNIQUE INDEX api_keys_public_id_uniq ON api_keys (public_id);  -- the lookup index

-- Security audit trail. Append-only.
CREATE TABLE api_key_events (
  id            bigserial PRIMARY KEY,
  key_id        uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  family_id     uuid,
  org_id        uuid NOT NULL,
  actor_user_id uuid,                     -- null = the key itself authenticating
  event         text NOT NULL,            -- created|rotated|revoked|auth_failed|expired
  ip            inet,
  user_agent    text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_key_events_org_idx ON api_key_events (org_id, created_at DESC);
CREATE INDEX api_key_events_key_idx ON api_key_events (key_id, created_at DESC);
```

### What is deliberately _not_ stored

- ❌ The raw key — never persisted, never logged, returned exactly once at creation
- ❌ The secret in any recoverable form
- ❌ The pepper — env var only, never in the database
- ✅ Only `prefix`, `last4`, and a non-reversible `secret_hash`

A database dump contains no credential that can be used against the API.

---

## 3. Module layout

```
apps/server/src/keys/
  format.ts       parse / build key strings, base62 encode-decode
  generate.ts     generateKeyPair() → { key, publicId, secretHash, prefix, last4 }
  store.ts        create, list, get, rotate, revoke  (all DB access)
  verify.ts       verifyKey(rawKey) → AuthKeyContext | null   ← Phase 4 swaps this
  touch.ts        last_used_at write-behind buffer
  middleware.ts   requireKeyAuth(), requireScope()
  redact.ts       scrub keys from logs and error payloads
  audit.ts        recordEvent()
```

The Phase 4 seam is a single function:

```ts
// verify.ts — today
export async function verifyKey(raw: string): Promise<AuthKeyContext | null>;

// Phase 4 — becomes
export async function verifyKey(raw: string): Promise<AuthKeyContext | null> {
  // 1. parse → publicId
  // 2. Redis GET keycache:{publicId}   (60s TTL)
  // 3. on miss → this same Postgres path, then SETEX
  // 4. limiter.consume(keyId) → 429 if over
}
```

Nothing above this function changes.

---

## 4. Generation

```ts
const SECRET_BYTES = 24; // 24 bytes = 192 bits → 32 base62 chars

export function generateKeyPair(): { key: string; publicId: string; secret: string } {
  const publicId = base62(crypto.randomBytes(12)); // ~2^71, indexed
  const secret = base62(crypto.randomBytes(24)); // 192 bits
  return {
    publicId,
    secret,
    key: `sk_${env}_${publicId}_${secret}`,
  };
}

export async function hashSecret(publicId: string, secret: string): Promise<string> {
  return createHmac('sha256', config.KEY_PEPPER).update(`${publicId}:${secret}`).digest('hex');
}
```

Rules:

- **`crypto.randomBytes` only** — never `Math.random()`, never a UUID as a secret
  (UUIDv4 has 122 bits and non-uniform nibble distribution).
- **The raw key is returned exactly once**, in the creation response. It is not
  retrievable afterwards by any endpoint, including for the user.
- **`timingSafeEqual` for all comparisons.** Length-check first, since
  `timingSafeEqual` throws on a length mismatch.

### Constant-time verification

```ts
const expected = Buffer.from(storedHash, 'hex');
const actual = Buffer.from(computeHash(publicId, secret), 'hex');
if (expected.length !== actual.length) return null;
return timingSafeEqual(expected, actual) ? context : null;
```

---

## 5. Verification path (the hot path)

Ordered, and every step fails closed:

```
Authorization: Bearer sk_live_9Kd2...zF1c
   │
   ├─ 1. parse & validate shape ──────────── malformed → 401
   ├─ 2. SELECT by public_id (unique idx) ── no row   → 401 (+ dummy HMAC, see below)
   ├─ 3. status === 'active'? ────────────── no       → 401
   ├─ 4. now < expires_at? ───────────────── no       → 401
   ├─ 5. now < grace_until (if set)? ─────── no       → 401
   ├─ 6. HMAC match (timingSafeEqual) ────── no       → 401
   ├─ 7. scope covers the route? ─────────── no       → 403
   │
   └─ attach { keyId, orgId, familyId, env, scopes } → handler
        └→ fire-and-forget last_used_at
```

**Flattening the timing profile.** Step 2 distinguishes "unknown key" from "wrong
secret". An attacker could time that to enumerate valid `publicId`s. Two mitigations:

- The public id has 2⁷¹ possibilities, so enumeration is already infeasible.
- On a miss, run a dummy HMAC against a fixed dummy value before returning, so steps
  2–6 take the same wall-clock time either way. (Same pattern as `DUMMY_HASH` in
  `routes/auth.ts` — keep them consistent.)

**All failures return an identical 401 body.** Distinguishing "revoked" from "expired"
from "wrong" is a free oracle; the real reason goes in the audit log, not the response.

---

## 6. `last_used_at` without Redis

Direct `UPDATE` per request would mean a Postgres write on every API call — unacceptable
at any real volume, and it would show up in the p95 immediately.

**This phase: in-process write-behind buffer.**

```
request ──→ handler ──→ respond          (never blocks)
                └─→ touch(keyId) ──→ in-memory Set
                                        └─ flush every 5s or 512 ids, batched:
                                           UPDATE api_keys SET last_used_at = now()
                                           WHERE id = ANY($1)
```

- **Acknowledged limitation:** buffered writes are lost if the process dies, and each
  instance has its own buffer. Acceptable now; Phase 4 replaces this with a Redis
  write-behind queue that is shared and durable.
- Coalesce per key — 200 requests to one key in 5s produce **one** row in the batch.
- `touch()` must never `await` or throw into the request path.
- On shutdown, flush the buffer (see Step 11).

---

## 7. Rotation

Rotation replaces a key while keeping the old one valid for a grace period, so a
deployment can swap keys without downtime.

```
POST /api/keys/:id/rotate
  │
  ├─ 1. generate a NEW key in the SAME family
  ├─ 2. set old key: grace_until = now() + 24h  (status stays 'active')
  ├─ 3. new key: rotated_from = old.id
  └─ 4. audit: 'rotated'
```

Enforcement lives in step 5 of the verification path — a key is valid while
`now < COALESCE(grace_until, 'infinity')`.

Two reasons for the **family** table rather than a `rotated_to` column on `api_keys`:

1. **Kill switch.** Revoke the family and every key in the rotation chain dies at once.
   With a self-referencing column you'd have to walk the chain recursively.
2. **No migration later.** A `key_groups` table is a schema change plus a backfill once
   real customers exist. Adding it now, while the table is empty, is free.

Grace period is 24h by default, configurable per rotation.

---

## 8. Revocation

| Action              | Effect                                 | Use case             |
| ------------------- | -------------------------------------- | -------------------- |
| `revoke_key(id)`    | `status='revoked'`, `revoked_at=now()` | Leaked single key    |
| `revoke_family(id)` | Revoke family + all keys in it         | Suspected compromise |
| Expire naturally    | `expires_at` passes                    | Short-lived CI keys  |
| Grace lapse         | `grace_until` passes                   | Superseded rotation  |

Revocation is **immediate and authoritative** — the row is the source of truth, so
there is no cache to invalidate in this phase. (Phase 4 must purge the Redis cache on
revoke or a revoked key stays live for up to the TTL. That's a correctness trap; note
it now.)

---

## 9. Scopes

```ts
const ALL_SCOPES = ['mock:read', 'mock:write', 'chaos:write', 'keys:read'] as const;
```

- Stored as `text[]`, checked per-route.
- A key with no scopes is treated as `mock:read` only — **fail closed**, never
  "empty means all".
- `viewer` role can create read-only keys; `dev`+ can create write keys. Enforced by
  `requirePermission('keys:create')` in the route, reading scope from the body.

Scopes are additive-only for a key's lifetime: narrowing them requires rotation. Note
this in the UI so users aren't surprised.

---

## 10. API surface

```
POST   /api/keys                 create          → 201, raw key ONCE
GET    /api/keys                 list (masked)   → 200
GET    /api/keys/:id             get one         → 200
POST   /api/keys/:id/rotate      rotate          → 201, new raw key ONCE
POST   /api/keys/:id/revoke      revoke          → 204
POST   /api/families/:id/revoke  revoke family   → 204
```

**Create / rotate response** — the only time the raw key exists in a response:

```json
{
  "key": "sk_live_9Kd2mQxR7tYb4nW8pL3sA_zF1cH6jV0gN5eU",
  "id": "…",
  "prefix": "sk_live_9Kd2mQxR7tYb",
  "last4": "eU",
  "env": "live",
  "scopes": ["mock:read"],
  "warning": "This is the only time the key will be shown."
}
```

**List / get response** — masked, never the secret:

```json
{
  "id": "…",
  "name": "staging-backend",
  "display": "sk_live_9Kd2…eU",
  "env": "live",
  "status": "active",
  "scopes": ["mock:read"],
  "last_used_at": "2026-10-02T12:00:00Z",
  "expires_at": null,
  "created_at": "…"
}
```

All routes require a session (`requireAuth`) **and** org membership. Creating a key
requires `keys:create`; listing requires `keys:read`.

**Idempotency:** accept an optional `Idempotency-Key` header on create, stored in Redis
later / a unique index now, so a double-click or client retry can't mint two keys.

---

## 11. Log redaction

The single highest-value rule in this phase: **a key must never reach a log.**

```ts
export function redact(text: string): string {
  return text.replace(/sk_(test|live)_[A-Za-z0-9]{12}_[A-Za-z0-9]{32}/g, 'sk_$1_***');
}
```

Applied to:

- pino serializers on the request logger
- every error message returned from key routes
- the `touch()` batch payloads
- CI secret scanning (Phase 9) — and a `.gitignore`d `tmp-*.json` habit already helps

The regex is the safety net; the real defence is that `verifyKey` returns a context
object and the raw string is dropped immediately.

---

## 12. Frontend

**Keys page** (`/dashboard/keys`):

- Table: name, masked key, env badge, scopes, status, last used, created
- **Create modal** → name, env, scope checkboxes
- **One-time reveal** — full key in a monospace block, copy button, and a warning that
  it cannot be retrieved again. Dismissal is permanent.
- Rotate → confirm, then a reveal identical to create
- Revoke → typed confirmation (type the key name), because it's destructive

**Rules:**

- Never store the raw key in localStorage, sessionStorage, or React state beyond the
  reveal modal. It lives in component state and dies on close.
- No server-side rendering of key material — this is a client-only app, which is exactly
  why we kept the API boundary visible.

---

## 13. Security checklist

**Storage**

- [ ] Raw key never persisted
- [ ] Pepper in env var, never in the DB, never in git
- [ ] HMAC-SHA-256, `timingSafeEqual` for all comparisons
- [ ] Only `prefix` / `last4` / `secret_hash` stored

**Generation**

- [ ] `crypto.randomBytes` exclusively
- [ ] ≥192 bits of entropy in the secret
- [ ] Key shown exactly once, never retrievable

**Verification**

- [ ] Uniform 401 for every failure mode
- [ ] Dummy HMAC on miss to flatten timing
- [ ] `status`, `expires_at`, `grace_until` all enforced
- [ ] Scope check before handler

**Lifecycle**

- [ ] Rotation preserves a grace window
- [ ] Family revocation kills the whole chain
- [ ] Audit event for create / rotate / revoke / auth_failed

**Operations**

- [ ] Redaction in logs and error bodies
- [ ] `.env` gitignored; `KEY_PEPPER` absent from `.env.example` values
- [ ] Rotation documented in the README (keys have a shelf life)

**Failure modes to test explicitly**

| Case                            | Expected                          |
| ------------------------------- | --------------------------------- |
| Truncated / mangled key         | 401                               |
| Valid format, unknown public id | 401, uniform timing               |
| Correct public id, wrong secret | 401                               |
| Revoked key                     | 401                               |
| Expired key                     | 401                               |
| Grace window expired            | 401                               |
| Insufficient scope              | 403                               |
| Empty scopes                    | treated as `mock:read`, not "all" |
| Concurrent rotate ×2            | both succeed, family consistent   |

---

## 14. Build order

| #   | Step                                                | Done when                                              |
| --- | --------------------------------------------------- | ------------------------------------------------------ |
| 1   | `format.ts` — parse/build, base62, round-trip tests | round-trip property tests pass                         |
| 2   | Schema + migration                                  | `api_keys`, `api_key_families`, `api_key_events` exist |
| 3   | `generate.ts` + `redact.ts`                         | entropy + redaction tests pass                         |
| 4   | `store.ts` create/list/get                          | key created, list shows masked                         |
| 5   | `verify.ts`                                         | all 9 failure cases in the table above pass            |
| 6   | `middleware.ts` + scopes                            | 401/403 correct, context attached                      |
| 7   | rotate / revoke / family revoke                     | grace window works, chain killable                     |
| 8   | `touch.ts` write-behind                             | batched, never blocks the response                     |
| 9   | `audit.ts`                                          | every lifecycle event recorded                         |
| 10  | Routes + idempotency                                | raw key returned once, then never                      |
| 11  | Frontend keys page                                  | reveal once, rotate, revoke                            |
| 12  | Shutdown flush + `pepper` presence check            | no buffered data lost on SIGTERM                       |

**Exit criteria**

```bash
KEY=sk_live_…   # from the create response

curl -H "Authorization: Bearer $KEY" localhost:3001/mock/…   # 200
# revoke it
curl -H "Authorization: Bearer $KEY" localhost:3001/mock/…   # 401
# rotate it, old key still works during grace, dead after
grep -r "$KEY" logs/                                       # no match
```

Plus: no raw key in any log, no raw key in the DB, and every failure mode above returns
the documented status.

---

## 15. Testing

**Unit** — base62 round-trip, key parsing (valid, truncated, wrong arity, bad env),
HMAC determinism, `timingSafeEqual` length handling, redaction (valid key, near-miss
strings, key at buffer boundary).

**Integration** (Supertest + real Postgres) — full lifecycle against a real DB:
create → verify → rotate → grace → revoke → 401, family revoke killing the chain,
scope enforcement, audit rows written, `last_used_at` batching.

**Security** — the 9 failure modes above, asserted individually. Log-redaction tested
by capturing pino output and asserting the key never appears.

> No mocking of the verification path. Argon2id/HMAC correctness is the thing under
> test; a mock proves nothing. (Same principle as "never mock the limiter" in Phase 4.)

---

## Dependencies to add

| Package                  | Why                                   |
| ------------------------ | ------------------------------------- |
| `zod`                    | ✅ already present — route validation |
| `pg` (via `postgres-js`) | ✅ already present                    |
| base62 encoder           | ~20 lines, or a small dep — Phase 2   |
| pino redaction           | ✅ via Fastify's logger               |

`base62` is the only genuinely new dependency, and it's small enough to write inline.
Base64url is an acceptable substitute if you'd rather not add anything.

---

## Relationship to later phases

| Phase                 | What it changes                                                          |
| --------------------- | ------------------------------------------------------------------------ |
| **4 — Rate limiting** | Swap `verifyKey` internals for Redis cache; add limiter; header emission |
| **5 — Analytics**     | `last_used_at` → `request_logs`; per-key usage from the hypertable       |
| **6 — Chaos**         | `chaos:write` scope gates the chaos API; chaos config keyed by `key_id`  |
| **9 — Deploy**        | `KEY_PEPPER` as a Fly secret; secret scanning for `sk_` in CI            |

The `api_keys` primary key is the join key for all of it. Nothing here needs rework.
