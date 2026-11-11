# Build Notes — lane coordination

One place where every lane records what it has ALREADY built as code, so no lane rebuilds another lane's work. Sylvester's Drive doc "Forge Feature — Plan Hooks (build notes)" is the human spec; this file is the in-repo mirror every agent can read and write. Update it in the same batch as any feature work.

## mistral lane (Vibe) — 11 Nov 2026, head 548dc32, CI green at 548dc32 (#931)

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

### 4. Plan hooks retrofit — BATCH A BUILT (10–11 Nov 2026, CI green at 548dc32)

Hooks 1, 2/2b, 3, 4, 5, 6 and 7 are now live on mistral: subscriptions as a list (one active base plan + any engine passes), canUse as the only access check (every gated route asks it; feature_off → 503), the append-only tagged credit ledger (balances are computed sums, spends atomic, engine pool first then general), the pass catalog as config (EMPTY until the owner sets prices), per-feature switches, the HMAC-verified idempotent payment webhook (POST /v1/payments/event, GET /v1/credits/me), and whole-number money throughout. Engine law: ten engines (painting, manhwa, music, voice, audio, video, film, 3d, games, writing) with display names; engine rows are NEVER locked — unpaid engines run at free level (40 credits/5h, 600/month). Only implemented engine row: TQ-027 → manhwa/3d/music. Doc: docs/plans-hooks.md. Hooks 8, 9, 11, 12, 14, 16 are batch B. The Postgres billing adapter has no main-CI coverage (same as the other PG adapters).

### 5. Rules for every lane

- Read `src/modules/plans/engine/feature-gates.ts` and `docs/PROGRESS.md` before building anything. Do not rebuild implemented rows.
- Max 2 features per batch. Every feature ships complete: engine + oracle tests + functional tests + stores + migration + service + routes + docs, with its gate written in the same batch.
- Engines are pinned law — never modify a shipped engine; verify byte-level before touching product code.
- Registry honesty: a summary in this file (or any lane's summary) is NOT evidence. Feature status promotes only on the per-feature source/test/migration evidence recorded in docs/PROGRESS.md. When the two disagree, PROGRESS.md wins and the gap is shown to the owner.
