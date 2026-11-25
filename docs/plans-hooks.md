# Plan hooks — how plans, engines, credits and payments really work

The plan hooks retrofit, batch A, built 10–11 November 2026 on the mistral lane. The human
spec is Sylvester's Drive doc "Forge Feature — Plan Hooks (build notes)"; the catalog rows
and their gates live in "Forge Feature — Catalog Part 01/02 With Plans" and the engine
names in "Forge Feature — Engine Row Map". This file is the in-repo mirror of what is built.

## The engine law

Ten creative engines, with their display names:

```
painting, manhwa, music, voice, audio, video, film, 3d, games, writing
```

- Engines are NOT joined with any base plan. A pass for one engine is its own product;
  a base plan never secretly includes engines unless it is named in the all-round bundle list.
- Engine rows in the catalog are NEVER locked. Every account can run every engine row;
  what changes with payment is the LEVEL (free or paid) and how many credits it draws.
- The only engine-tagged catalog row wired so far is TQ-027 → manhwa, 3d, music. The other
  engine rows (AI-116..AI-120, TQ-092) are catalog rows only; their tags land when their
  features are built.
- Engine names are pinned law: never invent an engine, never rename one. New engines come
  only from the Engine Row Map.

## What is built (batch A)

**Hook 1 — subscriptions are a list, not one plan.** `subscription_items` table
(migrations v2, SQLite STRICT and PostgreSQL). Migration v11 moves existing legacy plan and
engine-pass records into subscription items without reactivating any user who already has
subscription history. A user can hold one active base plan and any number of engine passes.
`activeBasePlan` / `activePasses` in the pure engine `engine/subscription-engine.ts`
decide what is live; a base-plan purchase supersedes the previous base plan (one active base
plan per user, enforced by a partial unique index). Free is the default, not an item.
The legacy `user_plans` row is a compatibility mirror only: access decisions and displayed
entitlements are derived exclusively from live subscription items.

**Hook 2 and 2b — canUse is the only access check.** `engine/access-engine.ts` produces one
decision per (user, feature): allowed or refused, with the plan, passes, engine level
(free/paid) and the free-engine limits. The free level for an unpaid engine is 40 credits
per 5-hour window with a 600-credit monthly ceiling. Nothing else in the app decides access:
every gated route asks `plans.canUse` through the gate middleware, unknown features are
refused by name (404 plan_feature_unknown), a switched-off feature answers 503 feature_off,
and a plan below the gate answers 402 plan_required with the feature, gate, plan and reason.

**Hook 3 — the credit ledger.** `credit_ledger` (migration v4) is append-only. A balance is
ALWAYS the sum of entries, computed, never stored. Entries carry the engine tag (empty
string = general credits), the source (free_window, plan, pass, top_up), expiry, the job
that spent them, the grant a spend drew from (sourceEntryId) and the real cost to Forge in
whole micro-dollars. Spend order is law: engine pool first, then general; free-window before
plan before pass before top-up; earlier expiry first. A spend is atomic — an uncovered spend
writes nothing and answers 402 insufficient_credits with the shortfall.

**Hook 4 — the pass catalog.** A short list of sellable products (base plans and engine
passes) that makes engines sellable on their own. It is configuration (`FORGE_PASS_CATALOG`
JSON), never code, and it is EMPTY until the owner sets prices. Every price must pass the
margin guard before a pass goes sellable; a pass never costs more than the all-round plan
that already includes its engine.

**Hook 5 — switches.** `FORGE_GATES_ENABLED` is the master flag (development convenience;
never off in production). `FORGE_FEATURE_SWITCHES` is a per-feature on/off CSV
(FEATURE:true) flippable without a release; a switched-off feature answers 503 feature_off.

**Hook 6 — payment events, verified, once.** `POST /v1/payments/event` is a provider
webhook: no session, HMAC signature over the payload (`FORGE_PAYMENT_WEBHOOK_SECRET`,
required in production, insecure development default with a warning). A repeat event id is
ignored (duplicate: true), so a provider can never add credits twice. The event creates the
subscription items and grants the credits: a base plan grants its monthly pool as general
credits; an engine pass grants the catalog credits tagged with its single engine.

**Hook 7 — money is whole numbers.** Amounts are whole smallest-unit integers with a
currency code; costs are whole micro-dollars. No floats, anywhere in billing.

## Routes

- `GET /v1/plans/me` — plan of record, engine passes, prices.
- `POST /v1/plans/check` — the canUse decision for a feature id: `{ decision: { allowed,
  feature, gate, plan, passes, engine, level, limits, reason } }`.
- `GET /v1/credits/me` — `{ balances: { general, engines: [{ engine, balance }] } }`.
- `POST /v1/payments/event` — signed webhook (see Hook 6).

## Configuration

`FORGE_GATES_ENABLED`, `FORGE_FEATURE_SWITCHES`, `FORGE_ENGINE_BUNDLE_PLANS` (base
plans that include every engine at paid level — empty until the owner names the all-round
plans), `FORGE_FREE_WINDOW_CREDITS` (40), `FORGE_FREE_WINDOW_HOURS` (5),
`FORGE_FREE_MONTHLY_CEILING` (600), `FORGE_{PLUS,PRO,STUDIO,TEAM}_MONTHLY_CREDITS`
(3000/7500/18000/11800, the Numbers Plan of 2 Nov 2026), `FORGE_PASS_CATALOG`,
`FORGE_PAYMENT_WEBHOOK_SECRET`.

## Monthly credits

plus 3000, pro 7500, studio 18000, team 11800 per month, granted as general credits on the
verified payment event. Free draws the window instead — 40 credits per 5 hours, 600 a month.

## Batch B — hooks 8, 9, 11, 12, 14, 16 (11 Nov 2026)

**Hook 8 — the country table.** Pure engine `engine/country-registry-engine.ts`: one row
per country (ISO code, currency, region band A/B/C, the tax rule with the date it was
checked, payment methods, enabled, minimum payout). `REGION_BAND_MULTIPLIERS` (A 1.00,
B 0.70, C 0.45) is the price-band basis. Rows come from `FORGE_COUNTRY_CATALOG` (JSON,
validated at config parse) and the catalog is EMPTY until the owner supplies country data.
Routes: `GET /v1/plans/countries`, `POST /v1/plans/countries/get` (404 country-unknown,
403 country-disabled).

**Hook 9 — cached access for bad networks.** Pure engine
`engine/access-snapshot-engine.ts` assembles/verifies a snapshot
{userId, plan, passes, issuedAt, expiresAt}. The server retains its HMAC signature for
server-to-server verification and also emits a domain-separated Ed25519 signature plus
public key for offline client verification. The private signing material is derived from
`FORGE_ACCESS_SNAPSHOT_SECRET` (falling back to the webhook secret with a production
warning); configured secrets must contain at least 32 UTF-8 bytes. The TTL is
`FORGE_ACCESS_SNAPSHOT_TTL_HOURS` (default 6, 1–72). The platform-neutral
`client-access-cache.ts` refreshes online first, falls back only for classified connectivity
loss, verifies the public signature, enforces server-time expiry and local clock rollback
checks, clears cache on server rejection, and never extends the signed expiry. The host
application must supply authenticated HTTPS transport, a public-key verifier and encrypted
Keychain/Keystore-equivalent storage; this backend repository has no mobile/web client or
native secure-storage adapter. The server stays authoritative and verify still returns live
server state. Routes: `POST /v1/plans/access-snapshot`,
`POST /v1/plans/access-snapshot/verify`.

**Hook 11 — the basic admin console.** Pure engine `engine/admin-console-engine.ts`:
`isAdmin` (allowlist) and `validateAdminAction` with named refusals; a written reason is
required for every action (the audit trail is not optional). Service: adminGrantCredits
(top_up source, engine-tagged), adminCompPlan, adminPauseAccount/resume (a paused account
answers 403 account_paused on every gated route) and adminLedger (items + entries +
balances, read-only). The allowlist is `FORGE_ADMIN_USERS` (CSV) and it is EMPTY until the
owner names the admins — with an empty list every admin action answers 403 admin_forbidden.
Routes: `POST /v1/admin/credits/grant`, `/v1/admin/plans/comp`,
`/v1/admin/accounts/pause`, `/v1/admin/ledger`.

**Hook 12 — coupons, trials and referrals as ONE model.** Pure engine
`engine/promotion-engine.ts`: one table (code, kind coupon/trial/referral, creditAmount,
days, maxRedemptions, perUserLimit, expiresAt) with a limit and an expiry, named refusals
for every field; redeem refuses expired, repeated (per-user) and exhausted codes by name.
Definitions and redemptions are persisted in SQLite/PostgreSQL. Redemption limits are
checked and the redemption plus credit-ledger grant commit in one storage transaction; PostgreSQL
locks the promotion row and SQLite uses a write transaction. Credit benefits use the existing
append-only ledger (`top_up` source). Time-based benefits are still refused as
`promotion-days-unsupported` until the subscription lifecycle policy is defined. The promotion audit event is now appended by the SQLite and PostgreSQL billing stores in the same transaction as redemption and ledger changes. The in-memory test adapter uses the service fallback and is not a durable production store.
Routes: `POST /v1/promotions/define` (admin), `/v1/promotions/redeem`, `/v1/promotions/status`.

**Hook 14 — rate limits at the gateway.** Pure engine `engine/rate-limit-engine.ts`:
fixed-window counters with named refusals and an honest retryAfterMs. `FORGE_RATE_LIMITS`
JSON (e.g. `{"user":{"limit":60,"windowMs":60000}}`) — DISABLED until the owner sets it.
When enabled, every gated route enforces the per-user and per-device limits after sign-in,
before canUse and before any AI call, answering 429 rate_limited with scope and retryAfterMs.
The gateway issues a one-year HttpOnly, SameSite=Strict device cookie containing an opaque UUID
signed with the access-snapshot HMAC secret; invalid or expired tokens receive a fresh identity.
The device rule remains disabled until the owner supplies a limit/window in `FORGE_RATE_LIMITS`.
Route wiring: `gate-middleware.ts`.

**Hook 16 — export and delete my data.** Pure engine `engine/account-data-engine.ts`
builds the base plan/pass/subscription/ledger bundle. The application export provider adds
owner-scoped records from the composed task, orchestrator, test, live-testing, search,
workspace-retrieval, AI-training, training-data and status-page modules. It now includes all
offline-sync operations, current entity snapshots and open/resolved conflicts, every
search-integrity cache entry, and all web-search domain rules (including unqueried workspaces).
It redacts generated test-account passwords, other participants' identity rows and internal
storage keys. The Hook 16 follow-up adds direct owner-scoped enumeration for every database-backed
AI-training record and the authenticated user's workspace memberships. `exportCoverage.complete`
remains deliberately `false` for external binary/model artifacts whose bytes are not available
through a storage-provider export contract. `POST /v1/account/export` remains a no-store JSON
attachment. `POST /v1/account/delete` (confirm: true) pauses and queues
the account; it does not hard-purge. The owner must verify the full data inventory and applicable
retention requirements (including Nigeria NDPR) before destructive deletion is enabled.

## What is NOT complete

The hooks have implementation foundations, but they are not all complete. The current verified
status and evidence are maintained in `docs/part02-audit-ledger.md`. The access decision no
longer reads the legacy plan/pass mirror; migration v11 carries existing records into
subscription items. Remaining work is recorded in the audit ledger.
- Durable SQLite and PostgreSQL stores append hash-chained audit events in the same transaction as the implemented payment, credit-ledger, promotion and account-control mutations. The earlier audit-gap defect is closed for those paths; refund/reversal lifecycle still needs its own atomic accounting and audit implementation when provider semantics are defined.
- The pass catalog still lacks per-window caps, regional minor-unit price rows and the
  ALG-43/52/56 inputs/formulas. Production correctly refuses `sellable: true` until those
  are implemented and supplied.
- Country rows, verified tax rules, payment methods, admin allowlist and rate-limit values
  remain owner-configured and default empty/disabled.
- Per-device identity and shared per-user/per-device counters are wired through the gateway. Production still requires owner-supplied user and device thresholds; missing rules fail closed at startup.
- Promotion day-benefits and refund lifecycle remain unfinished pending owner policy. Hook 15's fake clock and signed test-payment fixtures now cover successful purchase, renewal, upgrade, failed-payment rejection and refund-event rejection without real money; refund credits/entitlements are not reversed until the owner defines the policy. Account export enumerates all 27 database-backed AI-training record collections by owner across in-memory, SQLite and PostgreSQL, plus the authenticated user's workspace memberships, offline-sync history, search caches and web-search domain rules. Training-asset storage keys remain redacted; external binary/model artifact bytes still require a storage-provider export contract. Jurisdiction-approved hard deletion remains disabled.
- Hook 9 now has a public-key-verifiable Ed25519 snapshot signature and a platform-neutral
  client cache/refresh state machine. The actual app must still supply authenticated HTTPS,
  a platform verifier and integrity-protected Keychain/Keystore-equivalent storage; this
  repository contains no mobile/web application or native secure-storage adapter.
- The PostgreSQL Plan Hooks persistence suite runs in CI against the PostgreSQL 16 service;
  the latest verified workflow is recorded in the audit ledger.

Finish engineering work that is supported by the two governing documents. Record missing
owner-supplied prices, tax/legal rules, admin identities, production thresholds and lifecycle
policies as explicit blockers, but do not let those blockers stop independent Part 02 work.

## Where the code lives

`src/modules/plans/` — `engine/plan-engine.ts` (ladder + ten engines + ENGINE_NAMES),
`engine/access-engine.ts`, `engine/subscription-engine.ts`, `engine/ledger-engine.ts`,
`engine/payment-provider.ts` (HMAC), `billing-store.ts`, `plans-service.ts` (canUse,
processPaymentEvent, grant/spend/balances), `gate-middleware.ts`, `routes.ts`, stores and
migrations for memory, SQLite and PostgreSQL. Tests: `test/plans-engines.test.ts` (pure
engines) and `test/plans.test.ts` (routes, webhook, ledger).


## Audit correction — 20 November 2026

The repository audit found that the earlier "handled once" wording overstated the implementation: the webhook previously performed a check-then-write sequence, and concurrent ledger spends could both calculate against the same balance. The billing storage contract now exposes transaction-scoped payment application and ledger mutation operations. SQLite uses `BEGIN IMMEDIATE`; PostgreSQL locks the owning user row and performs the event claim, subscription updates/inserts, and payment credit inserts in one transaction. A duplicate event ID is claimed with a unique-key insert, and a duplicate does not apply any state changes. Credit grants and spends now calculate and append under the same per-user transaction. Plan and pass credit grants expire with the purchased subscription period.

Admin actions now emit append-only `plans.admin.action` events with the authenticated admin actor, target, action and required reason. Promotion redemptions and account-deletion requests also emit named events. The admin promotion-definition endpoint now requires a written reason.

Subsequent implementation closed the durable account pause/deletion state and atomic promotion-definition/redemption gaps in the SQLite and PostgreSQL adapters. Billing mutations and their hash-chained audit events are committed in the same database transaction for the production adapters. Remaining work is tracked in `docs/part02-audit-ledger.md`: owner-supplied regional price books and ALG-52/ALG-56 guard inputs; owner-approved tax/payment/country configuration, admin identities, rate thresholds and time-based promotion/refund policies; native client secure-storage integration; external binary artifact export and approved hard-deletion policy; and refund reversal semantics/tests. The CI workflow runs against a real PostgreSQL 16 service; the SQLite-backed adapter harness is additional fast coverage, not the only database evidence.


### Audit correction — 20 November 2026 (follow-up)

The follow-up review found and fixed two edge cases in the plan hooks:

- Hook 2b now applies the free-engine monthly cost ceiling to every unpaid engine, including accounts with a paid base plan that does not include that engine. A paid base plan is not treated as an all-round engine entitlement.
- Hook 9 snapshots now carry separate base-plan and per-engine pass expiry timestamps. A plan downgrades to Free and an individual pass disappears at its own expiry, without invalidating other still-live entitlements. Snapshot verification is bound to the authenticated user and refuses paused or deletion-queued accounts.

These changes are covered by regression tests. They do not resolve the remaining owner-input and lifecycle blockers recorded in `docs/part02-audit-ledger.md`.


### Audit correction — 20 November 2026 (pass product mapping)

Payment events now carry configured product codes (for example `plus_plan`, `music_pass`, or `music_painting_pass`) rather than relying on engine codes being sent as product identifiers. The service requires a matching sellable catalog entry, resolves base-plan products to their plan code, and expands multi-engine passes into one subscription item and one engine-tagged credit grant per included engine. In this implementation, `creditsIncluded` is interpreted per included engine so the ledger never creates a cross-engine credit pool.

The catalog still must remain non-sellable/empty until the owner supplies the missing regional minor-unit price book, per-window cap values, and the ALG-43/52/56 guard inputs. Those values are not specified in the two governing PDFs and were not invented here.


### Audit correction — 20 November 2026 (multi-engine credit allocation and production guard)

The PDF names a single `credits_included` value for a product that may contain multiple engines, while Hook 3 requires every ledger entry to carry exactly one engine tag. The source does not define how a two-engine product's total is split. The implementation therefore adds optional `creditsByEngine` allocation metadata: single-engine products may use the full `creditsIncluded` amount for that engine; a sellable multi-engine product must explicitly allocate the total across every included engine, and the allocations must sum to `creditsIncluded`. This prevents silently duplicating a shared total across engine pools.

Production configuration now refuses `sellable: true` until regional minor-unit prices, per-window caps and the ALG-43/52/56 guard are actually implemented and supplied. Test configuration can still exercise signed webhook flows without real money.


### Audit correction — 20 November 2026 (per-engine access level)

A feature row may name several engines. A single pass must not mark the whole row paid: the access decision now returns `engineLevels` for each named engine, and the aggregate feature level is paid only when every engine in that row is paid (or the account is on a configured all-round plan). This closes the previous `some()` check that let one pass raise the level of other engines named by the same feature.
