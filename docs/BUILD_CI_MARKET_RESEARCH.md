# Build & CI market research and product requirements

Status: research baseline for BD-001, BD-016, BD-017, BD-029 and BD-030. This document separates catalogue scope from implementation enhancements. No additional catalogue IDs are approved by this document.

## Market benchmark

| Product | Relevant established capabilities | Design lessons for FORGE |
|---|---|---|
| GitHub Actions | Repository-defined YAML workflows; event triggers; reusable workflows through `workflow_call`; typed reusable-workflow inputs; explicitly mapped secrets; branch/path filters; per-job token permissions; concurrency groups; immutable action references can use commit SHAs | Keep definitions version-controlled and reusable; make inputs explicit; grant least privilege; pin external dependencies; model concurrency deliberately |
| GitLab CI/CD | YAML pipelines; stages and DAG-style `needs`; branch, merge-request, schedule and manual triggers; ordered `rules` using conditions, changed paths and file existence; typed inputs; reusable components discoverable in a catalog and published by version | Treat reusable pipeline components as first-class, documented, tested and versioned artifacts; validate typed inputs before execution; expose why a rule matched |
| Buildkite | Pipeline definitions in version control; dependency-driven steps; dynamic pipeline upload and step dependencies | Support a graph model that is not restricted to linear stages; keep generated plans deterministic and inspectable |

Primary references:
- GitHub workflow syntax, triggers, permissions, reusable workflow inputs and concurrency: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- GitHub reusable workflows: https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
- GitLab pipelines and DAG / trigger behaviour: https://docs.gitlab.com/ci/pipelines/
- GitLab conditional rules: https://docs.gitlab.com/ci/yaml/
- GitLab reusable components and component catalogue: https://docs.gitlab.com/ci/components/
- GitLab typed inputs: https://docs.gitlab.com/ci/inputs/
- Buildkite dependencies: https://buildkite.com/docs/pipelines/configure/depends-on

## BD-001 — Pipeline engine: declarative, versioned, shareable

### User outcome
A workspace can define a pipeline as validated data, inspect its dependency graph, reuse an approved pipeline definition, and preserve exact versions over time. The engine must not execute arbitrary code from a pipeline definition.

### Capability requirements
- Declarative schema with stable pipeline and step IDs, names, descriptions, registered task references, typed parameters, trigger declarations, conditions and dependencies.
- Strict schema validation: reject unknown fields, unsafe object keys, invalid task names, oversized payloads, malformed values, duplicate IDs, unknown dependencies, self-dependencies and cycles.
- DAG planning with deterministic topological ordering and parallel groups.
- Typed reusable inputs with required/default/allowed-value/size constraints. Secrets are references to an authorised secret store, never plaintext pipeline inputs.
- Shareable templates: private workspace template, organisation-approved template, and public/community template only if a future catalogue policy permits it. Sharing must not expose workspace secrets, run history or private repository data.
- Immutable template releases, stable version references, publisher identity, documentation, changelog, compatibility metadata and deprecation state.
- Import/copy or reference a template with explicit pinned version; updates must not silently alter consumers.
- Dependency/task registry compatibility checks before save and again before execution.
- Definition diff and validation feedback before a new version is accepted.

### Workflow
1. Author a pipeline or start from a permitted template.
2. Define steps, task references, inputs and dependencies.
3. Validate schema, task registration, graph and permissions.
4. Preview the DAG and configuration.
5. Save as a new immutable version.
6. Optionally publish a sanitized reusable template release.
7. Consumers import or pin an exact release; upgrades are explicit and produce a new pipeline version.

### Settings and policy
- Visibility and sharing scope; template publisher; supported version; required/optional inputs; input defaults and enums; task capability declarations; deprecation and revocation.
- Only authorised maintainers may edit a workspace pipeline. Only designated publishers may publish shared templates.
- Consumers can use only templates visible to their workspace and tasks their workspace is allowed to invoke.

### Edge cases and security
- A published template is revoked or its publisher loses access.
- An upstream template receives a breaking release.
- An input default changes or becomes invalid.
- A referenced task is removed or its required capability changes.
- Two imported components define colliding IDs.
- A template contains secret-like values or private resource identifiers.
- A malicious contributor attempts arbitrary shell/JS, prototype pollution, graph cycles or dependency confusion.
- Preserve the resolved template digest and source provenance in the pipeline version so later inspection can reconstruct what was used.

### Current FORGE status
Implemented:
- Strict declarative schema, bounded JSON parameters, dependency validation, cycle detection and deterministic DAG planning.
- Typed `string`, `number`, `boolean` and `secret_ref` inputs with required/default/options validation.
- Immutable workspace templates and template releases with publisher identity, source version, changelog and content hash.
- Explicit workspace-to-workspace grants, revocation, accessible-template listing and exact-version import.
- Imported pipeline versions retain template ID, release number, template digest and publisher workspace as provenance. Import access is rechecked and locked inside the same database transaction that creates the pipeline version, preventing a revoke/import race.
- Template release records and template lifecycle events are append-only in both SQLite and PostgreSQL. Events cover creation, release publication, share grant/revocation, import, deprecation and revocation. Grant records retain the revoking actor. Grant revocation does not rewrite template release history.

Security and product boundaries:
- A `secret_ref` is a symbolic workspace-scoped reference such as `workspace.deploy_key`; it is not a secret value. Secret references cannot define defaults or option lists. Actual secret existence/permissions and worker-side resolution remain the secret broker's responsibility.
- `workspace` visibility is private to the publisher workspace. `shared` visibility requires an explicit grant to each target workspace. There is no globally public template catalogue in this implementation.
- Consumers import a pinned release into a new pipeline ID. Publishing a newer release never silently changes an imported pipeline.

Still missing within BD-001:
- Runtime task-registry resolution and compatibility checks; task names currently receive schema/syntax validation but are not yet resolved against Mistral's task registry.
- Structured definition/template diff, compatibility metadata and guided upgrade flow.
- A public/community catalogue or organisation-wide sharing policy; these require a separate visibility/moderation decision and are not enabled by default.

## BD-016 — Triggers: push, PR, schedule, event, manual, API

### User outcome
The same versioned pipeline can be started reliably from supported source events, scheduled occurrences, an authorised person, or an authenticated API client.

### Capability requirements
- Provider adapters for push and pull-request events; verify signatures against raw request bytes before parsing or trusting payloads.
- Event envelope includes provider, source, immutable event ID, received time, repository/workspace binding, commit/ref context and payload version.
- Manual and API triggers use authenticated actors and explicit idempotency keys.
- Schedule definitions include stable schedule ID, cron expression, IANA timezone, enabled/paused state and next occurrence.
- Delivery is idempotent across retries; duplicate provider deliveries return the existing receipt/run.
- Retry transient delivery failures with bounded exponential backoff; persist attempts and terminal failure reason.
- Scheduled execution handles missed intervals, clock drift, DST transitions and overlapping occurrences according to an explicit catch-up/concurrency policy.
- Branch and path filters are evaluated before a run is queued; event mismatch is visible and does not create a run.
- Distinguish user-triggered runs from system/provider-triggered runs in audit metadata.

### Workflow and states
Received → signature verified → normalized → matched/no-match → deduplicated → queued, or rejected/dead-lettered.
Manual/API: authenticated → authorized → idempotency checked → evaluated → queued/no-match.
Schedules: due → occurrence claimed → evaluated → queued/no-match; missed or locked occurrences are recorded.

### Settings and policy
- Enable/disable per trigger, event types, branch/path filters, timezone, schedule, catch-up policy, concurrency group and retry policy.
- Provider secret rotation and multiple active signing keys during rotation.
- Workspace membership controls manual/API actions. Provider identities are not user identities; map verified repository installations to workspace/project bindings.

### Edge cases and security
- Invalid, stale or replayed signatures; body altered after signature verification; secret rotation; webhook burst; duplicate/out-of-order events; provider outage; deleted branch; missing PR diff; DST gap/repeated local time; overlapping schedule.
- Never allow a client to claim a GitHub/GitLab provider source on the manual endpoint. Server assigns the source and event identity; caller idempotency belongs in a dedicated header.
- Do not execute untrusted PR code with privileged secrets or deployment permissions.

### Current FORGE status
Implemented: trigger type definitions and matching; per-trigger enable/disable; schedule identity; numeric five-field cron with IANA timezone; branch/path filtering; idempotent queued-run persistence; authenticated manual/API trigger route; GitHub HMAC-SHA256 and GitLab Standard Webhooks signature verification over raw request bytes; provider event normalization; trusted connection/repository binding; durable deduplicated webhook receipts; leased webhook processing with bounded retry; and a DB-backed schedule dispatcher with per-workspace scan cursors, version-bound occurrence IDs, leased claims, retry/recovery and authorization-controlled queued-run creation. The scheduler explicitly skips nonexistent spring-forward wall times and emits both UTC instants for repeated fall-back wall times. A durable cursor supports catch-up after downtime in bounded scan batches.
Still missing: production secret/integration resolver wiring; autonomous worker hosting/polling; event-bus integration; operational dead-letter/replay and monitoring controls; per-pipeline concurrency groups/overlap serialization; and execution of registered pipeline tasks. Webhook HTTP 202 still confirms verified durable receipt only, not a queued run or execution. The schedule dispatcher creates queued run records only; it is not a task executor.

## BD-017 — Conditional and path-based pipelines

### User outcome
Users can decide which steps run based on safe event context and changed files, without arbitrary code execution or opaque skip behaviour.

### Capability requirements
- Structured expression AST with bounded depth and node count; supported operators documented and versioned.
- Branch/tag/ref, event kind, PR base branch, commit metadata and allowlisted event payload fields.
- File filters support explicit include/exclude ordering, documented glob semantics and bounded changed-file lists.
- Path conditions can apply at pipeline and individual step level.
- Explain each condition and path result with machine-readable reason codes.
- Missing provider diff must produce an explicit degraded state; it must never silently claim no paths changed.
- Validate expressions at save time and evaluate with deterministic, bounded execution at plan time.
- Test condition truth tables and glob edge cases, including leading slash, nested paths, dotfiles, case handling and negative/re-include ordering.

### Market distinction
GitLab's `rules` supports `if`, `changes`, and `exists`, evaluated in order; GitHub supports branch/path filters with ordered negative patterns. FORGE's structured AST avoids arbitrary expression evaluation and can expose a reason trace for every selected or skipped step.

### Current FORGE status
Implemented: bounded safe AST (`all`, `any`, `not`, `eq`, `in`, `exists`), branch/path filters, ordered negative/re-include patterns and explicit missing-diff degraded behaviour.
Remaining: provider adapters must supply trustworthy changed-file data; add compatibility and edge-case tests before broadening glob syntax.

## BD-029 — Dry-run for any pipeline change

### User outcome
Before a pipeline change is saved or run, a user can inspect the expected trigger decision and step plan without executing tasks or creating side effects.

### Capability requirements
- Validate an unsaved candidate definition, not only the latest saved version.
- Compare candidate and current versions; explain added, removed and changed steps/triggers/conditions.
- Simulate representative events: push, PR, schedule, generic event, manual and API.
- Show trigger match/no-match, each condition result, each path result, dependency propagation, parallel groups and final included/skipped status.
- Clearly label unknown inputs, unavailable changed-file diffs, unsupported task metadata and other degraded assumptions.
- Never resolve secrets, start workers, write run receipts, mutate pipeline versions, deploy, or publish artifacts.
- Permission checks must be evaluated without revealing private pipeline definitions to unauthorised users.
- Dry-run output is reproducible for the same immutable definition digest and event fixture.

### Current FORGE status
Implemented: pure dry-run of saved definitions with trigger evaluation, dependency planning and skip reasons. Authenticated route is being added.
Missing: dry-run of unsaved candidate changes and before/after diff; richer scenario fixtures and API contract tests.

## BD-030 — Pipeline versioning and rollback

### User outcome
Every accepted change is immutable and attributable; users can inspect history and restore a previous definition without destroying the audit trail.

### Capability requirements
- Monotonic per-pipeline version sequence; immutable definition and canonical content hash.
- Record author, timestamp, reason/change note, source template/version, schema version and parent version.
- List, inspect and compare versions.
- Rollback creates a new version from the selected historical definition; never overwrite or decrement history.
- Optimistic concurrency control prevents two simultaneous saves from silently taking the same next version.
- Verify stored hash on read; reject corrupted or tampered records.
- Permission boundary for save and rollback; optional protected release/production policy belongs to the appropriate catalogue feature, not an implicit default.
- Preserve version references in every run so an execution is reproducible after later edits.

### Current FORGE status
Implemented: content-hashed immutable versions and append-only rollback snapshots in SQLite/PostgreSQL adapters.
Remaining: concurrent version allocation tests, tamper/hash verification on read, version diff API and route-level tests.

## Cross-feature acceptance gate

A feature is not accepted because its type definitions or unit tests exist. Require:
- catalogue requirement traceability;
- documented market comparison and product decision;
- SQLite and real PostgreSQL tests where both adapters are supported;
- authenticated route tests and cross-workspace denial;
- malicious input, replay/idempotency, concurrency and failure-recovery tests as applicable;
- full typecheck, production build and complete test suite;
- independently inspectable GitHub Actions evidence;
- explicit owner acceptance.

## Scope control

The following are implementation dependencies or future work, not silently completed features: workspace membership lifecycle (owned by workspace/permissions catalogue area), webhook-provider setup, scheduler delivery, event bus, task worker execution, worker isolation, secret broker, logs/artifacts, cancellation/retry execution and deployment. Each must be mapped to its owning catalogue ID before implementation.

### BD-016 — webhook delivery benchmark update (2026-11-04)

Current provider-ingress implementation was checked against current official provider and security guidance:

- GitHub requires validating the HMAC-SHA256 signature against the unmodified request body, keeping the secret server-side, using the delivery identifier to deduplicate, and recommends responding quickly while processing asynchronously. GitHub redelivery retains the same delivery ID. FORGE verifies the raw body and deduplicates by connection plus provider delivery ID; the durable worker/retry/replay lifecycle is still absent.
- GitLab CI/CD supports push, merge-request, scheduled and manual pipeline sources, ordered job rules, and dependency-driven execution. FORGE's current safe condition AST and trigger model intentionally avoid arbitrary expression evaluation, but still need a real scheduler and trusted changed-file provider adapter.
- Buildkite's incoming pipeline triggers accept signed GitHub events and generic webhook requests, expose delivery inspection, and document credential rotation constraints. This reinforces the need for FORGE to provide delivery observability and a rotation/revocation path through the integration/secret subsystem rather than storing signing secrets in Build & CI.
- OWASP webhook guidance recommends constant-time HMAC verification, one secret per webhook, timestamp freshness where the provider supports it, event-ID deduplication, idempotent processing, payload limits, rate limiting, structured logs without full bodies/secrets, and asynchronous queueing. The current ingress covers raw-body signature verification, repository binding, bounded body size, deduplication and durable receipt insertion; freshness/replay controls for provider-specific timestamped signatures, throttling, operational logs/alerts, worker processing and retry/dead-letter controls remain verification or implementation work.

This is a product/security benchmark, not evidence that all listed controls are implemented. Do not mark BD-016 accepted until the outstanding controls are mapped to catalogue scope, implemented where required, and tested.

Additional primary references:
- GitHub webhook signature validation: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- GitHub webhook best practices, delivery IDs and asynchronous processing: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
- GitHub webhook redelivery: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
- GitLab pipeline sources: https://docs.gitlab.com/ci/pipelines/
- GitLab ordered job rules: https://docs.gitlab.com/ci/jobs/job_rules/
- Buildkite incoming pipeline triggers and delivery model: https://buildkite.com/docs/apis/webhooks/incoming/pipeline-triggers
- OWASP Webhook Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Webhook_Security_Cheat_Sheet.html
- OWASP CI/CD Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html


### BD-016 — durable schedule dispatch implementation update (2026-11-04)

The schedule path now has a durable occurrence queue rather than relying on process-local timers:

- A per-workspace UTC-minute scan cursor is persisted. Initial lookback defaults to five minutes; later catch-up work is processed in bounded batches (default 24 hours). The cursor advances only after all discovered occurrences are stored, making crash/retry rescans safe.
- Occurrence IDs bind workspace, pipeline, trigger, immutable pipeline version and scheduled UTC instant. Database uniqueness and leases prevent duplicate claims across concurrent workers. Failed dispatches use bounded exponential retry and terminal failure state.
- Numeric five-field cron supports wildcards, integers, ranges, comma lists and numeric steps. Day-of-month/day-of-week follow standard cron OR semantics when both are restricted; weekday 0 and 7 are Sunday.
- IANA timezone calculation is performed against UTC instants. Spring-forward nonexistent local times are skipped; repeated fall-back local times create two distinct UTC occurrences. This policy is covered by tests.
- Trigger pause/resume is represented by the enabled flag in a new immutable pipeline version. A superseded queued occurrence is skipped rather than being dispatched against stale configuration. Occurrences are not generated before the active pipeline version's creation time.
- The scheduler calls the ordinary BuildCiService trigger method, so workspace authorization and idempotent run creation are rechecked. It does not execute pipeline tasks. A worker host/polling loop, overlap serialization and production operational controls remain outstanding.
- GitHub Actions run 41814529813 passed typecheck, production build and 184 tests against real PostgreSQL. The subsequent pause/resume and cron-step coverage is pending its own full CI run.
