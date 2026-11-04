# Build & CI engine — design and evidence

Scope: BD-001, BD-016, BD-017, BD-029 and BD-030. This document records the domain-layer decisions and explicitly separates working code from integrations that still need wiring.

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
10. **Authorization at the service boundary.** Create, rollback, dry-run and trigger each require an authorization decision scoped to workspace, pipeline, actor and action. Routes must still authenticate the actor and pass a trusted identity.
11. **Untrusted source boundary.** Fork and untrusted pull-request code must not receive deployment credentials or privileged secrets. Actual worker execution must use isolated, short-lived workers and deny-by-default task permissions.

## Feature mapping

| Catalogue ID | Implemented domain layer | Evidence |
|---|---|---|
| BD-001 | Definition schema, strict validation, bounded params and stable DAG ordering | `pipeline.ts`, validation/DAG tests |
| BD-016 | Push, PR, schedule, event, manual and API types; schedule identity; branch/path filters; trigger receipt and idempotency | `pipeline.ts`, `store.ts`, trigger tests |
| BD-017 | Safe condition AST, path filters and ordered positive/negative glob rules | `pipeline.ts`, filter/condition tests |
| BD-029 | Side-effect-free dry-run plan with reasons and dependency skip propagation | `pipeline.ts`, dry-run tests |
| BD-030 | Immutable content-hashed snapshots, persistent version history and append-only rollback | `migrations.ts`, both store adapters, rollback tests |

## Deliberate limits in this slice

- Cron accepts a numeric five-field subset: wildcards, integers, ranges, comma lists and numeric steps. Names such as `MON`/`JAN`, macros such as `@daily`, and provider-specific extensions are rejected rather than misinterpreted.
- Globs support `*`, `**`, `?` and ordered `!` exclusions/re-inclusions. Brace expansion and character classes are not supported.
- The module creates durable queued run records, but does not yet execute registered task handlers.
- Provider webhook signature verification, scheduler delivery, authenticated HTTP routes, event-bus integration, worker isolation, task permissions, logs/artifacts, cancellation/retry execution and deployment are not included in this domain slice.
- `src/app.ts`, `src/main.ts` and shared startup/database wiring remain under the maintainer's ownership; the module is not yet wired into the composition root or startup migration sequence.
- SQLite tests have been executed. A real PostgreSQL integration test is included and runs when `FORGE_TEST_POSTGRES_URL` is configured. It has not been run in this environment. The SQLite compatibility harness is not proof of PostgreSQL DDL, transaction locking or concurrency semantics.

## Research references

- Tekton Pipeline task dependencies and DAG execution: https://tekton.dev/docs/pipelines/tasks/ and https://github.com/tektoncd/pipeline/blob/main/docs/pipelines.md
- Buildkite dependency and skipped-step behavior: https://buildkite.com/docs/pipelines/configure/depends-on
- GitHub Actions ordered positive/negative path filters and branch/path filter interaction: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
- CloudEvents event identity uses source plus ID: https://github.com/cloudevents/spec
- OWASP CI/CD Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html
- GitHub guidance on securely using `pull_request_target`: https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target
