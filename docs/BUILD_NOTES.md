# Build Notes — lane coordination

One place where every lane records what it has ALREADY built as code, so no lane rebuilds another lane's work. Sylvester's Drive doc "Forge Feature — Plan Hooks (build notes)" is the human spec; this file is the in-repo mirror every agent can read and write. Update it in the same batch as any feature work.

## mistral lane (Vibe) — 9 Nov 2026, head 43579e7, CI green at 2c50d5f

### 1. Plans gate framework — BUILT AND LIVE

Single base plan per user. Module `src/modules/plans/` (13 files): plan ladder Free → Plus → Pro → Studio/Team → Enterprise (Studio covers Team; internal rows never gated), `FEATURE_GATES` = 201 implemented features each tagged with its With-Plans "Plan from" gate (85 free, 54 internal, 25 pro, 16 enterprise, 10 team, 10 plus, 1 engine), `ROUTE_GATES` = 268 wired routes, in-memory/SQLite/PostgreSQL stores + migrations, plans service (GET /v1/plans/me with prices from config, POST /v1/plans/check), gate middleware (401 then 402 plan_required with feature + gate + reason). Tests: `test/plans-engines.test.ts` + `test/plans.test.ts`. Doc: `docs/plans-gates.md`. Commits: 411334b, 94d1bd5, 8059e71 (CI green).

### 2. Implemented feature tags (whole-repository audit, every gate enforced)

- CO-001–CO-080 and CO-096 — implemented.
- AI-001–AI-083 EXCEPT AI-015, AI-016, AI-018 — implemented. Batches so far: batch 1 = AI-001/002/007/008; batch 2 = AI-009 + AI-010; batch 3 = AI-011 + AI-012. Every feature shipped complete: engine + oracle tests + functional tests + feature doc.
- TQ-001–TQ-040 — implemented.

### 3. NOT implemented (nobody has built these)

- AI-015 (preference tuning pipelines), AI-016 (distillation), AI-018 (experiment tracking) — all three Internal rows; next batch candidates in that order.
- AI-084–AI-150 and TQ-041–TQ-120 — not started.
- Everything in Part 02 (DP / OB / CG / RV / BD / SC) — not started on mistral.

### 4. Plan Hooks 1–16 — NOT YET BUILT

The current system is one base plan per user. The hooks from Sylvester's build-notes doc (added 8–9 Nov: subscription items table, canUse as the only access check, tagged credit ledger, pass catalog, unpaid-engine free-level fallback, plus Hooks 5–16: feature switches, idempotent payment events, whole-number money, country table, cached access, audit log, admin console, coupons/trials/referrals, server clock, gateway rate limits, test mode, data export/delete) are the pending retrofit. Catalog Part 01 With Plans law: build the hooks before any more Part 1 features. Sequencing being confirmed with Sylvester before the next batch.

### 5. Rules for every lane

- Read `src/modules/plans/engine/feature-gates.ts` and `docs/PROGRESS.md` before building anything. Do not rebuild implemented rows.
- Max 2 features per batch. Every feature ships complete: engine + oracle tests + functional tests + stores + migration + service + routes + docs, with its gate written in the same batch.
- Engines are pinned law — never modify a shipped engine; verify byte-level before touching product code.
