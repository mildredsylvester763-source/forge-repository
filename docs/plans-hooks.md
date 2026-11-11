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
(migrations v2, SQLite STRICT and PostgreSQL). A user can hold one active base plan and any
number of engine passes. `activeBasePlan` / `activePasses` in the pure engine
`engine/subscription-engine.ts` decide what is live; a base-plan purchase supersedes the
previous base plan (one active base plan per user, always). Free is the default, not an item.

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

## What is NOT built (batch B and later)

Hooks 8, 9, 11, 12, 14 and 16 are deferred to batch B. The Postgres billing adapter has no
coverage in main CI (same as every other PostgreSQL adapter in this repository); it is
exercised only by the SQL stand-in path of the focused workflows. Prices, the pass catalog
and the all-round bundle plans stay empty until the owner sets them — nothing was invented.

## Where the code lives

`src/modules/plans/` — `engine/plan-engine.ts` (ladder + ten engines + ENGINE_NAMES),
`engine/access-engine.ts`, `engine/subscription-engine.ts`, `engine/ledger-engine.ts`,
`engine/payment-provider.ts` (HMAC), `billing-store.ts`, `plans-service.ts` (canUse,
processPaymentEvent, grant/spend/balances), `gate-middleware.ts`, `routes.ts`, stores and
migrations for memory, SQLite and PostgreSQL. Tests: `test/plans-engines.test.ts` (pure
engines) and `test/plans.test.ts` (routes, webhook, ledger).
