# BD-001, BD-016, BD-017, BD-029, BD-030 - plan gate retrofit (gpt-part2-build-ci)

Catalog source: Drive doc "Forge Feature - Catalog Part 02 With Plans", section 8 "Build and CI (BD)".

| Row | Feature | Plan from |
| --- | --- | --- |
| BD-001 | Pipeline engine: declarative, versioned, shareable | Free |
| BD-016 | Triggers: push, PR, schedule, event, manual, API | Free |
| BD-017 | Conditional and path-based pipelines | Plus |
| BD-029 | Dry-run for any pipeline change | Free |
| BD-030 | Pipeline versioning and rollback | Free |

## What was built

- `src/modules/plans/engine/feature-gates.ts` - the plan ladder (free/plus/pro/team/enterprise, cumulative), the five gate rows above exactly as catalogued, `canUse`, and `definitionUsesConditionalFeatures` (the BD-017 surface: step conditions, step path filters, trigger path filters).
- `src/modules/plans/plans-service.ts` - one base plan per user, defaulting to free; in-memory, SQLite and PostgreSQL stores plus the `user_plans` migration (SQLite auto-applied in the app composition, PostgreSQL exported for the operator).
- `src/modules/plans/routes.ts` - `GET /v1/plans/me` and `POST /v1/plans/check` (402 plan_required with feature + gate in the details).
- `src/modules/plans/build-ci-gate.ts` - wraps the Build & CI route table: pipeline read/create carry BD-001, trigger carries BD-016, rollback carries BD-030, dry-run (and scenarios) carry BD-029; every POST with a candidate definition is additionally checked against BD-017, so a conditional or path-filtered pipeline needs Plus wherever it is submitted. Authentication stays with the inner routes; the gate only adds the plan check.
- App composition wires the gate around `buildCiRoutes` and exposes the plans service as `app.plans`.

## Tests

- `test/plans-gates.test.ts` - pure oracle: ladder order, exact catalog gates, free-plan refusals naming the gate, plus-and-above unlocks, unknown-feature TypeError, exact conditional/path detection.
- `test/plans-routes.test.ts` - route level: free user creates a plain pipeline (201), is refused a conditional one (402 BD-017/plus), is allowed after a Plus upgrade; dry-run candidates gated identically; BD-030 never blocks a free user; plans routes answer.

## Honest limits

- One base plan per user; subscriptions as a list, credit ledger and passes stay on the mistral lane's plans module and are out of scope here.
- The PostgreSQL plan store has no CI coverage (same as the branch's other PostgreSQL adapters).
- Per-feature acceptance docs for the remaining BD rows follow with their implementation batches.
