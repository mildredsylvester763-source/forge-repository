# Build & CI continuity checkpoint — 2026-11-04

Repository: `mildredsylvester763-source/forge-repository`
Working branch: `gpt-part2-build-ci`
Approved catalogue scope: BD-001, BD-016, BD-017, BD-029, BD-030.

## Branch protection / ownership rules

- Keep `main` untouched.
- Treat `mistral` and `claude` as read-only.
- Keep GPT changes on `gpt-part2-build-ci`.
- No merges, cherry-picks, deployment, or changes to another branch without the owner's explicit approval.

## Verified branch state

At inspection, branch heads were:
- `gpt-part2-build-ci`: `b64bf4c4a139d42ff608d2e72025a9558feb0a6e` (subsequently advanced by documentation-only commits).
- `mistral`: `fdde1f062496d2ef0c5cf6746b9164240f7af8bd`.
- `claude`: `c2c8ac99013f5012091843927a9f032ccfbeed0f`.
- `main`: `ec6716fb5ba6c42e940b748581990df9194a2a2b`.

GitHub Actions run `41803937752` on GPT commit `b64bf4c4a139d42ff608d2e72025a9558feb0a6e` succeeded. The job steps included dependency installation, typecheck, production build, and the complete configured test suite against real PostgreSQL. Do not infer a test count from the green status. A later documentation commit run `41810771907` also succeeded on `4b104cafbc31afe845174a6ad7f1311880995e58`. The most recent market-research documentation commit must still receive its own CI run before being called verified.

## Accurate BD-016 state

Implemented:
- Typed trigger model and matching; schedule identity; branch/path filters; idempotent queued-run persistence; authenticated manual/API trigger routes.
- GitHub HMAC-SHA256 and GitLab Standard Webhooks signature verification against raw request bytes.
- Provider event normalization and trusted connection/repository binding.
- Durable, deduplicated webhook receipt persistence in SQLite and PostgreSQL.
- Webhook routes register only when a trusted connection resolver is injected; default composition fails closed.

Not implemented:
- Production secret/integration resolver wiring.
- Delivery worker claiming/leases, processing, bounded retries, terminal/dead-letter state transitions, and replay operations.
- Mapping verified webhook receipts to matching pipeline runs.
- Scheduler dispatcher, timezone/DST catch-up policy, and schedule occurrence leasing.
- Event bus publication and operational delivery monitoring.

**A webhook HTTP 202 currently means verified receipt persisted. It does not mean a pipeline run was created or executed.** The delivery store currently supports enqueue/read; it has no claim/process worker.

## Read-only Mistral architecture findings

- Task Runtime exposes user-owned task runs, append-only task event journals, replay, state/approval/parallel-conflict engines and authenticated user routes. Its current store is keyed by user ownership and is not a generic CI job queue.
- Orchestrator provides intent classification, planning, preview, tool selection/handoff and sandbox verdicts. It is not currently a CI worker dispatcher.
- Identity provides user authentication and sessions, but does not itself prove workspace membership.
- GPT Build & CI currently reads persisted workspace membership records and applies deny-by-default role permissions. Membership lifecycle belongs to the workspace/permissions domain.
- Do not duplicate Task Runtime or Orchestrator. Define a narrow execution adapter and only integrate after the owner approves the branch integration approach.

## Research update

`docs/BUILD_CI_MARKET_RESEARCH.md` now records current official GitHub, GitLab, Buildkite and OWASP webhook/CI security guidance. Benchmark findings are not implementation evidence. Remaining requirements must be mapped to exact catalogue IDs before implementation.

## Next sequence

1. Verify the latest documentation commit's GitHub Actions run.
2. Inspect exact catalogue requirements for any remaining BD-016 delivery lifecycle requirements and map each gap to its owning ID.
3. Specify the execution adapter contract against the Mistral Task Runtime and Orchestrator public APIs without changing `mistral`.
4. Resolve branch integration strategy before wiring execution; do not create duplicate worker/runtime infrastructure.
5. Continue implementation only within the five approved feature IDs, then test both SQLite and real PostgreSQL, including replay/idempotency, concurrency, cross-workspace denial, malformed events, recovery, and worker isolation where applicable.
6. Do not mark a feature accepted until independent verification and owner acceptance.
