# Plans and Gates — the PLAN GATE LAW

Source of truth: "Forge Feature — Catalog Part 01 With Plans" and "Part 02 With Plans" (Google Drive, 8 Nov 2026). Every feature in the catalog carries exactly one gate: the lowest plan that unlocks it. When a feature is built, its gate is written in the same batch — never later.

## The plans

- Free — every account; no row needed, the default.
- Plus — 9.99 USD per month.
- Pro — 24.99 USD per month.
- Studio — 59.99 USD per month: Pro access with bigger pools and three seats. It also satisfies every Team-gated row, but never an Enterprise row.
- Team — 39 USD per seat per month, three seats minimum.
- Enterprise — from 1,000 USD per month.

Plans are cumulative: Free ⊂ Plus ⊂ Pro ⊂ Team ⊂ Enterprise, with Studio ranked alongside Team. Prices live in config only (FORGE_PLUS_USD_PER_MONTH and friends); the engine never hardcodes them.

## Gate kinds

- free / plus / pro / team / enterprise — the lowest plan that unlocks the feature.
- internal — forge machinery. Never gated on a request, never sold. Internal rows pass through the route wrapper untouched.
- engine — the account must own a pass for the named engine (ENGINE_BY_FEATURE; TQ-027 requires the creative pass).

## Enforcement

- src/modules/plans/engine/feature-gates.ts — FEATURE_GATES, one gate per catalog feature (201 rows).
- src/modules/plans/engine/route-gates.ts — ROUTE_GATES, every wired route pinned to its catalog feature (268 rows). Routes absent from the map (health, the plans routes) are ungated.
- applyRouteGates wraps the merged route table: sign-in first (401), then the plan check. A denied request gets 402 plan_required with details { feature, gate, plan, reason } where reason is plan_too_low or engine_pass_missing.

## Routes

- GET /v1/plans/me — the caller's plan, engine passes, and the six configured prices. Never gated.
- POST /v1/plans/check { featureId } — the catalog verdict for one feature: { entitlement: { allowed, feature, gate, plan, reason } }. Unknown features are refused by name (404 plan_feature_unknown). Never gated.

## Storage and events

- user_plans table (SQLite and PostgreSQL migrations, module "plans"): user_id (PK, references users), plan, engine_passes (JSON), timestamps. One row of record per user; PlansService.setPlan is the only writer.
- Every change emits plans.plan.changed (version 1): actor service/plans, subject user_plan/<userId>, payload { userId, plan, enginePasses }.

## Counted registry (pinned by tests)

FEATURE_GATES: 201 features — free 85, internal 54, pro 25, enterprise 16, team 10, plus 10, engine 1. ROUTE_GATES: 268 wired routes, every one resolving to a catalog feature. Both are pinned in test/plans-engines.test.ts; the functional contract is pinned in test/plans.test.ts.
