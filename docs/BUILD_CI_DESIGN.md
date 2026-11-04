# Build & CI engine — design and evidence

Scope: BD-001, BD-016, BD-017, BD-029 and BD-030. This document records domain, persistence, authorization and HTTP integration decisions. Market research and detailed product requirements are maintained in `BUILD_CI_MARKET_RESEARCH.md`.

## Design decisions

1. **Declarative task references, not arbitrary code.** A pipeline definition names registered task handlers and supplies bounded JSON parameters. It cannot inject shell commands, JavaScript, dynamic imports or expressions into the control plane.
2. **Dependency graph.** Steps form a directed acyclic graph. Unknown/self dependencies and cycles fail validation. A stable topological plan groups independent steps into parallel levels.
3. **Typed triggers.** Push, pull-request, schedule, generic FORGE event, manual and API are separate trigger kinds. Generic events require an exact dotted event type. Schedules carry an identity, numeric five-field cron expression and IANA timezone.
4. **Conjunctive branch/path filters.** A trigger must pass its branch and path filters. Pull requests use the target/base branch for branch filtering. Ordered positive and negative globs permit exclusions and later re-inclusion.
5. **No silent false negatives.** If a provider cannot supply the changed-file diff, a path-filtered trigger is accepted with an explicit degraded reason, so a required build is not accidentally omitted. A known empty diff or a complete diff with no matching file remains a non-match.
6. **Safe conditions.** Conditional execution uses a bounded JSON AST (`all`, `any`, `not`, `eq`, `in`, `exists`) with own-property path traversal. There is no `eval`.
7. **Pure dry-run.** Dry-run returns the evaluated trigger results, ordered steps, parallel groups, inclusion/skipping reasons and dependency skip propagation. It does not create a run, enqueue work, resolve credentials, deploy or mutate the pipeline.
8. **Immutable version history.** Every save creates a new content-hashed version. Rollback copies a selected historical definition into a new version; it never rewrites history or moves the version number backwards.
9. **Idempotent event receipt.** A trigger receipt is keyed by workspace, pipeline, source and event ID. Duplicate delivery returns the existing run rather than inserting another.
10. **Authorization at the service boundary.** Read, create, rollback, dry-run and trigger each require an authorization decision scoped to workspace, pipeline, actor and action. Authenticated routes derive actor identity from the server-side session; caller-supplied actor IDs are rejected. Workspace membership is read from persisted records and defaults to deny.
11. **Untrusted source boundary.** Fork and untrusted pull-request code must not receive deployment credentials or privileged secrets. Actual worker execution must use isolated, short-lived workers and deny-by-default task permissions.

## Feature mapping

| Catalogue ID | Implemented domain layer | Evidence |
|---|---|---|
| BD-001 | Declarative schema, strict validation, bounded params, stable DAG, typed inputs, immutable template releases, explicit workspace grants/revocation, pinned imports and source provenance. Runtime task-registry compatibility, structured template diff and public catalogue remain missing. | `pipeline.ts`, `templates.ts`, both stores, migrations, `routes.ts`, template/input/route tests |
| BD-016 | Push, PR, schedule, event, manual and API types; per-trigger enable/disable; schedule identity; numeric cron with IANA timezone; branch/path filters; idempotent run persistence; verified GitHub/GitLab ingress; leased webhook processing/retry; and a durable scheduler with per-workspace scan cursors, version-bound occurrence IDs, leases, bounded retries and authorized queued-run creation; an optional bounded worker poller now hosts both processors. | `pipeline.ts`, `cron.ts`, `store.ts`, both stores, `webhooks.ts`, `webhook-ingress.ts`, `webhook-deliveries.ts`, `webhook-processor.ts`, `schedule-occurrences.ts`, `schedule-dispatcher.ts`, migrations, SQLite and PostgreSQL tests |
| BD-017 | Safe condition AST, path filters and ordered positive/negative glob rules; dry-run simulation accepts event fixtures for all trigger kinds | `pipeline.ts`, `routes.ts`, filter/condition tests |
| BD-029 | Side-effect-free dry-run for saved definitions and unsaved candidate definitions, with reasons and dependency skip propagation | `pipeline.ts`, `store.ts`, `routes.ts`, dry-run/route tests |
| BD-030 | Immutable content-hashed snapshots, persistent version history, authenticated history reads and append-only rollback | `migrations.ts`, both store adapters, `store.ts`, `routes.ts`, rollback tests |

## Deliberate limits in this slice

- Cron accepts a numeric five-field subset: wildcards, integers, ranges, comma lists and numeric steps. Names such as `MON`/`JAN`, macros such as `@daily`, and provider-specific extensions are rejected rather than misinterpreted.
- Globs support `*`, `**`, `?` and ordered `!` exclusions/re-inclusions. Brace expansion and character classes are not supported.
- The module creates durable queued run records, but does not yet execute registered task handlers.
- The scheduler persists a per-workspace scan cursor, inserts deterministic version-bound occurrence records before advancing that cursor, and catches up after downtime in bounded scan batches. It interprets numeric five-field cron in IANA timezones; nonexistent spring-forward wall times are skipped and repeated fall-back wall times produce two UTC occurrences. Day-of-month/day-of-week use standard cron OR semantics when both are restricted. Paused triggers are not scanned; a newly saved pipeline version can resume them. Superseded queued occurrences are marked skipped. Workers claim occurrences with leases and bounded retries, then call BuildCiService.trigger so workspace authorization and run idempotency remain in force. The webhook processor follows the same authorization/idempotency boundary. Neither processor executes pipeline steps. Production workspace inventory and provider secret/integration resolver wiring, event-store publication, operational replay/dead-letter monitoring, isolated task execution, task permissions, logs/artifacts, cancellation/retry execution and deployment remain outstanding.
- Workspace membership records and role-based pipeline authorization are wired for SQLite and PostgreSQL. Membership creation/invitation/role-change lifecycle belongs to the workspace/permissions catalogue area and is not implemented here.
- Template versions and template events are append-only. Imports re-check publisher/recipient access under the same database transaction and lock the template/grant rows while saving the imported pipeline.
- Webhook ingress verifies GitHub HMAC-SHA256 and GitLab Standard Webhooks signatures against raw bytes, normalizes supported provider push/PR events, checks the trusted repository binding and persists an idempotent delivery receipt. The injected connection resolver must return a trusted workspace actor as well as the provider binding and signing secret. Without the resolver, routes and processor are not composed. The processor re-resolves that actor at processing time and uses existing workspace authorization; delivery receipts are not treated as pipeline execution.
- Authenticated HTTP routes cover pipeline create/read, version listing/inspection, rollback, saved/candidate dry-run, manual/API trigger, template publish/release, workspace share/revoke, template listing/version inspection and pinned import. GitHub/GitLab signature verifiers, event normalizers, exact raw-body access, a durable idempotent delivery queue and conditional ingress routes exist. Routes and the processor are composed only when a trusted WebhookConnectionResolver is injected; the default app remains fail-closed. The processor is exposed to a worker caller and is not an autonomous background loop. Scheduler dispatch remains outstanding.
- The pipeline-definition creation endpoint has a 300 KiB body ceiling; other routes retain the 16 KiB default. Domain validation caps canonical definitions at 256 KiB.
- Real PostgreSQL verification has run in GitHub Actions. The latest verified run is recorded in `PROGRESS.md`; a passing run validates only the tested behaviour, not the unimplemented execution stack.

## Research references

See `BUILD_CI_MARKET_RESEARCH.md` for the per-feature competitor comparison, capability requirements, settings, workflows, permissions, failure cases, implemented coverage and remaining gaps.


- Tekton Pipeline task dependencies and DAG execution: https://tekton.dev/docs/pipelines/tasks/ and https://github.com/tektoncd/pipeline/blob/main/docs/pipelines.md
- Buildkite dependency and skipped-step behavior: https://buildkite.com/docs/pipelines/configure/depends-on
- GitHub Actions ordered positive/negative path filters and branch/path filter interaction: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
- CloudEvents event identity uses source plus ID: https://github.com/cloudevents/spec
- OWASP CI/CD Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html
- GitHub guidance on securely using `pull_request_target`: https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target

## Scheduled trigger dispatch

- PipelineTrigger.enabled defaults to true. Saving a new immutable pipeline version with enabled=false pauses that trigger; saving a later version with enabled=true resumes it. Already queued occurrences from a superseded version are marked skipped, not executed against stale configuration.
- build_ci_schedule_scan_cursors stores one monotonic UTC-minute cursor per workspace. The first scan starts from a configurable lookback (default five minutes). Later scans continue from the persisted cursor; the default batch is 1,440 minutes and can be called repeatedly to catch up after longer downtime. The cursor advances only after all discovered occurrences have been durably inserted. A crash before cursor advancement causes a safe re-scan because occurrence IDs are deterministic.
- An occurrence identity includes workspace, pipeline, trigger, immutable pipeline version and scheduled UTC instant. This prevents duplicates across repeated scans and concurrent scheduler workers. Occurrences move through queued → processing → dispatched, or skipped/failed; claims use leases and bounded exponential retry. PostgreSQL uses row locking with SKIP LOCKED; SQLite claims inside an immediate transaction.
- Cron supports numeric five-field expressions, wildcards, integers, ranges, comma lists and numeric steps. Weekday 0 and 7 both mean Sunday. When both day-of-month and day-of-week are restricted, matching follows the standard cron OR rule. Names/macros and provider-specific extensions are rejected.
- The scheduler scans UTC instants and formats each in the configured IANA timezone. A nonexistent spring-forward local time produces no occurrence; a repeated fall-back local time produces two distinct UTC occurrences. This policy is explicit and tested.
- The scheduler is workspace-scoped and requires the caller to provide a trusted actor ID. Each queued run is created through BuildCiService.trigger, which rechecks authorization and uses the existing idempotency key. The dispatcher only creates queued run records; it does not execute registered tasks. No autonomous worker host/polling loop is composed yet. Overlapping scheduled occurrences are not serialized by a concurrency group.


## Optional worker host

- `BuildCiWorkerHost` polls the durable webhook and schedule processors. It can run a bounded `runOnce()` cycle for tests/one-shot jobs or `start()` a recurring loop; repeated starts are ignored, and `stop()` aborts further polling and waits for any in-flight operation before app storage is closed.
- Defaults are a five-second polling interval, up to 25 webhook deliveries per cycle, up to 100 schedule workspaces per cycle and up to 25 schedule occurrences per workspace per cycle. Each limit is configurable and validated.
- Schedule workspaces are supplied by an injected trusted, keyset-paginated `ScheduleWorkspaceSource` that returns workspace IDs and their service actor IDs. The worker never invents a global actor; every dispatch still passes through BuildCiService authorization. The source cursor advances between polling cycles so large workspace inventories are not pinned to the first page.
- Multiple processes may run the same host. Database lease/claim operations, rather than process-local locks, arbitrate webhook and schedule work. Abrupt process loss is recovered by lease expiry; graceful `stop()` waits for the current processor operation.
- The app composes the worker only when `buildCiWorker` overrides are provided. It is not auto-started by default; `autoStart: true` is an explicit deployment choice. A configured worker needs either a trusted webhook resolver or both the scheduler and trusted workspace source.
- This host still only produces authorized queued pipeline runs. It does not resolve production provider secrets itself, publish events, execute registered task handlers, or provide task isolation/logs/artifacts/cancellation.
