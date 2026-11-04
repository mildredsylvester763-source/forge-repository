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
- `gpt-part2-build-ci`: latest docs checkpoint `b6dd6a22f31a23528150c0093b47aaa79622706f` (schedule implementation commit `b3d5817f22a04c9c65d928150e1deeac60c9599a`).
- `mistral`: `fdde1f062496d2ef0c5cf6746b9164240f7af8bd`.
- `claude`: `c2c8ac99013f5012091843927a9f032ccfbeed0f`.
- `main`: `ec6716fb5ba6c42e940b748581990df9194a2a2b`.

GitHub Actions run `41814811720` on schedule dispatcher/docs commit `d9ee14b8f9d19dfec68547950a28dbcb1f629da1` succeeded. Dependency installation, typecheck, production build and the complete test suite against real PostgreSQL all passed: 186 tests, 0 failures, 0 skipped. It includes cron-step parsing, trigger pause/resume, timezone/DST, SQLite schedule dispatch and real PostgreSQL concurrent schedule claims. The subsequent documentation-only commits must also pass CI before being treated as the latest verified branch head.

## Accurate BD-016 state

Implemented:
- Typed trigger model and matching; per-trigger enabled/disabled state; schedule identity; branch/path filters; idempotent queued-run persistence; authenticated manual/API trigger routes.
- GitHub HMAC-SHA256 and GitLab Standard Webhooks signature verification against raw request bytes, provider event normalization and trusted connection/repository binding.
- Durable deduplicated webhook receipt persistence, worker leases/recovery, bounded retries and a webhook processor that re-resolves a trusted workspace actor and creates authorized idempotent queued runs.
- Durable schedule occurrences in SQLite/PostgreSQL, deterministic version-bound occurrence IDs, per-workspace scan cursors, lease claims, bounded retries, skipped superseded occurrences and monotonic catch-up scanning.
- Numeric five-field cron with IANA timezone support, explicit day-of-month/day-of-week OR semantics, and tested DST gap/fold behavior.
- Both processors use BuildCiService authorization and idempotent queued-run creation. Neither executes registered pipeline tasks.

Still outstanding:
- Autonomous worker hosting/polling and production secret/integration resolver wiring.
- Event-bus publication, operational replay/dead-letter monitoring and alerting.
- Per-pipeline concurrency groups/overlap serialization.
- Registered task execution, worker isolation, scoped secret delivery, execution state transitions, cancellation, logs and artifacts.

**A webhook HTTP 202 means only that the verified receipt was durably persisted. It does not mean a pipeline run was created or executed.** The scheduler and webhook processor are separate worker-callable services; no autonomous polling loop is installed.

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
2. Specify the workspace-scoped execution adapter contract against the Mistral Task Runtime and Orchestrator public APIs without changing `mistral`.
3. Resolve branch integration strategy before wiring task execution; do not create duplicate worker/runtime infrastructure.
4. Design autonomous worker hosting/polling, production resolver wiring and operational replay/monitoring without expanding into BD-026 queue fairness or BD-041 long-running checkpointing.
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

## Durable schedule dispatcher — verified implementation

Implementation is on the GPT branch; the latest code CI run for the scheduler is 41814811720 (186 passed, 0 failed, 0 skipped). The dispatcher is composed into the app as a workspace-scoped service; it is not an autonomous background worker.

- Migration v6 adds build_ci_schedule_occurrences and build_ci_schedule_scan_cursors in both SQLite and PostgreSQL.
- The scan cursor is monotonic per workspace. Initial lookback defaults to five minutes; subsequent scans default to 1,440-minute batches. Occurrences are persisted before cursor advancement, so crashes cause safe deterministic re-scans.
- Occurrence identity binds workspace, pipeline, trigger, immutable pipeline version and UTC scheduled instant. Claims use SQLite BEGIN IMMEDIATE or PostgreSQL SELECT FOR UPDATE SKIP LOCKED, with lease ownership, bounded exponential retries and terminal failure.
- Numeric five-field cron supports wildcards, integers, ranges, comma lists and numeric steps. Weekday 0/7 maps to Sunday; restricted day-of-month/day-of-week fields use OR semantics.
- Timezone calculation iterates UTC instants and formats them in the configured IANA zone. Spring-forward nonexistent wall times are skipped; fall-back repeated wall times produce two distinct UTC occurrences.
- Per-trigger enabled defaults to true. A new immutable pipeline version can pause/resume a trigger. The dispatcher skips queued occurrences belonging to a superseded pipeline version and does not generate ticks before the active version's createdAt.
- Schedule dispatch calls BuildCiService.trigger, preserving workspace authorization and run idempotency. It only creates queued runs; it does not execute steps. Overlapping occurrences are independently queued; no concurrency group is implemented.
- Tests cover cursor scanning, repeat-scan dedupe, retries after authorization recovery, pause/resume, superseded versions, DST behavior and PostgreSQL concurrent worker claims/dispatch.


## Optional bounded worker host — implementation candidate

- Added `BuildCiWorkerHost` as an optional app-composed poller for the already durable webhook and schedule processors. It supports bounded `runOnce()` and recurring `start()/stop()`; repeated starts and overlapping cycle requests are guarded. Stop prevents another poll and waits for the in-flight processor operation before app storage closes.
- The default poll interval is 5 seconds; each cycle claims at most 25 webhooks, processes at most 100 schedule workspaces and dispatches at most 25 schedule occurrences per workspace. Values are configurable and validated.
- Schedule inventory uses an injected trusted keyset-paginated `ScheduleWorkspaceSource` returning workspace/service-actor pairs. Every occurrence still calls BuildCiService and rechecks authorization. No global actor is invented.
- Database leases remain the cross-process concurrency authority; process-local single-flight only prevents overlapping cycles inside one instance. Abrupt shutdown relies on lease expiry/recovery.
- The app constructs the worker only when `buildCiWorker` is explicitly supplied. It remains stopped unless `autoStart: true` is set. Production workspace inventory and provider secret/integration resolvers are not yet wired.
- Tests cover bounded webhook/schedule draining, workspace pagination, single-flight cycles, graceful shutdown and source pairing. The host only creates queued runs; registered task execution, event-bus publication and operational replay/dead-letter tooling remain outstanding.
