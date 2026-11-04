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
- `gpt-part2-build-ci`: webhook processor implementation at `9af476fb31e0abd5a1f3d07a9404bcf13d35e704` (documentation updates follow).
- `mistral`: `fdde1f062496d2ef0c5cf6746b9164240f7af8bd`.
- `claude`: `c2c8ac99013f5012091843927a9f032ccfbeed0f`.
- `main`: `ec6716fb5ba6c42e940b748581990df9194a2a2b`.

GitHub Actions run `41813260566` on webhook processor commit `9af476fb31e0abd5a1f3d07a9404bcf13d35e704` succeeded. Dependency installation, typecheck, production build, and the complete test suite against real PostgreSQL all passed: 176 tests, 0 failures, 0 skipped. This run includes SQLite processor success/retry tests and real PostgreSQL processor dispatch/run persistence. Earlier run `41813153861` on `c32d85c7d8653f3cb38cff9a279f2a207639bf4a` also passed all 176 tests.

## Accurate BD-016 state

Implemented:
- Typed trigger model and matching; schedule identity; branch/path filters; idempotent queued-run persistence; authenticated manual/API trigger routes.
- GitHub HMAC-SHA256 and GitLab Standard Webhooks signature verification against raw request bytes.
- Provider event normalization and trusted connection/repository binding.
- Durable, deduplicated webhook receipt persistence in SQLite and PostgreSQL.
- Webhook routes register only when a trusted connection resolver is injected; default composition fails closed.

Not implemented:
- Production secret/integration resolver wiring.
- Autonomous worker hosting/polling, operational replay controls and production secret/integration resolver wiring.
- Scheduler dispatch, timezone/DST occurrence identity and catch-up/recovery policy.
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

1. Verify the latest documentation-only commits with GitHub Actions.
2. Implement DB-backed schedule dispatch, stable schedule occurrence IDs, timezone/DST behavior and catch-up/recovery policy for BD-016.
3. Specify the execution adapter contract against the Mistral Task Runtime and Orchestrator public APIs without changing `mistral`.
4. Resolve branch integration strategy before wiring task execution; do not create duplicate worker/runtime infrastructure.
5. Continue implementation only within the five approved feature IDs, then test both SQLite and real PostgreSQL, including replay/idempotency, concurrency, cross-workspace denial, malformed events, recovery, and worker isolation where applicable.
6. Do not mark a feature accepted until independent verification and owner acceptance.


## Candidate dry-run test evidence

Commit `cc000ed1c6062184928864f402f93a4b0d998d4d` adds a service-level test for an unsaved candidate definition. It verifies a valid candidate produces a dry-run plan, writes neither a pipeline version nor a run, denies an unauthorized actor, and rejects an invalid definition. The candidate route and service were already implemented; the new test closes a test-coverage gap. The subsequent full CI run `41812055280` passed all 173 tests against real PostgreSQL.

## Execution integration boundary — read-only Mistral inspection

The public Task Runtime contract currently exposes `TaskRuntimeService.createTask(userId, goal)`; its `TaskRunRecord` is user-owned and stores goal/state/events, not workspace ID, pipeline ID/version, registered task reference or Build & CI run identity. Its event journal and task-control engines are for AI task lifecycle, not a generic CI queue. The Orchestrator persists user-owned plans and offers planning, tool-selection and sandbox verdicts; it is not a CI dispatcher. Therefore neither module is currently a safe drop-in worker for Build & CI. Do not encode CI definitions into free-text task goals, duplicate the modules, or modify the `mistral` branch. Any future integration needs an explicit workspace-scoped adapter contract and an owner-approved branch integration strategy.

## Catalogue scope boundary

The user-approved batch remains BD-001, BD-016, BD-017, BD-029 and BD-030 only. BD-026 (priority/fair queue scheduling), BD-041 (long-running jobs with checkpointing), BD-048 (pipeline notifications and approvals), and BD-057 (scheduled maintenance jobs) are adjacent catalogue items, not silently included in this batch. BD-016 may process verified trigger deliveries and create idempotent queued pipeline runs; it does not authorize building those separate products.

## Webhook delivery processor — verified implementation

Code commit: `9af476fb31e0abd5a1f3d07a9404bcf13d35e704`.

- `PipelineStore` adapters expose the latest pipeline versions in a workspace.
- `BuildCiService.triggerWorkspaceEvent` dispatches an event to those pipelines through the normal `trigger` service method, preserving per-pipeline authorization and idempotency.
- `WebhookConnection` now carries a trusted `actorId` supplied by the integration/secret subsystem. The processor re-resolves it at execution time and rejects inactive, changed, cross-workspace or cross-repository bindings.
- `WebhookDeliveryProcessor.processNext(workerId)` claims one delivery, queues matching runs, completes the lease, and uses bounded exponential retry on processing failures. It does not execute steps.
- The app exposes `webhookProcessor` only when `webhookConnections` is injected. There is no autonomous polling host yet.
- CI run `41813260566`: typecheck passed, production build passed, 176 tests passed, 0 failed, 0 skipped, including the real PostgreSQL processor integration test.
- Remaining BD-016 work: DB-backed schedule dispatcher and timezone/DST occurrence handling. Pipeline task execution remains a separate integration design; do not route CI work through Mistral free-text task goals.
