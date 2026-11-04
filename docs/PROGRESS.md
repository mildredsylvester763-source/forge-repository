# Progress, decisions and things to polish

This file is the project's memory. Update it with every change. Nothing the owner has decided should live only in a chat.

## Working rules (from the owner)

1. Research each feature and record its complete requirements and implementation plan before coding. For an explicitly approved feature batch, continue through implementation and verification without asking after every small step. Pause only when scope expands, a material product decision is unresolved, or a security/architecture choice requires the owner's decision.
2. Every correction and decision is recorded, even if it makes the notes long.
3. If a shared file conflicts with something the owner already changed in chat, the chat decision wins. If two documents contradict each other, show both versions side by side and ask which one the owner finally chooses. His documents are mixed up and not well organized.
4. Backend logic belongs to us. Rent only the pipes that cannot reasonably be built: DNS and attack protection, delivery of phone push messages, email delivery, GPUs.
5. Flag features that are risky, wrong or unrealistic as we reach them. Claude may suggest extra features, always shown as suggestions for approval.
6. Algorithm engines (pricing and others) are planned extensively before any code is written.
7. When the owner asks a question and says to wait, answer first and continue only when told.
8. At the very end, name every outside item the owner has to bring (client IDs, keys, accounts), one by one, saying where each one goes. Anything that can be wired into the code is wired by Claude.

## Done

| ID | Feature | Notes |
| --- | --- | --- |
| CO-001 | Email and password sign-in with breached-password checks | Register, sign in, sign out, session check. 129 tests. |

## Partly built (so CO-001 could work)

CO-063, 064, 065, 076 (event envelope, hash-chained audit log, atomic write plus event, tamper check), CO-091 (health and readiness), CO-093 (rate limiting), CO-096 (verified backups, SQLite only), CO-030 (server-side session check). Finish each properly when its section is reached.

## Approved next steps

1. PostgreSQL adapter for accounts, sessions and the audit log. **Built and pushed.** 129 tests pass locally through a SQLite-backed stand-in. First proof against a real PostgreSQL comes from GitHub's automatic checks (workflow file still to be pushed; needs the owner's GitHub approval).
2. SQLite layer pushed with tests as the local-testing backend. **Done.**
3. Nightly backup to Cloudflare R2.
4. Chat endpoint and conversation tables (the first agent).

## Decisions made

- **Language:** TypeScript (strict) on Node 22. The PostgreSQL driver `pg` is the only outside dependency so far. (ADR 0001)
- **Production database:** PostgreSQL through Supabase, used as plain Postgres. Not Supabase's login system, because we built our own. SQLite is only for development and tests; production refuses it.
- **Backend logic belongs in the app:** no vendor login, functions, SDK or business rules in the database. The database holds only constraints and an append-only guard.
- **Supabase not connected yet.** Every feature adds numbered migrations to the repository; the first start against a real database applies them all.
- **Files:** Cloudflare R2. Model weights and datasets live there, never in the database.
- **Agents:** run on Google Cloud Run.
- **Job queue:** proposed to build on a Postgres table instead of Cloud Tasks or Pub/Sub. Not yet confirmed.
- **Front end:** proposed web app that installs on a phone (PWA). Real phone apps can follow later with no backend change.
- **Notifications:** build the engine ourselves. First in-app notifications and browser push. Add Firebase Cloud Messaging only when a phone app exists.
- **Feed:** same Postgres at first, in its own tables. Split into a separate database only when traffic proves it is needed. Uploads should have no limits or very generous ones, to be planned when the feed is built.
- **AI memory:** limited, not unlimited long-term storage. Expiry, compression into summaries, and the user can see and delete what is remembered.
- **AI learning:** it learns in an isolated sandbox and only verified material is absorbed. Sources: real users' manhua artwork (strokes and edits), uploaded pictures, uploaded manhua. Fine-tuning on GPUs, starting from an existing model. Consent, memorization checks and rollback are required. Users who agree to share data get a bonus (around 50% more usage was suggested).
- **Suggestion pop-ups:** when a user does something related to a feature they may not know about, the app asks whether they want to use it. Needs a frequency cap and a "don't ask again" choice. Close to catalog item AI-147.

## Pricing engine (to be planned extensively, not coded yet)

- A credit has a money value: about $0.02 to $0.04. Suggested starting point: $0.03.
- Each kind of output (manhwa page, painting, animation, video, coding task, ...) is its own product with a cost recipe. Effort means real compute and real provider charges.
- Price in credits = real cost of the chosen model x margin x any adjustments, converted at the credit value. Every model has its own row in a versioned price list. New models add rows; old quotes never change.
- Demand and supply: prefer a cheaper "slow lane" at quiet times over surge pricing. Any adjustment is capped and always shown before the user confirms.
- Show a quote and ask for confirmation. Reserve the credits, then settle at the real cost and refund the difference. Refund failed jobs.
- Coding tasks: estimate plus a cap, stopping at the cap.
- Free tier: small monthly credit allowance, one tiny video trial, and a global monthly ceiling on all free spending.
- Free video is a monthly pool of seconds, started very low. Outside video AI costs roughly $0.03 to $0.70 per generated second, so numbers wait for a chosen provider.
- The owner will supply the pricing algorithms. Which features are paid and in which tier is decided later. No prices are invented before then.
- Check prepaid-credit rules (refunds, expiry) before launch.

## Outside items the owner will bring (named one by one at the end)

Running list, to be confirmed at the end:

- Supabase project and its connection string (`FORGE_DATABASE_URL`).
- Cloudflare account and R2 keys (account ID, access key ID, secret, bucket).
- Google Cloud project for Cloud Run. Separate from that: a Google sign-in client ID and secret, which come from the Google Cloud console credentials page, if Google sign-in (CO-003) is built.
- GitHub sign-in app (client ID and secret) and Apple sign-in keys, if those sign-ins are built.
- An email delivery provider key (verification and password reset emails).
- Keys for outside AI providers (image, video, coding) once chosen.
- A domain name, when budget allows.
- Firebase Cloud Messaging service account, only once a phone app exists.
- Enterprise single sign-on details (CO-004), per customer, later.

Generated by us, not brought: the password pepper and audit key (`openssl rand -base64 32`), browser push keys.

## Polish later (do not forget)

- Usage and pricing algorithms: the owner will provide them. Polish when reached.
- Exact free video numbers.
- Tenant isolation (CO-017 says row-level security): decide whether app-code-only is enough or database row security is added as a second lock.
- Commit `package-lock.json` after the first `npm install` (pins the `pg` dependency).
- Confirm the first real-PostgreSQL run in GitHub's checks is green.
- Email verification, password reset and recovery (CO-008). Registration currently reveals duplicate emails.
- Encryption at rest for the database and backups (CO-018).
- Off-site backups and automated PostgreSQL backups.
- Anchor the audit chain's latest hash outside the database so deleting the newest events cannot go unnoticed.
- Spending alerts and hard limits on every cloud account.
- Content moderation for user videos, and a clear "not a real lawyer" notice on the lawyer agent.
- Compare what free users get from other assistants (ChatGPT, Mistral, Meta AI and others) when deciding FORGE's free tier. A first look is in the chat history; sources disagreed.

## Risky or unrealistic features flagged so far

- AI-013 training a model from scratch: extremely expensive. Use an existing model.
- CO-100 offline sync with conflict resolution: one of the hardest features to get right.
- TQ-020 real device farm: needs physical phones.
- Learning from users' artwork and writing: needs opt-in consent, withdrawal, and memorization tests.
- Rewards for data sharing: some privacy laws look closely at consent tied to rewards. Get legal advice.

## Catalog checklist (Part 01)

| Range | Section | Status |
| --- | --- | --- |
| CO-001 | Identity: email and password | done |
| CO-002 to CO-014 | Identity: passkeys, social, SSO, MFA, sessions, recovery, tokens | not started |
| CO-015 to CO-028 | Workspaces and tenancy | not started |
| CO-029 to CO-044 | Permissions and policy | not started |
| CO-045 to CO-062 | Project intelligence graph | not started |
| CO-063 to CO-080 | Event backbone and audit ledger | partly built |
| CO-081 to CO-090 | Context engine | not started |
| CO-091 to CO-100 | Platform reliability | partly built |
| AI-001 to AI-150 | FORGE AI | not started |
| TQ-001 to TQ-120 | Testing and quality | not started |

The full app spans up to about 30 files of features. Part 01 is only one of them.


## Part 02 — Build & CI (GPT branch: `gpt-part2-build-ci`)

Approved first batch: BD-001, BD-016, BD-017, BD-029 and BD-030. Research each as a complete product capability before implementation. Do not add unrelated catalogue IDs without approval.

### Latest verified checkpoint — 2026-11-04

Branch: `gpt-part2-build-ci`
Latest verified commit: `d9ee14b8f9d19dfec68547950a28dbcb1f629da1`
Successful GitHub Actions run: https://github.com/mildredsylvester763-source/forge-repository/actions/runs/41814811720

- Typecheck: passed.
- Production build: passed.
- Complete test suite against real PostgreSQL: 186 tests, 186 passed, 0 failed, 0 skipped.
- This run includes numeric cron-step expansion, paused/resumed schedule behaviour, SQLite scheduler tests and real PostgreSQL concurrent schedule claims/dispatch.

### Feature status

| ID | Current status | Remaining catalogue scope / integration |
|---|---|---|
| BD-001 | Declarative schema, typed inputs, immutable versions, controlled workspace template publishing/sharing/revocation, pinned import, source provenance and append-only lifecycle audit implemented | Runtime task-registry compatibility, structured template diff/upgrade flow and any public/global catalogue policy |
| BD-016 | Trigger model, pause/resume, branch/path matching, durable timezone-aware schedules, verified GitHub/GitLab ingress, leased delivery processing, bounded retry, redacted failure persistence, dead-letter inspection/replay, append-only replay audit, workspace-authorized provider connection create/list/rotate/revoke APIs and immutable lifecycle audit implemented on GPT branch | Concrete vault/KMS adapter and provisioning/retirement workflow, production delivery identity/service-principal policy, event-bus publication, production worker/workspace-inventory wiring, per-pipeline concurrency controls and execution of registered pipeline tasks; continuation changes await CI verification |
| BD-017 | Safe condition AST, branch/path filters, ordered include/exclude rules and explainable dry-run evaluation implemented | Real provider changed-file adapters and broader compatibility/edge-case test matrix |
| BD-029 | Saved and unsaved candidate dry-run service/API; candidate definitions remain unpersisted. Candidate responses now include baseline/candidate hashes and a value-free structural diff. Saved-version diff service and authenticated HTTP endpoint report added/removed/changed triggers and steps, root fields and ordering. Unit, service and route regression coverage added. | Richer scenario fixtures/reporting and full CI verification; owner acceptance remains outstanding |
| BD-030 | Immutable content-hashed versions, authenticated version reads/listing, append-only rollback and saved-version diff implemented. Both adapters recompute hashes on reads; SQLite/PostgreSQL corruption tests and PostgreSQL concurrent save/rollback allocation tests added. | Full CI verification, independent verification and owner acceptance remain outstanding |

### Supporting security and integration work

- Persisted workspace membership readers exist for SQLite and PostgreSQL.
- Pipeline permissions are deny-by-default and role-based. The actor comes from the authenticated server session, never a caller-supplied actor ID.
- Membership lifecycle management is not added here; it belongs to the workspace/permissions catalogue area. No public endpoint can grant a user membership or promote their own role.
- Authenticated routes are registered in `src/app.ts`: pipeline create/read/history/rollback/dry-run/trigger plus template publish/version/share/revoke/list/import. The create endpoint alone receives the larger body budget needed for bounded pipeline definitions; other endpoints retain the default request limit.
- Template visibility is publisher-workspace-only or explicit named-workspace sharing. There is no global public catalogue. Imports pin an exact release, preserve template digest/publisher provenance, and re-check access under database locks in the same transaction as the import.
- Template lifecycle audit is append-only; creation, release publication, grants/revocations, imports, deprecation and revocation are recorded. Publisher and previously granted recipient workspaces see only their permitted event history.
- Typed `secret_ref` inputs are symbolic workspace-scoped names only; no secret material is stored or resolved by this layer. The secret broker/worker integration remains outstanding.
- GitHub and GitLab ingress routes use a trusted connection resolver. Signature verification, repository binding, duplicate-delivery protection, durable queue insertion, leased asynchronous processing, bounded retries and terminal dead letters are implemented. The processor re-resolves the active connection and delivery actor, rechecks trigger authorization through `BuildCiService`, and persists idempotent queued pipeline runs. Dead-letter list/history/replay operations are authenticated, workspace-scoped and payload-minimized; only owner/admin/maintainer can replay, with append-only audit records. Provider connection management exposes workspace-authorized create/list/secret-reference rotation/revoke/history routes only when `providerSecrets` is supplied. The authenticated creator and selected trigger-authorized delivery actor are stored separately. Secret references are workspace-namespaced, path-validated and never returned or written as signing-secret material. Provider connection lifecycle changes are audited transactionally in SQLite/PostgreSQL. The default app registers neither provider-management routes nor webhook ingress unless the external secret resolver is configured; the worker remains opt-in. HTTP 202 means a verified delivery was queued, not that pipeline tasks executed.
- Mistral's Task Runtime and Orchestrator remain on the `mistral` branch. Do not duplicate them or modify that branch. Worker integration requires a deliberate branch integration decision.

### Still outstanding before these features can be accepted

1. Complete BD-001 task-registry compatibility, structured definition/template diff and upgrade flow; decide whether a public/global catalogue is in scope.
2. Supply and integrate a concrete vault/KMS adapter plus provisioning/retirement workflow; decide the production service-principal/delivery-actor strategy; complete event-bus publication, production worker/workspace-inventory configuration, per-pipeline concurrency controls and registered task execution for BD-016. Provider connection lifecycle APIs and dead-letter operations are implemented on the GPT branch but await full CI verification.
3. Connect trusted provider changed-file data to BD-017 and test all documented glob/condition semantics.
4. Add richer representative scenario fixtures/reporting to BD-029 and verify candidate diffs remain side-effect-free under the complete CI suite.
5. Run full CI for the new version-diff, hash-integrity and concurrent PostgreSQL save/rollback coverage; independently inspect the results before acceptance of BD-030.
6. Integrate registered tasks with the existing Task Runtime/Orchestrator without duplicating those modules.
7. Add worker isolation, scoped secret delivery, execution state transitions, cancellation/retries, logs and artifacts only where they map to approved catalogue requirements.
8. Run the full real-PostgreSQL CI suite after every integration batch; inspect logs and security tests rather than treating a green badge as acceptance.
9. Independent verification and owner acceptance remain outstanding for all five IDs.

Detailed market and product requirements: `docs/BUILD_CI_MARKET_RESEARCH.md`.
API contracts: `docs/BUILD_CI_API.md`.


### 2026-11-04 correction — candidate dry-run evidence

The earlier chat statement that the detailed design document was outdated was incorrect. The current design document, API contract, route and service all describe and implement both saved and unsaved candidate dry-runs:
- `POST /v1/build-ci/pipelines/dry-run` accepts exactly one of `pipelineId` or `definition`.
- Candidate requests call `BuildCiService.dryRunDefinition`, which validates the definition, authorizes the dry-run against the candidate pipeline ID, and invokes the pure planner without saving a version or creating a run.
- A new service-level test was committed as `cc000ed1c6062184928864f402f93a4b0d998d4d`; CI for that commit must pass before the test is considered verified.
- Remaining BD-029 gaps are candidate-vs-current structured diff, scenario fixtures/reporting, and HTTP route-level side-effect/authorization coverage. Do not describe candidate dry-run itself as missing.


### 2026-11-04 execution-boundary clarification

The Part Two catalogue keeps BD-016 trigger types separate from adjacent capabilities: BD-026 is queue priority/fair scheduling; BD-041 is long-running jobs with checkpointing; BD-048 is pipeline notifications/approvals; BD-057 is scheduled maintenance jobs. The approved batch remains only BD-001, BD-016, BD-017, BD-029 and BD-030. BD-016 delivery processing may claim verified provider receipts and create idempotent queued pipeline runs; it must not silently grow into queue fairness, checkpointed long-running execution, or notification/approval products.

Read-only Mistral API inspection confirms its current Task Runtime is not a drop-in CI worker: `TaskRuntimeService.createTask(userId, goal)` creates a user-owned run; `TaskRunRecord` is keyed by `userId` and contains goal/state/events, with no workspace, pipeline/version, registered task reference, or build-run identity. Its event journal and task-control engines serve AI task lifecycle, not generic pipeline job dispatch. The Orchestrator similarly persists user-owned plans and provides planning/tool-selection/sandbox verdicts, not a CI dispatcher. Do not pass CI jobs through these APIs by encoding them into free-text goals, and do not duplicate either module. Any execution integration needs a deliberate architecture/branch decision and an explicit workspace-scoped adapter contract; no Mistral files have been modified.

### 2026-11-04 webhook processor implementation and verification

- Added `WebhookDeliveryProcessor` on `gpt-part2-build-ci`. It claims due deliveries using the existing atomic lease store, re-resolves the trusted provider connection at processing time, verifies that the provider/connection/workspace/repository still match the persisted receipt, and requires a trusted workspace actor from the integration resolver.
- The processor dispatches the normalized event across the workspace's latest pipeline versions through `BuildCiService.triggerWorkspaceEvent`. Each pipeline trigger is re-authorized at the service boundary. Matching runs are persisted through the existing per-workspace/pipeline/source/event idempotency key; partial processing followed by retry therefore does not create duplicate runs.
- Failures use bounded exponential retry and transition to terminal `failed` after the configured attempt limit. Lease loss is reported without allowing a stale worker to complete or fail another worker's claim.
- SQLite processor tests cover successful run creation/idempotent receipt completion and unavailable-connection retry. The real PostgreSQL integration suite also exercises workspace pipeline enumeration, processor dispatch, and queued run persistence.
- Verified commit: `9af476fb31e0abd5a1f3d07a9404bcf13d35e704`. GitHub Actions run `41813260566` passed typecheck, production build, and all 176 tests with 0 failures and 0 skips, including the real PostgreSQL integration suite: https://github.com/mildredsylvester763-source/forge-repository/actions/runs/41813260566
- This is not pipeline execution. The processor creates queued run records only; no registered task handler is invoked. It is exposed by app composition when a trusted resolver is supplied, but an autonomous worker host/polling loop and production secret/integration resolver are still outstanding. The separate schedule dispatcher is implemented and verified.

### 2026-11-04 durable schedule dispatcher implementation

- Added migration v6 to SQLite and PostgreSQL: durable schedule occurrences with deterministic IDs, per-workspace scan cursors, lease metadata, attempts, retry time, terminal failure, skipped state and dispatch timestamp.
- Added numeric five-field cron parsing and IANA timezone occurrence calculation. Day-of-month/day-of-week use standard cron OR semantics when both are restricted; weekday 0 and 7 mean Sunday. Spring-forward nonexistent local times are skipped; fall-back repeated local times create two distinct UTC occurrences.
- Added per-trigger enabled state (defaults to enabled). Pausing/resuming is an immutable pipeline-version change. New versions do not retroactively generate occurrences before their creation time; pending occurrences from superseded versions are marked skipped.
- Schedule scans use a durable monotonic UTC-minute cursor. Initial lookback defaults to five minutes; subsequent catch-up scans default to 1,440-minute batches. Occurrences are persisted before cursor advancement, so a crash causes safe re-scanning and deterministic deduplication.
- Workers claim occurrences using SQLite immediate transactions or PostgreSQL row locks with SKIP LOCKED. Dispatch calls BuildCiService.trigger, preserving workspace authorization and the run idempotency key. Failures receive bounded exponential retries. This creates queued runs only; it does not execute pipeline steps.
- The scheduler is exposed from app composition as a workspace-scoped worker service. There is no autonomous polling/worker host yet; the caller must provide a trusted workspace actor. Overlapping occurrences are independently queued; no concurrency-group serialization is implemented.
- Final verification: commit `d9ee14b8f9d19dfec68547950a28dbcb1f629da1`; GitHub Actions run `41814811720` passed typecheck, production build and all 186 tests against real PostgreSQL (0 failures, 0 skips). This includes cron-step parsing, pause/resume, timezone/DST, SQLite schedule processing and real PostgreSQL concurrent schedule claims.


### 2026-11-04 optional Build & CI worker host

- Added `BuildCiWorkerHost` to host the existing durable webhook and schedule processors. It supports one-shot bounded cycles and an optional recurring poll loop; it is composed only through explicit app overrides and is not started by default.
- Default cycle bounds: 25 webhook claims, 100 scheduled workspaces, and 25 schedule occurrences per workspace; default polling interval is five seconds. Limits are validated and configurable.
- Schedule inventory is a trusted injected keyset-paginated source of workspace/service-actor pairs. The worker does not create a global actor or bypass the BuildCiService authorization check. The provider inventory and actor resolver are still production integration responsibilities.
- Multiple worker instances rely on atomic database claims and leases. Graceful stop propagates cancellation through the active bounded cycle, waits for the current processor call to finish and prevents subsequent claims; abrupt process loss is recoverable after lease expiry. App close stops the optional host before closing database connections.
- Tests cover bounded draining, workspace-scoped dispatch, paginated workspace inventory, single-flight cycle execution, graceful stop and required trusted inventory pairing.
- Shutdown refinement commit `39aa95cc22cd238cf9a8eabe70b0e74399bb6cc4` passed Actions run `41816619812`: typecheck, production build and 192 tests against real PostgreSQL (0 failures, 0 skipped). Cancellation is checked between processor calls, so stop does not drain the rest of the batch after the active call finishes.
- This remains queued-run dispatch only. No registered pipeline task is executed. Event publication, production resolver wiring, operational replay/alerting and the Mistral execution adapter remain outstanding.


### 2026-11-04 webhook failure-data minimization

- Security review found that `WebhookDeliveryProcessor` persisted arbitrary `Error.message` text into the durable webhook delivery row. A provider resolver could accidentally include a credential or request detail in that message.
- Changed the persisted failure detail to a fixed generic string and added a regression test with a credential-shaped sentinel in the resolver exception. The test asserts that the secret never appears in the stored delivery record.
- This does not replace structured operational failure codes/metrics; those should be added through an allow-listed observability contract rather than raw exception text.


### 2026-11-04 provider credential least-privilege boundary

- Split webhook connection resolution into `resolveForIngress` (non-secret binding plus signing material for signature verification) and `resolveForDelivery` (non-secret binding and actor only).
- The asynchronous processor now uses only `resolveForDelivery`, so worker code no longer requests or receives webhook signing secrets. Existing workspace/repository/provider checks and BuildCiService authorization remain.
- Updated SQLite and real-PostgreSQL integration tests for the split contract. This is an interface hardening step, not a production vault/resolver implementation.


### Verification — webhook credential boundary

- `97a6dd4f421eefc42132f9e39df20f84eb893c6a`: Actions run `41822931072` passed typecheck, production build and 193 tests against real PostgreSQL (0 failures, 0 skipped). It adds a regression test proving arbitrary provider exception text is not persisted.
- `1a67ed7e5c034fba243dc7d0b8f8a95893b2d61d`: Actions run `41823371670` passed typecheck, production build and 193 tests against real PostgreSQL (0 failures, 0 skipped). It separates ingress-only secret resolution from non-secret delivery-principal resolution.
- Intermediate commit `df8812905b41df595ebc35a28e598e6c2e4e118c` failed typecheck because service-specific tests were required to implement both resolver methods. Corrected by introducing narrow ingress and delivery resolver interfaces; the final run is green.


### 2026-11-04 provider connection metadata and revocation

- Added migration v7 for SQLite and PostgreSQL. Build & CI stores only provider connection metadata and an opaque `secret_ref`; it has no column for a signing secret or provider token.
- Added SQLite and PostgreSQL provider-connection stores with create/find/revoke operations and one-way idempotent revocation.
- Added `StoredWebhookConnectionResolver`: ingress resolves signing material through an injected vault port and re-checks the connection after resolution; background delivery receives only the non-secret binding and never calls the vault.
- Added SQLite unit coverage and real PostgreSQL integration coverage for metadata persistence, vault separation, revocation and repeated revocation.
- A CI run exposed two unrelated schedule tests that relied on the runner's wall clock while injecting a fixed 12:00 clock. Their pipeline fixtures now use explicit creation timestamps, removing that timing dependency.
- The first provider metadata commit exposed a PostgreSQL migration syntax boundary error; the next commit corrected it. TypeScript then flagged parameter properties under `erasableSyntaxOnly`; constructors were changed to explicit field assignments. These failures were corrected before the final verified run.
- Final code/test commit `23c2faa1baff5cac3ae57726931843059af8a12a` passed Actions run `41825602764`: typecheck passed, production build passed, 195 tests passed, 0 failed, 0 skipped, including real PostgreSQL migration and provider-connection lifecycle coverage.
- Still missing: concrete vault/KMS adapter, secure secret provisioning and rotation, authorization-enforced connection-management API, service-principal creation/revocation lifecycle, production workspace/provider resolver composition, and transactional event/outbox publication.


### 2026-11-04 provider secret-reference rotation

- Added compare-and-swap rotation to both SQLite and PostgreSQL provider-connection stores. Rotation requires an active connection and the expected current opaque reference, preventing a stale concurrent rotation from overwriting a newer reference.
- Ingress resolves only the current reference and verifies that it remains unchanged/active after the external vault call. Delivery lookup remains vault-free.
- Added SQLite and PostgreSQL tests for successful rotation and stale-reference rejection.
- One more CI run exposed a third schedule test with a fixed synthetic clock but a wall-clock-created pipeline. The fixture now pins its pipeline creation timestamp, removing the runner-time dependency.
- Verified code/test head `d3a602ce22b296194ad16bc5d0fbdbc69a7b99eb`; Actions run `41826209940` passed typecheck, production build and 195 tests against real PostgreSQL (0 failures, 0 skipped).
- Vault-side provisioning/retirement is not performed by the compare-and-swap method. A concrete vault adapter and an authorized connection-management lifecycle remain outstanding.

### 2026-11-05 continuation — version comparison and integrity evidence (GPT branch, CI pending)

- Added a value-free pipeline definition diff. It reports root metadata fields, added/removed/changed triggers and steps, changed field names and relative ordering changes without returning old/new parameter values or secret references.
- Added authenticated `GET /v1/build-ci/pipelines/versions/diff` with read authorization and version existence checks.
- Unsaved candidate dry-run now returns baseline version/hash (when one exists), candidate hash and the structural diff. It performs no save or run write.
- Added pure diff edge-case tests, service-level saved/candidate comparison and authorization tests, and HTTP route tests for saved diff, candidate baseline comparison and invalid/unauthenticated requests.
- Added SQLite tamper regression coverage: after deliberately removing the test database's immutable trigger and changing stored definition JSON without updating its hash, `getVersion`, `getLatestVersion` and `listVersions` reject the row.
- Added real-PostgreSQL tamper regression coverage for `getVersion` and `getLatestVersion`, plus concurrent version allocation and concurrent rollback allocation tests. The PostgreSQL tests intentionally manipulate/disable the immutability trigger only inside the isolated test database to simulate out-of-band tampering.
- Removed a duplicated trailing fragment from `src/modules/build-ci/routes.ts` discovered during review; the file now contains one `buildCiRoutes` definition and one copy of each helper. This was a source corruption from an earlier route edit and must be confirmed by typecheck/build.
- **Verification: NOT YET VERIFIED.** The latest historical green Actions run remains `41826209940` on commit `d3a602ce22b296194ad16bc5d0fbdbc69a7b99eb`; it predates all 2026-11-05 continuation commits. The GitHub connector did not expose push-run details or commit statuses, so no current test/build result is claimed.
- The current branch continues to be isolated; no merge, deploy, or modification of `main`, `mistral` or `claude` was performed.

