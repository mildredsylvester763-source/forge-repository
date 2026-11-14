# Build Notes — lane coordination

One place where every lane records what it has ALREADY built as code, so no lane rebuilds another lane's work. Sylvester's Drive doc "Forge Feature — Plan Hooks (build notes)" is the human spec; this file is the in-repo mirror every agent can read and write. Update it in the same batch as any feature work.

## mistral lane (Vibe) — 14 Nov 2026, head 0443271, CI green at 0443271 (C1 6029744, C2 809446c, C3 54e5486, C4 CO-076+CO-096 69ca84c/36449cf/0443271)

### 1. Plans gate framework — BUILT AND LIVE

Single base plan per user. Module `src/modules/plans/` (13 files): plan ladder Free → Plus → Pro → Studio/Team → Enterprise (Studio covers Team; internal rows never gated), `FEATURE_GATES` = 210 implemented features each tagged with its With-Plans "Plan from" gate (88 free, 59 internal, 26 pro, 16 enterprise, 10 team, 10 plus, 1 engine), `ROUTE_GATES` = 292 wired routes, in-memory/SQLite/PostgreSQL stores + migrations, plans service (GET /v1/plans/me with prices from config, POST /v1/plans/check), gate middleware (401 then 402 plan_required with feature + gate + reason). Tests: `test/plans-engines.test.ts` + `test/plans.test.ts`. Doc: `docs/plans-gates.md`. Commits: 411334b, 94d1bd5, 8059e71 (CI green).

### 2. Implemented feature tags (whole-repository audit, every gate enforced)

- CO-001–CO-080, CO-091, CO-093 and CO-096 — implemented.
- AI-001–AI-086 — implemented. Batches so far: batch 1 = AI-001/002/007/008; batch 2 = AI-009 + AI-010; batch 3 = AI-011 + AI-012; batch 4 = AI-015 + AI-016 (preference tuning pipelines and distillation, pure engines + in-memory session state, CI green at a10c2a1); batch 5 = AI-018 + AI-084 (experiment tracking; long-running tasks with checkpoints and resume, pure engines + in-memory session state, CI green at a4b7d30); batch 6 = AI-085 + AI-086 (per-task budgets with named honest breaches; self-critique pass before presenting results, pure engines + in-memory session state, CI green at 86fd849). Partials batch C1 = CO-091 + CO-093 (health/readiness registered internal; shared-store rate limiter — one atomic upsert per attempt, kernel migration v3, PlansService gateway wiring, native PostgreSQL concurrency proof in the CO focused workflow — CI green at 6029744). Every feature shipped complete: engine + oracle tests + functional tests + feature doc.
- TQ-001–TQ-040 — implemented.

### 3. NOT implemented (nobody has built these)

- AI-087–AI-150 and TQ-041–TQ-120 — not started.
- Partially implemented rows (owner reminder, audit of 11 Nov 2026, updated after batch C3): CO-091, CO-093, CO-030, CO-063, CO-064 and CO-065 are NOW complete (C1 health/rate-limit at 6029744, C2 acceptance records at 809446c, C3 transactional outbox — src/kernel/outbox.ts, the outbox row joins the event's transaction on every store, at-least-once delivery with persisted attempts, bounded backoff, dead-letter and explicit replay, kernel migration v4 — at 54e5486, all CI green). CO-076 and CO-096 are NOW complete (C4 at 0443271: AnchorStore + R2 SigV4 adapter + tamper-evidence report in src/kernel/anchor-store.ts, anchor-r2.ts, tamper-report.ts; off-site upload manifest with receipt verification in src/kernel/backup-offsite.ts; CI #957 green). No C-range partials remain; the lane returns to AI batches (batch 7 = AI-087 + AI-088).
- Everything in Part 02 (DP / OB / CG / RV / BD / SC) — not started on mistral.

### 4. Plan hooks retrofit — BATCH A BUILT (10–11 Nov 2026, CI green at 548dc32)

Hooks 1, 2/2b, 3, 4, 5, 6 and 7 are now live on mistral: subscriptions as a list (one active base plan + any engine passes), canUse as the only access check (every gated route asks it; feature_off → 503), the append-only tagged credit ledger (balances are computed sums, spends atomic, engine pool first then general), the pass catalog as config (EMPTY until the owner sets prices), per-feature switches, the HMAC-verified idempotent payment webhook (POST /v1/payments/event, GET /v1/credits/me), and whole-number money throughout. Engine law: ten engines (painting, manhwa, music, voice, audio, video, film, 3d, games, writing) with display names; engine rows are NEVER locked — unpaid engines run at free level (40 credits/5h, 600/month). Only implemented engine row: TQ-027 → manhwa/3d/music. Doc: docs/plans-hooks.md. Hooks 8, 9, 11, 12, 14 and 16 are BUILT in batch B (11 Nov 2026, CI green at 5e920bf): the country table (engine/country-registry-engine.ts), signed access snapshots (access-snapshot-engine.ts), the basic admin console (admin-console-engine.ts, allowlist FORGE_ADMIN_USERS, empty until the owner names admins), promotions as one model (promotion-engine.ts), gateway rate limits (rate-limit-engine.ts, FORGE_RATE_LIMITS, disabled until set), and export/delete my data (account-data-engine.ts) — six pure engines + oracle tests, ~14 service methods, 13 new routes, gate-middleware wiring. Catalogs, allowlists and rate limits stay EMPTY until the owner sets them. The Postgres billing adapter has no main-CI coverage (same as the other PG adapters).

### 5. Rules for every lane

- Read `src/modules/plans/engine/feature-gates.ts` and `docs/PROGRESS.md` before building anything. Do not rebuild implemented rows.
- Max 2 features per batch. Every feature ships complete: engine + oracle tests + functional tests + stores + migration + service + routes + docs, with its gate written in the same batch.
- Engines are pinned law — never modify a shipped engine; verify byte-level before touching product code.
- Registry honesty: a summary in this file (or any lane's summary) is NOT evidence. Feature status promotes only on the per-feature source/test/migration evidence recorded in docs/PROGRESS.md. When the two disagree, PROGRESS.md wins and the gap is shown to the owner.

