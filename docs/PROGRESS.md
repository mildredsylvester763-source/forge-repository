# Progress, decisions and things to polish

This file is the project's memory. Update it with every change. Nothing the owner has decided should live only in a chat.

## Working rules (from the owner)

1. Current owner instruction (2026-11-05): continue CO implementation in ordered batches without pausing for confirmation. Compare main and mistral before each feature; implement and verify safe independent work; record owner-dependent items in docs/CO_APPROVAL_NEEDED.md and continue other work. This current instruction supersedes any earlier instruction to wait for confirmation.
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
| AI-057..061 | Web search: source ranking, page fetch with clean extraction, citation tracking, freshness, domain allow and deny lists | Five pure engines with oracle-swept specs, stores for memory, SQLite and PostgreSQL, service, routes, functional tests. |
| AI-062..072 | Workspace retrieval and search integrity: library docs, workspace retrieval, hybrid search, reranking, research mode, fact and claim separation, quoting limits, reference search, cache and rate, injection defense, offline packs | Eleven pure engines with oracle-swept specs, stores for memory, SQLite and PostgreSQL, service, routes, functional tests. |
| AI-003..032 | AI training: admission gates, PII and secret scrubbing, dataset snapshots and lineage, training plans, run lifecycle, checkpoints, budgets, reproducibility fingerprints, eval suites, FORGE grading, human panels, ship gates, safety batteries, grounding, contamination, blind votes, consent-gated experiments, agent scorecards, eval trends, failure mining | Seven pure engines with oracle-swept specs, stores for memory, SQLite and PostgreSQL, service, routes, functional tests. |
| AI-033..056 | Model lifecycle: registry with lineage and honest model cards, staged promotion with hard gates, serving (autoscaling, quantization, on-device bundles, cheap-first routing), operations (response cache, streaming with resume, metrics, shadow deployment, instant rollback), gateway (provider-neutral routing, three-strike failover, BYOK, per-request policy, accounting), gateway-ops (redacting logs, zero retention, capability registry, tool calling and output schemas), access (pinning, dedicated instances, on-prem packages) | Six pure engines with oracle-swept specs, stores for memory, SQLite and PostgreSQL, service, routes, functional tests. |
| AI-079..083 | Task runtime: step validation, approval gates, task control, history journal and replay, parallel conflicts | Five pure engines with oracle-swept specs, stores for memory, SQLite and PostgreSQL, service, routes, functional tests. |
| AI-073..078 | Orchestrator: intent classification, task planner and plan editing, plan preview, agent handoffs, tool permissions, execution sandbox | Six pure engines with oracle-swept specs, stores for memory, SQLite and PostgreSQL, service, routes, functional tests. |
| TQ-036..040 | Test quality: mutation testing, contract testing, snapshot goldens, visual regression, browser matrix | Five pure engines with oracle-swept specs, golden stores for memory, SQLite and PostgreSQL, service, routes, functional tests. |
| TQ-031..035 | Test generation: unit boundary suites, integration graph suites, e2e session replay, property-based suites, fuzz campaigns | Five pure engines with oracle-swept specs, suite stores for memory, SQLite and PostgreSQL, service, routes, functional tests. |
| TQ-001..018 | Live testing session core: sessions, platforms, narration, personas, recording, bug reports, conversion, safe mode, collaboration | Nine pure engines with oracle-swept specs, stores for memory, SQLite and PostgreSQL, service, routes, functional tests. |
| TQ-019..030 | Live testing extras: human versus AI session comparison, device and network catalogs, low-end profiles, interruption simulation, permission plans, cross-device handoff, gesture physics, creative tool operation, av checks, test data seeding and cleanup | Nine new pure engines with oracle-swept specs, stores for memory, SQLite and PostgreSQL, service, routes, functional tests. TQ-024 and TQ-030 document the collaboration and safe mode engines shipped with the session core. |

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
| CO-002 to CO-014 | Identity: passkeys, social, SSO, MFA, sessions, recovery, tokens | in progress (CO-002 to CO-008 individually audited; backend partials and acceptance/activation tracked) |
| CO-015 to CO-028 | Workspaces and tenancy | not started |
| CO-029 to CO-044 | Permissions and policy | not started |
| CO-045 to CO-062 | Project intelligence graph | not started |
| CO-063 to CO-080 | Event backbone and audit ledger | partly built |
| CO-081 to CO-090 | Context engine | not started |
| CO-091 to CO-100 | Platform reliability | partly built |
| AI-001 to AI-072 | FORGE AI | partly built (AI-003..006, AI-013..056, AI-057..072 done) |
| AI-073 to AI-078 | FORGE AI: orchestrator | done |
| AI-079 to AI-083 | FORGE AI: task runtime | done |
| AI-084 to AI-150 | FORGE AI | not started |
| TQ-001 to TQ-120 | Testing and quality | partly built |

The full app spans up to about 30 files of features. Part 01 is only one of them.


## CO continuous implementation log (2026-11-05)

### Scope and branch safety
- Exact repository: `mildredsylvester763-source/forge-repository`.
- Destination: `mistral`. Comparison only: `main`.
- Current observed main head: `ec6716fb5ba6c42e940b748581990df9194a2a2b`.
- Current observed mistral head before this documentation update: `39fc4e2813698a1fd3dcfa5b6f94099d02bf7bed`.
- Branches are divergent: mistral is 91 commits ahead and 1 behind main, with merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- The main-only commit is `53fd9a4d6b3b6770d8fb670a9edf65733447b225`, a documentation-only three-lane branch-rules sync. It does not contain a CO implementation to port. No merge/cherry-pick is authorized.
- No AI or TQ source files are in the CO work scope.

### Evidence-based CO status snapshot
- CO-001: implemented foundation; docs/features/CO-001.md, src/modules/identity/identity-service.ts, src/modules/identity/sessions.ts, src/modules/identity/routes.ts, and test/identity.test.ts provide concrete evidence. Its documented limitations (verification/recovery/password-change and non-cookie token flows) remain separate work.
- CO-002–014: identity subsection; docs/PROGRESS.md records passkeys, social, SSO, MFA, sessions, recovery and tokens as not started at section level. There are no individual CO feature specification files beyond CO-001 in docs/features. Individual acceptance wording is not yet verifiable.
- CO-015–028: workspace/tenancy subsection marked not started in the catalogue checklist. No dedicated CO workspace/tenant module exists in the Mistral source tree. Exact feature-level requirements and tenancy model remain to be recovered.
- CO-029–044: permissions/policy subsection marked not started. No dedicated CO authorization/policy module exists in the Mistral source tree. Route-level identity authentication exists but is not equivalent to resource- and tenant-level authorization.
- CO-045–062: project intelligence graph subsection marked not started. No dedicated CO graph module exists in the Mistral source tree. Exact graph entities, edge semantics, lifecycle and query requirements are unavailable in repository docs.
- CO-063–065 and CO-076: event envelope, append-only/hash-chain, transactional append helpers and chain verification exist. Identity registration, session creation (including password rehash), sign-out, and compromised-password transitions now couple their state writes to audit-event writes in SQLite/PostgreSQL units of work. This does not prove atomicity for other domains. Tail truncation cannot be detected by an internal chain alone; an independently stored head anchor remains owner/deployment dependent and is recorded in the approval register.
- CO-091: healthRoutes() is extracted to src/kernel/health.ts. /healthz remains storage-independent; /readyz reports 503 not_ready when EventStore.head() cannot respond and 200 with auditSeq on success. This proves only the event-store/database dependency, not every external dependency or operational SLO.
- CO-093: src/kernel/rate-limit.ts provides an in-memory sliding-window limiter; production multi-instance atomic/shared enforcement is not evidenced. Treat as partial, not complete.
- CO-096: src/kernel/backup.ts provides verified SQLite snapshots (checksum, SQLite integrity and event-chain checks). This does not establish automated off-site PostgreSQL backup/restore.
- CO-030: `IdentityService.authenticate()` backs the protected identity session endpoint (`GET /v1/auth/me`). A focused CO regression now checks that missing and invalid session cookies return the standard 401. This establishes the identity session check only; it does not prove a complete tenant/resource authorization model or the unavailable original CO-030 acceptance wording.

### CO-063/064/065/076 implementation review
- Compared main and mistral: src/kernel/events.ts, src/kernel/canonical.ts, src/kernel/postgres-events.ts and src/kernel/sqlite-events.ts have identical blob SHAs on both branches at the time of review. Existing event foundation is inherited, not a Mistral-only addition.
- SQLite and PostgreSQL verification walk sequence order and validate previous-hash links and recomputed hashes. SQLite events table is protected by append-only triggers (see kernel migrations); PostgreSQL protections and role/privilege behavior still require a real PostgreSQL integration proof.
- A valid chain can still be truncated at its tail and verify as valid if the remaining prefix is intact. The project notes already identify an external head anchor as required; the mechanism and credentials must not be invented.
- The Postgres advisory transaction lock serializes chain extension, and appendIn() allows a domain transaction to append its event atomically. This does not prove every module uses that unit-of-work pattern.
- `canonicalJson()` now rejects sparse arrays and cyclic values. Previously, `Array#map()` skipped sparse array holes and could produce invalid canonical bytes such as `[1,,3]`, which could be hashed but would not be valid JSON for the persisted payload. The serializer now visits each array index and tracks the active recursion path, rejecting holes and cycles before a hash or database write is produced. Shared non-cyclic object references remain supported.
- The event envelope now validates its runtime structure as well: actor kind must be one of the declared ActorKind values; actor and subject fields must have their declared string/object shapes; payload must be a record; correlation/causation metadata must have their declared string/null types; and occurredAtMs must be finite and within JavaScript's supported Date range. Canonical payload objects must be plain JSON objects, so Date/Map/Set/class instances cannot silently serialize as misleading empty objects.

### Verification blockers
- Latest observed Mistral CI failure remains in AI-only file src/modules/ai-training/sqlite-stores.ts (TypeScript syntax/type-check stage); AI is outside this CO task and was not changed.
- A real Postgres service/connection is not available in this execution context, so claims of real-Postgres integration success are prohibited until the repository CI or owner-provided test DB confirms it.
- Exact original Part 01 catalogue descriptions for CO-002–CO-100 are not present in this repository snapshot; only section ranges and selected notes are present. Do not fabricate feature acceptance criteria. Continue safe work grounded in the explicit project notes and record this acceptance-criteria limitation.

See docs/CO_APPROVAL_NEEDED.md for the durable decision/dependency register.


### CO-093 bounded-key rate-limiter hardening (2026-11-05)
- Compared `src/kernel/rate-limit.ts` on main and mistral before editing; both branches had the same implementation (blob `7506cb7f200cb75e6d8e90f66ee37d362e337ad3`).
- Defect found: when the key map reached `maxKeys`, the limiter evicted the least-recently-used key even if its sliding-window attempts were still live. A client could regain a fresh budget by causing key churn. A zero/invalid capacity could also cause all counters to be immediately discarded.
- Mistral change: validate positive safe-integer limit/window/capacity; validate bounded non-empty keys and finite clock values; reclaim only an expired least-recently-used key; fail closed for a new key when capacity is full and the oldest key is still live. Existing tracked keys continue to be enforced.
- Added `test/rate-limit.test.ts` covering exact limits, window expiry, capacity-churn protection, expired-key reclamation, invalid configuration and key bounds.
- Commits: limiter fix `8ed83602111353b76c9014392515f0136089f737`; tests `bcf58c36a55b23bf6f1ac9b72d6b41cccee7ee8e`.
- Status remains PARTIAL: this limiter is process-local. It does not provide atomic shared limits across multiple application replicas. A shared Postgres/Redis implementation and policy are tracked in docs/CO_APPROVAL_NEEDED.md. No claim of distributed production protection is made.
- Verification: GitHub Actions run for the code commit was still in progress at the time of this entry; local tests/typecheck were not run in this environment. Record final CI result before declaring this slice verified.


### CO-096 SQLite backup verification hardening (2026-11-05)
- Compared `src/kernel/backup.ts` on main and mistral before editing; both branches shared blob `f71e281be948fee5ec26fb9122432fa4a7d42a32`.
- Defect found: `verifyBackup()` accepted a backup when its `.sha256` sidecar was missing, because checksum comparison was conditional on sidecar existence. This contradicted the stated checksum-verification guarantee.
- Mistral change: checksum sidecar is now mandatory; unreadable checksum metadata, malformed non-64-character lowercase hex digests, and digest mismatches return explicit failed checks rather than accepting the backup.
- Added `test/backup.test.ts` covering a valid generated backup, missing sidecar, malformed digest, mismatched digest and restored valid sidecar.
- Commits: implementation `cc9f79f734be3e26005eea4148aab5c66ae9c034`; tests `175c8d6bbec4d0385e32ac515ae22af2b77d9560`.
- Status remains PARTIAL: this is SQLite local backup verification only. PostgreSQL/off-site backup, scheduled R2 transfer and restore objectives remain owner/deployment dependent as listed in docs/CO_APPROVAL_NEEDED.md.
- Verification: CI for the preceding CO commits fails before test execution because of pre-existing TypeScript parse errors in `src/modules/ai-training/sqlite-stores.ts` (outside CO). The backup test has therefore not yet run in GitHub Actions. Local execution is unavailable in this environment.


### CO-093 account-lockout capacity hardening (2026-11-05)
- Compared `src/modules/identity/throttle.ts` on main and mistral before editing; both branches had identical blob `e652001cf2e4fd68b940ff6a335d92f3b15f9af5`.
- Defect found: the per-account exponential-lockout map evicted its oldest entry whenever it exceeded `maxEntries`, even if the entry still represented a live lockout. Distinct-account key churn could erase a victim's lockout.
- Mistral change: known fingerprints are refreshed in LRU order; expired entries may be reclaimed; when capacity is full of live entries, unknown fingerprints fail closed instead of evicting an existing lockout. A defensive guard also prevents direct recordFailure() calls from evicting live state.
- Added `test/identity-throttle.test.ts` for lockout retention under key churn, stale-entry reclamation and expiry behavior.
- Commits: implementation `219cae33696748d5ca59302d4c0171921b5f70da`; tests `c6e9bf6613dbea0ddac49a828dbfcfd6c295a591`.
- Operational trade-off: at account-state capacity, previously unseen fingerprints are temporarily denied until an expired entry can be reclaimed. This is intentional fail-closed behavior; alerting/operational tuning and a shared persistent limiter remain future work.
- CI status at the last completed run: typecheck fails before tests because of existing parse errors in `src/modules/ai-training/sqlite-stores.ts`; no CO tests have been executed by that run. AI remains out of scope and untouched.


### CI verification checkpoint (2026-11-05 09:25 Africa/Lagos)
- Latest feature-test workflow run inspected: [41994200934](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/41994200934), commit `c6e9bf6613dbea0ddac49a828dbfcfd6c295a591`.
- Dependency installation completed; `npm run typecheck` failed; the workflow skipped the test step. The emitted TypeScript parse errors are all in `src/modules/ai-training/sqlite-stores.ts` at lines 503–657. This file is outside CO scope and has not been modified.
- Therefore the new CO test files have not yet been executed by CI. The CO changes are pushed but not CI-verified. Re-run the full CI after the pre-existing AI parse blocker is resolved by the owner/AI workstream; do not modify AI here.


### CO-065 identity sign-out atomicity hardening (2026-11-05)
- Compared each affected file on main and mistral before editing. The unit-of-work interface, identity session service/stores, identity service and identity regression tests had matching blob SHAs on both branches.
- Defect: IdentityService.signOut() revoked a stored session and then appended identity.sign_out.completed as a separate best-effort write. An event-store failure could leave a successful revocation without its audit event; repeated sign-out could also append duplicate completion events.
- Change: SessionService.prepareRevoke() validates token shape and derives the token hash/time without mutating storage. IdentityUnitOfWork.endSession() now performs the state transition and event write together. SQLite uses one database transaction and synchronous append; PostgreSQL uses one transaction with conditional UPDATE ... WHERE revoked_at IS NULL RETURNING plus PostgresEventStore.appendIn(). The event is notified only after commit. Already-revoked or unknown sessions do not emit duplicate events.
- The in-memory unit of work mirrors the contract and restores the previous session if the event append fails; it remains a non-durable development/test adapter.
- Tests: test/identity.test.ts adds an HTTP-level SQLite failure-injection regression. test/co-065-atomic-signout.test.ts isolates the SQLite transaction test so it can run without importing unrelated AI modules. .github/workflows/co-verification.yml runs focused CO kernel/identity regression tests independently of the full repository typecheck.
- Code commits: unit-of-work contract and adapter aa2c202fa8abd853c347b19f092400164f69f2af / d91bed3c85cec5cd22d420209ac781209de7c03c; session token preparation 0d7c38a9c912a999c4a38148e8573b58d8b70495; SQLite unit of work 848eec4ed831f19784dd97231a759a26fc28a1de / ebd77867688dfe87e561a1f2d7ff83a6a4c72f36; PostgreSQL unit of work 4053a11142044e6fe9d101ac5d7a66f4cce9864e; identity service 1392eef17272ea05e71f286c733398adca23f6b7; HTTP regression 7764f1b6eef67735879828b354782e09c7889a9a; isolated regression 8a7b78d7b1d91547537a60e20868fcca956875a5; focused workflow 0cdc27a6e26e7d653b0cef7ce8fab5fe004b085f.
- Scope boundary: this closes the identified identity sign-out gap only. It does not prove every CO domain write path uses the transactional event pattern, nor does it add durable subscriber delivery/retry or external chain anchoring.
- Verification state: the focused workflow has been added and must report a completed green run before this change is called test-verified. The full CI typecheck blocker in src/modules/ai-training/sqlite-stores.ts remains outside CO scope and untouched.


### CO-091 liveness/readiness failure semantics (2026-11-05)
- Compared src/app.ts on main and mistral before editing. The file differs because Mistral contains its additional module composition; only the existing health-route slice was replaced. src/kernel/http.ts, src/kernel/errors.ts and src/kernel/logger.ts had identical blobs on both branches.
- Defect: /readyz previously let an event-store/database failure fall through as a generic 500. Liveness and readiness were inline in app.ts, so the dependency-failure behaviour had no focused test that avoided importing the full application graph.
- Change: extracted healthRoutes() into src/kernel/health.ts. /healthz remains independent of storage and returns 200 for a live process. /readyz returns 200 with the current audit sequence when EventStore.head() succeeds; on dependency failure it logs only the dependency name and returns a safe 503 not_ready response without disclosing connection details.
- Added test/co-091-readiness.test.ts for both successful readiness and storage failure while liveness remains healthy. Added the test to .github/workflows/co-verification.yml so it runs alongside the independent CO kernel tests.
- Commits: app wiring `ef70aaa86e4095caa098aef2701de1fee8505624`; health route helper `090629e817c5f979ac201ab448af47799bfaa7e6`; readiness tests `62afccff2db6d737173ad59a2f7621d9b304d9bb`; focused workflow update `5aab99f220fbeef64a11fbb95857df04165a62bc`.
- Status remains PARTIAL: this confirms event-store connectivity for readiness; it does not establish end-to-end health of every future external dependency or operational SLOs. No thresholds or unconfigured services were invented.
- Verification: tests are committed but no focused GitHub check result is visible yet. The full CI typecheck failure in the AI-only sqlite-stores.ts remains outside CO scope and untouched.


### CO-065 identity security-state audit atomicity (2026-11-05)
- Further audit found that sign-in's password-compromise path changed users.password_compromised_at and then appended identity.password.compromised_detected in a separate best-effort operation. A failure could leave the security flag set without its event. This is now part of IdentityUnitOfWork.markPasswordCompromised().
- SQLite performs the user-row update and event append within one transaction. PostgreSQL locks the user row with SELECT ... FOR UPDATE, applies the flag/version update, and appends through PostgresEventStore.appendIn() on the same transaction connection. Event dispatch is notified only after commit. If the flag is already set, the current row is returned without emitting a duplicate detection event.
- The in-memory unit of work serializes per-user security transitions and restores the exact prior record if event append fails. It also serializes concurrent sign-outs per session key; SQLite/PostgreSQL retain database-level transaction/row-lock guarantees.
- Regression coverage: test/co-065-atomic-signout.test.ts covers SQLite sign-out rollback/idempotency, SQLite password-compromise rollback/idempotency, concurrent in-memory sign-out, and exact in-memory rollback. test/co-065-postgres-uow.test.ts covers rollback/idempotency of both transitions through PostgreSQL adapters. That test uses real PostgreSQL only when FORGE_TEST_POSTGRES_URL is configured; otherwise it uses the SQLite-backed adapter harness. test/sqlite-pool.ts now supports DML RETURNING result rows so the test harness faithfully exercises the Postgres session-update path.
- Focused workflow .github/workflows/co-verification.yml now runs both CO-065 files, CO-091 readiness tests, and existing backup/rate-limit/account-throttle regression suites.
- Commits: in-memory user restore `1a6801ce0e351b668922cb7976b103e9f251ef6b`; UOW contract/docs/serialization `2a43ad1eb824d4425cec7e318c38b98d60f5b98b`, `8279894192f7b1b980336853e87458d40f489801`, `3d981f8c48ffd2a37fd8d9e389370fe944a5365f`, `99d16b44e4f4bfd617271e744dcc55b581fb9a34`; SQLite user atomicity `8166154e8e486fe57b26832259ccf3a7f4f1c8c8`, `ba699dc5603c0b84ab63f4b3f13fbeb8b129b5e2`, `e3f7bdbbda6f247921688d4314a808365a6fd644`; PostgreSQL user atomicity `8ae12271c0733f29a5a0003a0dbd309193e25b7e`, `e4104d28c1614445fbebf3e43389eb815801b7f9`, `ef77842a36fc8db1c444e20a4db78f0be890277f`; service integration `182cd7dcb9ddc0c90848a45b8adb7992428a3425`; regression tests `b73451144b08598fe53faa08e685339e88a6fc6c`, `bae82217b6e1692a8b003b7a65289651c2f0e11a`; test-adapter fix `f2cb82bb43d60aefdc85d9ec01597f58b73aa2b`; focused workflow updates/deduplication `0681a25d1f5474848412413d7a86922fe4cffd9e`, `456412cb826aa82cc883094d50af4bf07c6f7d36`, `62afa79f85faf96e14c8546119fce68be2f15c81`.
- Status remains PARTIAL until the focused workflow passes and a real PostgreSQL run is evidenced where production PostgreSQL compatibility is claimed. Identity register/sign-in/sign-out/security-flag paths now use transactional writes for the currently implemented operations; this does not prove future identity/domain mutations are covered.


### CO-065 sign-in password-rehash transaction boundary (2026-11-05)
- Final identity write-path audit found one more non-atomic mutation: IdentityService.signIn() persisted a password-hash upgrade before creating the new session and appending identity.sign_in.succeeded. A later session/event failure could therefore leave a rehash without the successful sign-in audit event.
- Change: IdentityUnitOfWork.startSession() accepts an optional user update. IdentityService now computes a replacement hash but does not persist it early. SQLite applies that hash update, new session insertion, session-cap revocations, and sign-in event append inside one transaction. PostgreSQL does the same with one connection/transaction and PostgresUserStore.updateIn(). The update preserves existing account fields, including password-compromise state.
- The in-memory UOW serializes session creation by user key and snapshots the prior user/session state so a failed event append restores both. This remains a non-crash-safe development/test adapter.
- Added failure-injection tests proving invalid event creation rolls back the hash and session together in SQLite and through PostgreSQL adapters. The PostgreSQL adapter test uses a real database only when FORGE_TEST_POSTGRES_URL is configured; its default SQLite-backed stand-in is not production PostgreSQL proof.
- Commits: UOW contract/in-memory transaction `e69dd9dc5d923ae5acd61d54fec0d254b8506f4d`, `bb48b293a2508602bbc97e651a08bdb0917dc72c`, `0d5611306c9a02c3063e63c6d2e566a658ebf38d`; SQLite transaction `29142ee109b1cfb290f1de160a8d046bce0f1425`; PostgreSQL transaction `0356fe671e1450eaa96018d7844aa572661bda4f`; service integration `bfe067e63477aa5718ba124f654463060f1b28e8`; SQLite test `facc40ac1fc4785b0535cb84878fdad825d5aa16`; PostgreSQL tests `85387de49d30cf988b84e4df4d4d46b0bf4ae3eb`, `6a71661fa662d946d291d70f7aa2c801c9bb95e9`.
- Verification: CO-focused run 42004350221 passed the isolated CO type-check and all 25 focused tests, including the SQLite/in-memory rollback/idempotency regressions. FORGE_TEST_POSTGRES_URL was unset, so the PostgreSQL adapter test used its SQLite-backed fallback; native PostgreSQL transaction/locking proof remains pending. The full repository CI remains blocked by the unrelated AI-only TypeScript parse errors in src/modules/ai-training/sqlite-stores.ts (lines 503–657).


### CO-001 concurrent sign-in session-cap enforcement (2026-11-05)
- Defect: SessionService.prepare() used to read the active-session set and calculate revoke IDs before the identity transaction. Concurrent sign-ins could both use stale snapshots and leave more active sessions than maxPerUser.
- Change: prepare() now creates the bearer token/session and returns maxPerUser only; it does not count or select old sessions. IdentityUnitOfWork.startSession() owns session-cap enforcement. In memory it serializes by user ID and snapshots sessions for rollback. SQLite computes the active set and retires the least-recently-active surplus inside BEGIN IMMEDIATE with the user update, session insert, and event append. PostgreSQL locks the user row with SELECT FOR UPDATE before reading active sessions, then retires the surplus, inserts the new session, and appends the event in the same transaction.
- Ordering for equally active sessions is deterministic: lastSeenAt, createdAt, then idHash. maxPerUser must be a positive safe integer and any optional userUpdate must refer to the session owner.
- Regression coverage: test/co-065-atomic-signout.test.ts now covers concurrent cap enforcement and rollback of previous-session revocations on audit failure for SQLite and the in-memory adapter. test/co-065-postgres-uow.test.ts covers concurrent cap enforcement and rollback through the PostgreSQL adapter. Real concurrency/row-lock behaviour is only confirmed if FORGE_TEST_POSTGRES_URL is configured; the default SQLite-backed pool is not proof of native PostgreSQL locking.
- CO-001 feature notes updated in docs/features/CO-001.md. Commits: prepare change `a426dd94c31a733b07921646494d52154ccd6261`; in-memory unit of work `dc6e9c4e8c93d2974fd606e3795e8ca982849f6c`; SQLite transaction `73b145fcce542e4f13861008098eaec8f8ab22bf`; PostgreSQL transaction `60e4e1e7232036e9e31a054bac318bd6293eb829`; service integration `0553a90d2d0203284942a2030ebcb67308d0eddb`; call-site test updates `996df858837d67994253b144e122d07da6fcb1b2`, `fb28d7bc7396009ed5db2102187ac5640e6137cb`; SQLite concurrency `19e11ec7911ef22f907dfd674d65ac55d9f6ddad`; PostgreSQL concurrency `4adc6bfc4e1ac7c72643f7f68ef7bc311d71d188`; docs `5a8bafc8bb11db178fb0fb61f313515782cb5e31`; SQLite cap rollback `06e09f32fad7ebc2b2afded7e83a7f03eeb9d084`; PostgreSQL cap rollback `cb8ff2c4eefc88dac95a505e2a2d89d2a49630f3`; in-memory cap regression `f753a62332447581b41b0d4e0dec0ea491995a09`; CO-001 feature-doc update `e4cb06f89688a653403e22a0fc78fd4e00b3e521`.
- Verification: CO-focused run 42004350221 on commit c0519ccb752c19c82b1bf25c6c1d2db1d638f131 passed npx tsc -p tsconfig.co.json --noEmit and all 25 configured tests, including SQLite/in-memory session-cap concurrency and rollback. FORGE_TEST_POSTGRES_URL was unset, so native PostgreSQL row-lock concurrency remains unverified. The full repository CI still fails on pre-existing parse errors in src/modules/ai-training/sqlite-stores.ts (lines 503–657); AI was not changed.


### CO-030 Core route authentication audit (superseded, 2026-11-05)
- A previous broader route audit included Task Runtime, Orchestrator, Workspace Retrieval, Web Search and Search Integrity. The subsequent scope review found that this evidence was not valid CO-only evidence; Task Runtime is identified as AI-079–083 and the adjacent route modules were not established as CO scope. Do not count that broad route test or those modules as CO implementation. No files in those modules were changed.

### CO-030 identity session enforcement check (2026-11-05)
- Scope correction: the adjacent Task Runtime source identifies itself as AI-079–083; the related Orchestrator, Workspace Retrieval, Web Search and Search Integrity route audit was therefore not valid evidence for CO-only progress. No implementation files in those modules were changed. The broad route test was narrowed to Identity only.
- The Identity `GET /v1/auth/me` endpoint uses `IdentityService.authenticate()`, which validates the session and associated active user. Added `test/co-030-route-auth.test.ts` to check the standard 401 response for missing and invalid session cookies. The focused TypeScript config and CI workflow include this test.
- CO-030 remains PARTIAL. This confirms the identity session check only; tenant/resource authorization semantics, policy precedence, tenant membership, and the unavailable original feature-level acceptance wording remain unresolved. CO-017 and CO-029–044 decisions stay in `docs/CO_APPROVAL_NEEDED.md`.
- Verification: CO-focused run 42004350221 on commit c0519ccb752c19c82b1bf25c6c1d2db1d638f131 passed the isolated CO type-check and all 25 tests, including the narrowed Identity-only missing/invalid-session regression. CO-030 remains partial because the original acceptance wording and tenant/resource authorization semantics are unavailable.
- Test-scope correction commit: `b7309f80f833a0f81b1b3bbd2e06501ea5fe15db`.


### CO-002–004 identity-provider audit (2026-11-05)
- Compared main and mistral before classifying these features. The identity directory has the same 16 filenames on both branches; identity/routes.ts blob 7bdf386aaca4321c047e0e703e5e97de2085e0d5, identity/index.ts blob 87b4d54d8af7e7e12da153a4f288b73ad9ea7a91, identity/migrations.ts blob 941fe324f59e40fa2ea04edfdf4144df3b2184cf and identity/postgres-migrations.ts blob 01caa90fa9bf833493fb3a6258115e67283fdbe7 are identical on main and mistral.
- CO-002 Passkeys — MISSING / OWNER-BLOCKED. The identity route table contains only register, sign-in, sign-out and current-user endpoints; there is no passkey/WebAuthn route, provider service, credential schema or migration in the identity module. Exact Part 01 acceptance wording is unavailable. Required owner input remains supported authenticators, production relying-party ID/origins and credential lifecycle/recovery expectations.
- CO-003 Social sign-in — MISSING / OWNER-BLOCKED. No OAuth provider routes/adapters, linked-provider account schema or provider-specific migrations exist in the identity module. Exact Part 01 acceptance wording is unavailable. Required owner input remains provider selection, client IDs/secrets and registered redirect URIs; no provider or credentials were guessed.
- CO-004 Enterprise SSO — MISSING / OWNER-BLOCKED. No SAML/OIDC federation routes, metadata/certificate handling or SSO provisioning schema exists in the identity module. Exact Part 01 acceptance wording is unavailable. Required owner input remains customer issuer metadata, certificates and provisioning expectations.
- CO-005–014 remain ACCEPTANCE-CRITERIA-UNVERIFIED individually: the repository has no per-feature specifications and the original Part 01 entries are not available in this context. No feature wording or implementation contract was invented. See docs/CO_APPROVAL_NEEDED.md for the durable provider dependencies.
- No code changes were made for CO-002–004 because the provider and relying-party choices are owner-dependent; unrelated CO work continues.

### CO-096 SQLite backup publication correction (2026-11-05)
- Compared src/kernel/backup.ts on main and mistral before editing: main blob f71e281be948fee5ec26fb9122432fa4a7d42a32; Mistral baseline blob 12967178c4e44773c946bd6cc04f5d9d200799ed.
- Defects: after making the checksum sidecar mandatory, createBackup() still called verifyBackup(partial) before creating the sidecar, so every new backup failed with checksum_missing. The sidecar parser also used an over-escaped whitespace expression and did not parse the standard two-space checksum line correctly.
- Fix: compute the snapshot digest, write a mode-0600 sidecar for the partial backup, verify checksum + SQLite integrity + event chain, then publish the sidecar with a no-overwrite hard link before renaming the verified database into place. Failed publication cleans temporary artifacts. verifyBackup() now parses normal whitespace separators.
- Regression coverage: test/backup.test.ts verifies generated backups and accepts a tab-separated checksum line, then rejects missing, malformed and mismatched sidecars.
- Verification: CO-focused run 42004350221 passed npx tsc -p tsconfig.co.json --noEmit and all 25 configured tests, including the backup, identity, readiness, rate-limit and account-throttle regressions. The CO-030 test in this run is the narrowed Identity-only version. Full CI run 42004349461 still failed on parse errors in out-of-scope src/modules/ai-training/sqlite-stores.ts at lines 503–657; no AI/TQ files were changed.
- Status remains PARTIAL: local SQLite backup verification and restore-drill checks are green, but PostgreSQL/off-site R2 backup, restore objectives and retention policy still require the credentials and RPO/RTO decisions in docs/CO_APPROVAL_NEEDED.md.
- Commits: backup implementation b6fd2158c83b26afe4a901f70539a679795338df; whitespace regression test 28d0cd23365a1cca6906ef0ea5d29201b83fa0d1.


### CO-065 event-dispatch delivery guarantee clarification (2026-11-05)
- The EventDispatcher comment was corrected to state its actual guarantee: best-effort, in-process subscriber delivery. There is no durable queue or retry; subscriber failure is logged and does not block the writer or other subscribers. This is a guarantee clarification, not a durable-delivery implementation.
- CO-065 remains PARTIAL for domain-wide transactional outbox coverage and durable subscriber delivery/retry/dead-letter behavior. Owner confirmation of the required delivery contract remains in docs/CO_APPROVAL_NEEDED.md. The transactional identity state-plus-event writes remain covered by the focused regressions; do not describe subscriber delivery as at-least-once.
- The current CO-focused run 42004350221 passed the isolated type-check and 25 tests. The full CI run 42004349461 remains blocked by the AI-only TypeScript parse errors in src/modules/ai-training/sqlite-stores.ts; that file was not modified.


### CO-063 canonical event payload serialization (2026-11-05)
- Compared `src/kernel/canonical.ts` on main and mistral before editing; both were identical at blob `30fe14ec4d20f7c3cd098ef10a8587d41f697538`.
- Defect: canonical serialization used `Array#map()`, which skips sparse array holes. For an array with values at indexes 0 and 2, it could emit invalid JSON (`[1,,3]`). That malformed text could be fed into the event hash while SQLite JSON parsing or PostgreSQL JSON storage could reject it. Cyclic values could also recurse until a runtime stack error.
- Fix: canonical JSON now visits every array index and rejects holes/undefined values instead of emitting malformed JSON. It tracks the active object recursion path and rejects cycles with a clear `TypeError`; shared but non-cyclic references still serialize deterministically. No object-key ordering or `undefined` object-property semantics changed.
- Added `test/co-063-canonical-payload.test.ts` for stable key ordering, shared references, valid JSON parsing, sparse-array rejection at the serializer and event-envelope boundaries, and cyclic-value rejection.
- The test is included in `tsconfig.co.json` and `.github/workflows/co-verification.yml`. GitHub Actions run `42004350221` on branch `mistral`, head `c0519ccb752c19c82b1bf25c6c1d2db1d638f131`, passed the isolated CO typecheck and all 25 tests; its log explicitly shows the CO-063 suite passing. This run also covers the narrowed Identity-only CO-030 regression.
- Scope: CO-063 canonical payload validity is hardened. CO-064/076 still need an independent head anchor to detect a valid-prefix tail truncation; the destination/retention decision is owner-dependent. The dispatcher is only best-effort in-process delivery, not a durable outbox; durable retry/dead-letter requirements remain the CO-065 owner decision.
- Commit references: canonical serializer `64ce83b4854ca87df5c135e732cf100e47846209`; regression tests `ab64965ade8c23bcdbc75f684800ec979e87312c`; TypeScript include `4007221e8d2176f731e37d621980316d0a0e1bfe`; focused workflow include `c447ff3a31affc2bff2b3b0ec0656fde48c1575c`; dispatcher guarantee wording `c0519ccb752c19c82b1bf25c6c1d2db1d638f131`.


### CO-063 runtime event-envelope validation (2026-11-05)
- Further inspection found `validateDraft()` checked only event type and version even though `ActorKind`, actor, subject, payload and cause metadata are part of the standard envelope contract. An invalid runtime actor kind or non-string identifiers could otherwise enter stores that do not enforce enum/shape constraints; invalid timestamps could fail later in `Date#toISOString()`.
- `validateDraft()` now validates the actor enum, actor/subject object shape and string fields, plain-record payload, and optional correlation/causation metadata types. `buildEnvelope()` rejects non-finite and out-of-range timestamp values before date formatting. The canonical serializer now rejects non-plain object instances instead of serializing e.g. Date as `{}`.
- Expanded `test/co-063-canonical-payload.test.ts` with invalid actor/subject/payload/cause/timestamp and Date-payload cases. The same CO-focused workflow already contains this test file; its latest green run (42004350221, 25 tests) predates these added assertions and code changes. A new run is required before this additional validation is marked verified.
- Commits: canonical plain-object enforcement `e6ed65b444d4b8950387eea99527ec8894f777fc`; envelope validation `9e9418fe93ec52e12724ae8ea38e81bc4d15c805`; expanded regression `3e239ea555df0168349791e2535644bb5a0e3156`.


### CO-076 trusted-head anchor verification primitive (2026-11-05)
- Branch comparison immediately before this change: `main` `ec6716fb5ba6c42e940b748581990df9194a2a2b`; `mistral` `22c5e1452f21a4c326020c191b6d751fc4d0d924`; Mistral is 193 commits ahead and 1 behind, with merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`. The single main-only commit is the documentation-only branch-rules update; no merge or port was performed.
- Compared the CO-076 event path before editing: `src/kernel/events.ts` is main blob `738ef9fb20070c097bb413472919e3f7ab1026e7` versus Mistral blob `26babc5c75c446fbcfd6adce025a6cc1c120df57`; `src/kernel/sqlite-events.ts` and `src/kernel/postgres-events.ts` are byte-identical across the branches. The Mistral branch has the CO-063 canonical-payload regression file; main does not.
- The repository's explicit note says an internal chain cannot detect removal of its newest valid suffix and requires the latest hash to be anchored outside the database. Exact original Part 01 feature wording for CO-076 is not present, so this work is limited to that verified requirement.
- Added `EventChainAnchor` and pure `verifyChainAgainstAnchor()`. It requires the local verified sequence and head hash to equal the latest trusted checkpoint, and fails closed for a missing, malformed, stale, sequence-mismatched or hash-mismatched checkpoint. Existing local chain failures are preserved. A stale checkpoint deliberately fails rather than silently claiming that the current tail is intact.
- Added `test/co-076-anchor-verification.test.ts` for matching checkpoints, valid-prefix tail truncation, stale/mismatched checkpoints, malformed/unavailable checkpoints and preservation of local chain failures. Added it to `tsconfig.co.json` and the focused CO workflow.
- Local isolated harness (event-kernel slice) result: 5 tests passed; isolated strict TypeScript check passed. The repository checkout could not be cloned into this execution environment, so these are not a substitute for the full repository workflow. The focused GitHub workflow is the authoritative verification still required for this commit.
- Status remains PARTIAL: no external anchor persistence, append/checkpoint coordination, destination, retention or recovery behavior is selected. The owner decision and any external credentials remain listed in `docs/CO_APPROVAL_NEEDED.md`.


### CO-076 first focused-CI failure and correction (2026-11-05)
- The first repository run for commit `9a9bd3a60bdcfd0af88f6292e9447f467f7ea4a0`, focused workflow [42006508243](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42006508243), failed during the isolated TypeScript step; its test step was skipped. The full CI typecheck also failed and skipped the general test step.
- Root causes in this change: the new `tsconfig.co.json` include entry was missing a trailing comma, and the test supplied a minimal logger object instead of the complete `Logger` contract.
- Correction: restore valid JSON and use the repository's `silentLogger` implementation in the new test. No AI/TQ source was changed. The five-test isolated harness and strict isolated typecheck pass after this correction; the repository focused workflow must be rerun before this slice is verified.


### CO-076 verification result (2026-11-05)
- Corrected commit `d8df572ea1f59ddf92a0382a489b105ac81881bf` passed focused workflow [42006742090](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42006742090): isolated CO TypeScript check and the independent CO kernel/identity regression step both succeeded. The new CO-076 test file contains five assertions covering the anchor contract and truncation case.
- Full repository CI [42006742138](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42006742138) failed at `npm run typecheck`; the general test step was skipped. This is the already recorded repository-wide blocker in the AI-only `src/modules/ai-training/sqlite-stores.ts`; no AI/TQ file was changed in this run. Do not count the general suite as executed.
- CO-076 remains PARTIAL despite the verified pure helper: there is still no independent anchor persistence, checkpoint update coordination, destination, retention or recovery policy.

### CO-002–CO-014 identity audit (2026-11-05)
- Compared `main` and `mistral` identity trees and source before this audit. Both branches contain the same 16 identity source files; neither adds a passkey, OAuth/social, SAML/SSO, MFA, recovery, native-token or agent-identity module. `src/modules/identity/routes.ts`, `index.ts`, `events.ts` and `src/config.ts` are identical across branches. Mistral's `identity-service.ts` and `sessions.ts` differ because of its transactional sign-in/sign-out/session-cap work, not because the missing identity features have been added.
- `src/modules/identity/routes.ts` exposes only register, sign-in, sign-out and `GET /v1/auth/me`. No session-management, MFA, recovery, token or external-identity route was found. The identity tree contains no passkey/OAuth/SAML/TOTP/recovery source file.
- Individual evidence-based classifications (exact Part 01 wording is still absent for this range):
  - CO-002: MISSING implementation evidence for passkeys; owner must confirm supported authenticators and relying-party origins.
  - CO-003: MISSING implementation evidence for social sign-in; provider choice, OAuth origins and client credentials are owner-dependent.
  - CO-004: MISSING implementation evidence for enterprise SSO; customer-specific SAML/OIDC metadata and tenancy/provisioning semantics are required.
  - CO-005: MISSING MFA implementation. `docs/features/CO-001.md` only identifies the integration point after password verification and before session preparation; factor and recovery policy remain unspecified.
  - CO-006: PARTIAL. `SessionStore.listActiveByUser()`, `revokeAllForUser()`, and transactional per-user session-cap enforcement exist in `src/modules/identity/sessions.ts` and the identity unit of work. There is no session-manager route or documented device/revocation UX contract.
  - CO-007 and CO-009: MISSING native-client token implementation evidence. CO-001 documentation says Android and desktop tokens belong to these IDs but does not state which ID maps to which client; no bearer-token audience/lifecycle contract or route exists.
  - CO-008: MISSING recovery/password-change endpoints. CO-001 documentation explicitly says there is no password-change endpoint and identifies session revocation/password-compromise clearing as the later integration point. Recovery email provider credentials are still required.
  - CO-010: MISSING implementation evidence; the repository does not identify this individual feature's name or acceptance criteria.
  - CO-011: PARTIAL. The shared event envelope permits `Actor.kind = 'agent'`, but no per-agent identity, credential or lifecycle implementation exists.
  - CO-012: MISSING anomaly-detection implementation. Identity sign-in events exist and are subscribable, but no anomaly detector/subscriber exists.
  - CO-013 and CO-014: MISSING implementation evidence; individual feature names and acceptance criteria are not present in repository documentation.
- No CO-002–CO-014 implementation was guessed. Owner-dependent provider, origin, SSO, MFA/recovery, native-token and agent-identity decisions remain isolated in `docs/CO_APPROVAL_NEEDED.md`; unrelated CO work continues.


### CO-015–CO-028 workspace and tenancy audit (2026-11-05)
- Compared the current `main` and `mistral` source trees before this audit. Neither branch contains a CO workspace/tenant, membership, invitation or ownership module, route set or migration set. Mistral's only `workspace` source tree is `src/modules/workspace-retrieval`, the AI workspace-retrieval feature range; it is explicitly excluded from CO and is not counted as workspace tenancy.
- Individual evidence-based classifications:
  - CO-015: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-016: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-017: MISSING tenant-isolation implementation evidence; owner decision on application scoping versus PostgreSQL RLS is still required.
  - CO-018: MISSING application-level encryption-at-rest implementation evidence; owner must define KMS/key source, rotation and backup-recovery boundary before custom encryption is designed.
  - CO-019: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-020: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-021: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-022: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-023: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-024: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-025: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-026: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-027: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-028: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
- No guessed membership, invitation, transfer, deletion, billing-owner or tenant-lifecycle semantics were implemented. The approval register records the missing catalogue text and the owner decisions that would change schema/security behavior. There is no safe feature-level code change to make until those contracts are supplied; independent CO work remains available elsewhere.


### CO-029–CO-044 permissions and policy audit (2026-11-05)
- Compared `main` and `mistral` before this audit. Neither source tree contains a CO authorization/permissions/roles/policy module. The only matching Mistral path outside identity is `src/modules/web-search/engine/domain-policy.ts`, which belongs to the AI web-search feature range and is excluded from CO. `src/modules/identity/routes.ts` and `src/kernel/http.ts` are byte-identical across branches.
- Individual evidence-based classifications:
  - CO-029: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-030: PARTIAL. `IdentityService.authenticate()` is used by `GET /v1/auth/me` and the focused regression checks missing/invalid identity session cookies. This is identity-session authentication only; no CO resource/tenant authorization policy module or reusable policy guard is evidenced.
  - CO-031: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-032: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-033: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-034: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-035: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-036: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-037: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-038: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-039: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-040: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-041: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-042: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-043: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-044: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
- The approval register still blocks security-sensitive policy implementation on exact catalogue wording and the owner's role, permission, delegation and precedence model. No roles, inheritance rules or allow precedence were invented. No safe independent CO policy code change is currently defined by the repository documents.


### CO-045–CO-062 project intelligence graph audit (2026-11-05)
- Compared the current `main` and `mistral` source trees before this audit. Neither contains a CO project-intelligence graph module, graph schema/migration, graph store or graph query route. The only graph-named Mistral source file found is `src/modules/test-generation/engine/integration-graph.ts`, which belongs to TQ test generation and is excluded from CO.
- Individual evidence-based classifications:
  - CO-045: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-046: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-047: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-048: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-049: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-050: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-051: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-052: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-053: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-054: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-055: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-056: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-057: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-058: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-059: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-060: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-061: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-062: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
- No graph ontology, node/edge types, source-of-truth rules, visibility, deletion or retention semantics were invented. These are owner-dependent product/data decisions and the exact Part 01 wording is absent; the approval register records the specific decisions needed.


### CO-063–CO-080 event backbone and audit ledger audit (2026-11-05)
- Compared the current main/Mistral implementations before this audit. Mistral differs in `src/kernel/events.ts` and `src/kernel/canonical.ts` (runtime envelope validation and canonical payload hardening), and in the identity unit-of-work plus SQLite/PostgreSQL identity stores (transactional identity writes). The SQLite/PostgreSQL event-store adapters, kernel migrations and identity event registry are byte-identical across branches.
- Individual evidence-based classifications:
  - CO-063: IMPLEMENTED documented foundation. `EventDraft`/`EventEnvelope`, runtime actor/subject/payload/cause validation, finite/range timestamp checks and deterministic canonical JSON are present. Focused CO typecheck and regression workflow passed on corrected commit `d8df572ea1f59ddf92a0382a489b105ac81881bf`. Exact Part 01 acceptance wording remains unavailable.
  - CO-064: PARTIAL. SQLite/PostgreSQL append-only triggers and hash-linked sequence storage exist, and the verifier recomputes links/hashes. A real PostgreSQL integration/privilege run is not evidenced in this execution context; an internal chain alone cannot detect tail truncation.
  - CO-065: PARTIAL. SQLite/PostgreSQL identity registration, sign-in session creation, sign-out and compromised-password transitions use transactional state-plus-event writes. This does not establish atomicity for every CO domain. EventDispatcher remains best-effort in-process delivery without durable retry/offset/dead-letter behavior.
  - CO-066: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-067: PARTIAL. `src/modules/identity/events.ts` publishes the identity event names/version, but no global CO event-schema registry or complete catalog-wide registry is evidenced.
  - CO-068: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-069: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-070: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-071: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-072: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-073: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-074: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-075: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-076: PARTIAL. Internal chain verification plus the new fail-closed `verifyChainAgainstAnchor()` primitive are focused-workflow verified. No trusted external anchor store or append/checkpoint coordination exists yet.
  - CO-077: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-078: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-079: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-080: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
- These classifications use only explicit repository notes and code evidence. No names or acceptance criteria were invented for the unmapped IDs. The real-PostgreSQL proof, durable event-delivery policy and independent anchor destination remain in the approval register.


### CO-081–CO-090 context engine audit (2026-11-05)
- Compared `main` and `mistral` source trees before this audit. Neither has a dedicated CO context-engine module. Mistral's only context/retrieval-named source tree is `src/modules/workspace-retrieval`, which the progress catalogue explicitly places in AI-062–AI-072; it is excluded from CO and is not counted as a CO context engine.
- Individual evidence-based classifications:
  - CO-081: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-082: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-083: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-084: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-085: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-086: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-087: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-088: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-089: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-090: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
- The section heading "Context engine" is insufficient to infer context sources, user visibility, privacy boundaries, expiry, summarization or retention. No such behavior was invented. The exact original Part 01 text is required before a safe CO implementation can be designed.


### CO-091–CO-100 platform reliability audit (2026-11-05)
- Compared `main` and `mistral` before this audit. Mistral adds `src/kernel/health.ts` and focused readiness tests; its `rate-limit.ts`, `backup.ts` and `main.ts` differ from main. Main has none of the CO-focused readiness, rate-limit or backup regression files. The exact Mistral file SHAs and limitations are preserved in the earlier CO-091/093/096 implementation notes.
- Individual evidence-based classifications:
  - CO-091: PARTIAL. `/healthz` is storage-independent; `/readyz` proves the event-store/database can answer and returns safe 503 on failure. No evidence covers all future external dependencies or deployment SLO thresholds.
  - CO-092: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-093: PARTIAL. Bounded in-memory sliding-window and account-lockout protections are tested. They do not coordinate limits across multiple application replicas; shared-store selection and abuse policy remain owner-dependent.
  - CO-094: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-095: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-096: PARTIAL. SQLite snapshots require a checksum sidecar and pass SQLite integrity plus internal event-chain verification. Automated off-site PostgreSQL backup/restore and RPO/RTO proof are absent.
  - CO-097: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-098: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-099: MISSING implementation evidence; individual feature name/acceptance criteria unavailable.
  - CO-100: MISSING implementation evidence and OWNER-BLOCKED. Offline sync conflict resolution is explicitly flagged high risk; no merge/delete/authority precedence policy or exact catalogue acceptance wording is available.
- The corrected focused workflow [42006742090](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42006742090) passed the isolated CO typecheck and focused CO tests covering the current readiness, rate-limit, backup and identity regressions. This does not convert distributed rate limiting or off-site PostgreSQL backup into complete features.


### CO-001 sequential re-audit and hardening (2026-11-05)

- Re-opened CO-001 before proceeding to CO-002. Compared the live `main` and `mistral` branch heads and the CO-001 source files. At this snapshot, `src/modules/identity/breach-check.ts` and `test/password.test.ts` had identical blob SHAs on both branches; Mistral's `identity-service.ts` contains additional transactional session/event work.
- **Classification: IMPLEMENTED for the explicit CO-001 behavior in `docs/features/CO-001.md`, with the limitations listed there.** The end-to-end registration/sign-in/sign-out/session-check paths, password policy, HIBP range check, hash upgrade and session lifecycle exist. Email verification, password reset/change endpoints and native-client token flows remain later-feature scope; they are not counted as CO-001 completion.
- **Defect corrected:** the HIBP parser previously used permissive `parseInt` handling and could accept an empty or malformed successful response as “clean”. It now requires HTTP 200, a non-empty set of unique 35-hex suffix rows and non-negative safe-integer counts. Empty, malformed, duplicate or overflowing data returns `unavailable`; registration therefore follows its documented fail-closed default.
- A valid sign-in whose optional breach recheck is unavailable still succeeds, as required, and now emits a best-effort `identity.password.breach_check_skipped` event with `stage: sign_in`.
- The first workflow expansion attempted to include the full HTTP/SQLite/PostgreSQL identity integration suites. GitHub Actions exposed that these tests import the full app composition root and therefore pull in the unrelated AI-only parse defect at `src/modules/ai-training/sqlite-stores.ts`. Those integration suites were removed from the isolated CO typecheck/test command, not deleted from the repository.
- Added `test/identity-service.test.ts`, a direct `IdentityService` unit harness with no app composition-root import. The CO workflow now typechecks the identity source and this isolated regression while executing `test/password.test.ts` and the other independent CO suites.
- **Verified focused result:** workflow [42018281648](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42018281648) completed successfully. `npx tsc -p tsconfig.co.json --noEmit` passed; the focused Node test command reported **45 tests, 45 passed, 0 failed**. This validates the HIBP malformed-response behavior and the new sign-in-outage audit-event unit test, but not the full HTTP/SQLite/PostgreSQL identity integration suites.
- **Full repository CI remains blocked outside CO:** workflow [42018281651](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42018281651) failed at `npm run typecheck` on syntax errors in `src/modules/ai-training/sqlite-stores.ts`; tests were skipped. No AI/TQ file was changed.
- Post-push source inspection caught and corrected two escaping mistakes before the successful workflow: the parser uses `text.split(/\\r?\\n/)` and `/(\\d+)/`, and malformed response fixtures contain real TypeScript `\\n` escape sequences. Corrections are on Mistral commits `e42278d022a1e8b56b9bc5cd10fc63c6a3ee7df5` and `4de33697be66f020ee042010f77c8d845e017078`.
- A concurrent subsequent Mistral commit `e60db6a483e2e0b7196b078a8382d6243ea539bf` adds an identity session-revocation event constant. It was preserved, not authored or treated as evidence that CO-006 is complete.

## CO-006 session manager implementation delta (2026-11-05)

- Compared `main` and `mistral` before implementation. The active Mistral branch is the Core destination; the one main-only commit remains a collaboration-rules documentation change and was not merged.
- Added owner-scoped active-session queries that apply both absolute and idle-expiry checks.
- Added `GET /v1/auth/sessions` and `POST /v1/auth/sessions/revoke`. The service derives the account from the validated cookie session; it does not accept a caller-supplied user ID.
- Foreign and unknown session IDs resolve to the same 404 response. Current-session revocation clears the cookie; revoking another device leaves the current cookie untouched.
- Added `identity.session.revoked` audit events and explicit `session_manager` reason handling. In-memory, SQLite and PostgreSQL unit-of-work paths share the same reason contract; the existing sign-out default remains `user_sign_out`.
- Added `test/co-006-session-manager.test.ts` for owner isolation, token non-disclosure, malformed/unknown/foreign ID handling, audit event, other-device revoke and current-session cookie clearing.
- **Classification:** implementation candidate present, but catalogue acceptance remains unverified until the exact owner-supplied CO-006 wording is available. Do not mark CO-006 as owner-accepted solely because the implementation exists.
- **Verification boundary:** CO-focused workflow now typechecks the kernel/identity slice and directly imported tests without importing `src/app.ts`, which pulls in the unrelated AI module. The full repository CI still has a separate AI TypeScript syntax blocker in `src/modules/ai-training/sqlite-stores.ts`; no AI files were changed here. A real PostgreSQL connection is still not configured in the CO workflow, so the PostgreSQL adapter fallback is not native PostgreSQL proof.
- **Delta carry-forward:** no CO-002/003 provider origins or credentials, CO-004 SSO trust metadata, CO-005/007/008/009 identity contracts, CO-017 RLS decision, CO-018 key custody, policy vocabulary, graph ontology, external event anchor, durable event-delivery policy, or CO-093/096 production deployment dependencies were removed or silently approved. They remain in `docs/CO_APPROVAL_NEEDED.md`.

## CO-012 sign-in anomaly detection delta (2026-11-05)

- Built an observe-only identity anomaly detector on top of the active-session query added for CO-006.
- After a valid password check, the service compares the current IP/user-agent pair against that account's currently active sessions. It emits only signal names and a baseline label; raw IP and user-agent values are not copied into the anomaly event.
- A missing baseline, incomplete metadata or detector/store failure does not block sign-in. The implementation does not create risk scores, challenge thresholds, lockouts, session revocations, geolocation conclusions or notification actions.
- Added unit coverage for same-device, new-IP, new-user-agent, device-pair change, no baseline, insufficient metadata and value non-disclosure. Added a service-level test for the emitted value-safe event and successful sign-in.
- **Classification:** partial implementation only. Current-session comparison is not a complete behavioral anomaly system; exact CO-012 catalogue criteria and owner-approved alert/challenge/retention semantics remain outstanding.
- **Delta dependency:** depends on CO-006 session-store active-session enumeration. CO-006's owner-approval state remains unchanged until exact CO-006 catalog wording is reconciled.

## CO-002 WebAuthn and CO-007 native-session implementation delta (2026-11-05)

### CO-002 — passkey protocol core
- The Mistral branch now contains a bounded WebAuthn parser/verifier: 32-byte challenges, discoverable credential options, exact origin/RP-ID validation, bounded CBOR, none attestation only, COSE public-key extraction and assertion signature/counter/user-handle validation.
- A regression caught an invalid origin-configuration acceptance path. Validation was tightened so both registration and assertion verification enforce RP-ID/origin pairing; wildcard, unrelated and localhost-mismatched origins are rejected.
- Focused verification run [42020699101](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42020699101) passed the isolated TypeScript check and 64 tests, 64 passed, 0 failed for the passkey-core regression set at that commit.
- After native token tests were added to the same workflow, run [42020719423](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42020719423) passed typecheck and 67 tests, 67 passed, 0 failed.
- Classification: PARTIAL. There is still no durable one-time challenge store, credential repository, registration/sign-in route, credential lifecycle, production RP domain or stored counter-race handling. None attestation does not attest authenticator provenance. Exact CO-002 catalogue wording is unavailable.

### CO-007 — native bearer session path
- Added a native sign-in response that issues an opaque 256-bit server-managed bearer session without setting a browser cookie; the server persists only the token hash.
- Bearer credentials now authenticate across the protected module route set and session-management routes. Native sign-out revokes the same server-managed session.
- An explicitly present but malformed Authorization header fails closed and cannot fall back to a browser cookie. Existing browser-cookie behavior is preserved when Authorization is absent.
- The focused suite includes native sign-in, bearer access, session list/revoke, sign-out, no-cookie behavior and malformed-header no-fallback tests. It was included in the same 67/67 successful focused run.
- Classification: provisional capability; acceptance unverified. It is an opaque server-side session token, not a JWT or OAuth access/refresh token. Refresh rotation, app attestation and offline grace semantics were not inferred. Exact CO-007 wording and approved audience/lifecycle remain owner-dependent.

### Verification boundary
- The CO-focused workflow runs typecheck and identity/Core regressions independently of the unrelated AI import path.
- Full repository CI still fails at global typecheck due existing syntax errors in src/modules/ai-training/sqlite-stores.ts; this is outside the Core identity changes. No AI file was modified.
- The CO workflow has no real PostgreSQL test connection secret configured. PostgreSQL adapter paths are not claimed as native PostgreSQL integration proof.

## CO-002 verified implementation delta (2026-11-05, supersedes protocol-only summary)

- Added persisted, owner/purpose-bound, one-time registration/authentication challenges; public-key credential records; in-memory, SQLite and PostgreSQL store adapters; owner-scoped registration/list/removal; discoverable authentication; counter/backup metadata validation; and browser/native completion routes.
- Creation, assertion counter updates and removal are transactionally coupled to audit append in the SQLite and PostgreSQL stores. In-memory credential mutations are serialized to avoid concurrent duplicate, stale-counter and delete/update races.
- Added a separate passkey IP throttle bucket and strict startup validation requiring `FORGE_WEBAUTHN_RP_ID` and `FORGE_WEBAUTHN_ORIGINS` as a valid pair. Production RP values are not set in source.
- Focused run [42024518400](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42024518400) passed the CO-focused typecheck and **88 tests (88 passed, 0 failed)** at commit `b0297ee5c6c89748a57d9aa0439dd3724f830b00`.
- **Classification:** implementation-complete for the currently coded backend ceremony/lifecycle; not owner-accepted and not production-activated. Exact catalogue acceptance text is still unavailable. PostgreSQL adapter has not yet been exercised against a real PostgreSQL CI service. Shared/distributed throttle enforcement remains CO-093 work.
- **Activation hold:** relying-party production domain/origins, customer domain-control evidence, accepted authenticator/attestation policy and production database proof remain attached to CO-002. None was supplied or inferred.
- **Feature transition:** the native bearer completion path is recorded under CO-007 as an integration dependency, but it does not transfer or close CO-007 token audience/refresh/device decisions. CO-002 retains its own RP and authenticator dependencies.

## CO-003 / CO-005 identity-extension implementation delta (2026-11-05)

### CO-003 — provider-neutral OIDC groundwork
- Added strict provider configuration validation and an authorization-code transaction core with cryptographic state, nonce and PKCE S256.
- State and nonce are stored as SHA-256 digests. The PKCE verifier stays server-side in the in-memory transaction store; it is never returned from the authorization-start operation.
- Callback state consumption is one-time; expiry, replay and wrong-provider callback attempts fail closed. Concurrent callback attempts can consume a state only once.
- No provider, credentials, redirect URI, issuer, account-linking rule, external token exchange, ID-token/JWKS verifier or callback HTTP endpoint was invented.
- Focused run [42025408190](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42025408190) passed typecheck and **94/94 tests** with the OIDC authorization transaction suite included.
- **Classification: PARTIAL / NOT ACTIVATED.** The transaction store is in-memory and does not survive restart or support multi-replica routing; provider-specific validation and safe account linking remain open.

### CO-005 — TOTP primitives
- Added cryptographic secret generation (20–64 bytes), canonical Base32 encode/decode, RFC 6238 HMAC-SHA1/SHA256/SHA512 code generation, explicit 6/8 digit and time-period configuration, explicit ±0–2 step verification window and constant-time candidate comparison.
- Verification returns the matched moving factor so a future persistence implementation can atomically prevent replay. No TOTP secret store or MFA enforcement was added.
- Added an explicit-option `otpauth://totp` provisioning URI generator; the URI contains the secret and must never be logged.
- Focused verification includes RFC 6238 SHA-1 vectors, Base32, drift-window, invalid-input and provisioning-URI tests. The corrected vector suite was included in CO-focused workflow [42024518400](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42024518400), whose isolated CO typecheck and regression-test step both completed successfully (88 tests, 88 passed, 0 failed). This is focused-slice evidence, not full-repository CI or real-PostgreSQL proof.
- **Classification: PARTIAL.** Enrollment/confirmation, encrypted secret persistence, step replay CAS, step-up or mandatory enforcement, recovery/backup codes and support reset workflows remain unimplemented.

### Cross-feature transition
- CO-003 provider selection/credentials, issuer/JWKS policy, verified-email and linking rules remain attached to CO-003 and are not moved into CO-004.
- CO-005 MFA enforcement, recovery and seed key custody remain attached to CO-005. The TOTP primitive does not make CO-005 complete.
- CO-007 native token transport remains separate. No OIDC provider login or native refresh token was silently enabled.


## CO-004 and CO-005 ordered audit checkpoint (2026-11-05)

### CO-004 — enterprise SSO
- **Classification: MISSING / OWNER-BLOCKED.** The Mistral branch has no CO-004 feature specification, SSO route, or dedicated SAML/OIDC federation implementation. The corresponding files are also absent from `main`; the existing provider-neutral OIDC authorization transaction for CO-003 is not enterprise SSO and is not counted.
- Evidence: `docs/CO_APPROVAL_NEEDED.md` records customer-specific issuer metadata, signing certificates and tenant federation settings as not supplied. No SSO-specific HTTP surface or trust configuration is present in `src/modules/identity/routes.ts`.
- Exact CO-004 Part 01 acceptance wording is unavailable. Do not choose SAML, OIDC, just-in-time provisioning, domain discovery, account linking or tenant-mapping semantics by assumption.
- **Owner inputs needed:** exact CO-004 catalogue text; protocol(s) and supported federation profile; account/tenant provisioning and linking rules. Customer-specific issuer metadata, signing certificates, client credentials (if applicable), callback/ACS URLs and test IdP access are activation-time inputs.
- Independent work may resume once the protocol/profile and provisioning contract are verified. No external SSO provider has been connected and no production activation is claimed.

### CO-005 — multi-factor authentication
- **Classification: PARTIAL.** `src/modules/identity/totp.ts` and `test/totp.test.ts` provide RFC 6238 TOTP primitives, canonical Base32 handling, explicit algorithm/digit/period/window parameters, constant-time code comparison and the matched moving factor required for future replay prevention. `docs/features/CO-005.md` records the missing enrollment, encrypted seed persistence, replay store, enforcement and recovery paths.
- Verification correction: workflow [42024518400](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42024518400) completed the isolated CO typecheck and test step successfully; the run included `test/totp.test.ts` and reported 88/88 tests passing. The previous note that the corrected vector rerun was pending is superseded.
- No production MFA claim: no secret persistence, replay prevention, enrollment, login enforcement, recovery or account reset flow is implemented. The exact catalogue wording and owner policy remain outstanding.
- **Owner inputs needed:** optional/mandatory/step-up policy; accepted algorithms, digits, period and drift; enrollment confirmation; KMS/key custody and rotation/recovery; backup-code and assisted-reset authority. No TOTP seed is stored or exposed by this primitive-only implementation.


## CO-008–CO-014 individual identity audit (2026-11-05)

The following checks compare the current `mistral` implementation with `main`. The original Part 01 wording for these IDs is not present in the repository, so the classifications below are limited to the feature labels and explicit gaps already recorded in project documentation.

| Feature | Classification | Concrete evidence and boundary |
| --- | --- | --- |
| CO-008 — account verification / password recovery | **MISSING** | `docs/PROGRESS.md` explicitly lists email verification, password reset and recovery as outstanding under CO-008. The Mistral and main identity route tables do not expose verification, reset-request or reset-completion endpoints. No mail delivery provider is connected. Do not choose token lifetime, enumeration behavior, recovery identity proofing or session-revocation policy without the original acceptance text. |
| CO-009 — desktop session tokens | **MISSING / ACCEPTANCE UNVERIFIED** | `docs/features/CO-007.md` explicitly says desktop token behavior is separate and not covered by CO-007. Mistral adds the native bearer route and shared session credential parser, but no desktop-specific client enrollment, token audience or lifecycle contract is evidenced. Do not count the native bearer path as desktop support. |
| CO-010 — unnamed identity feature | **MISSING / ACCEPTANCE UNVERIFIED** | No individual CO-010 description or feature spec is present in the repository. The identity route/service files do not provide evidence that can safely be attributed to this unnamed ID. No title or behavior is inferred. |
| CO-011 — agent identity | **MISSING** | The event envelope permits `ActorKind = 'agent'`, but that is audit attribution only. There is no agent credential issuance, authentication, identity lifecycle or revocation evidence in the identity service/routes. Agent actor metadata is not an authenticated agent principal. |
| CO-012 — sign-in anomaly detection | **PARTIAL** | `src/modules/identity/identity-service.ts` compares the current request with currently active sessions and emits value-safe signal names. `docs/features/CO-012.md` records observe-only behavior. No historical behavioral model, alerting, risk threshold, challenge or automatic account action is implemented; exact catalogue acceptance remains unavailable. |
| CO-013 — unnamed identity feature | **MISSING / ACCEPTANCE UNVERIFIED** | No individual CO-013 description/spec or attributable implementation evidence exists in the repository. No feature title or semantics are invented. |
| CO-014 — unnamed identity feature | **MISSING / ACCEPTANCE UNVERIFIED** | No individual CO-014 description/spec or attributable implementation evidence exists in the repository. No feature title or semantics are invented. |

### Ordered owner-blockers and next independent work
- CO-008 requires the exact feature contract for email verification and recovery, approved identity-proofing and anti-enumeration behavior, token expiry/replay/session policy, plus a delivery provider and sender credentials for activation. No recovery endpoint or token store was added.
- CO-009 requires the exact desktop-client audience, credential storage and revocation/expiry contract. Native CO-007 bearer sessions are not relabelled as desktop support.
- CO-010, CO-013 and CO-014 remain blocked only on the missing exact catalogue descriptions and acceptance criteria; their feature names are intentionally not guessed.
- CO-011 requires the exact agent principal model, credential issuance/rotation/revocation and allowed agent scopes. The event actor enum does not satisfy these requirements.
- CO-012 remains partial pending exact acceptance criteria and explicit approval for any automated response or new telemetry retention.
- Continue to CO-015 and other independent Core ranges; these identity gaps do not block unrelated work.


## CO-015–CO-028 individual workspace / tenancy audit (2026-11-05)

Compared the relevant Mistral and main paths before classification. No dedicated `src/modules/tenancy`, `src/modules/workspaces`, tenant-context, tenant-service or workspace-service implementation exists at the inspected paths in either branch. The AI workspace-retrieval module is outside CO and is not counted.

| Feature | Classification | Evidence / limitation |
| --- | --- | --- |
| CO-015 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated workspace/tenant implementation evidence in either branch; exact feature title and behavior are absent from repository documentation. |
| CO-016 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated implementation evidence; exact feature title and acceptance criteria are unavailable. |
| CO-017 — tenant isolation | **MISSING / OWNER-BLOCKED** | The progress record describes the unresolved app-code-only versus PostgreSQL RLS second-lock decision. No tenant-scoped repository/service or RLS migration/policy was found at the inspected paths. The owner has recorded app-side scoping as the initial direction, but has not approved the RLS boundary. |
| CO-018 — encryption at rest / key custody | **MISSING / OWNER-BLOCKED** | No application encryption/key-management module was found at the inspected paths. The project record explicitly leaves the key source, rotation, recovery and backup-encryption boundary unresolved. Database-host encryption cannot be claimed as application-managed encryption. |
| CO-019 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated implementation evidence; exact feature title and acceptance criteria are unavailable. |
| CO-020 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated implementation evidence; exact feature title and acceptance criteria are unavailable. |
| CO-021 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated implementation evidence; exact feature title and acceptance criteria are unavailable. |
| CO-022 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated implementation evidence; exact feature title and acceptance criteria are unavailable. |
| CO-023 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated implementation evidence; exact feature title and acceptance criteria are unavailable. |
| CO-024 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated implementation evidence; exact feature title and acceptance criteria are unavailable. |
| CO-025 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated implementation evidence; exact feature title and acceptance criteria are unavailable. |
| CO-026 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated implementation evidence; exact feature title and acceptance criteria are unavailable. |
| CO-027 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated implementation evidence; exact feature title and acceptance criteria are unavailable. |
| CO-028 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated implementation evidence; exact feature title and acceptance criteria are unavailable. |

### CO-017 / CO-018 owner boundary
- CO-017: confirm whether PostgreSQL RLS is required as a second isolation layer, and the intended database role/connection strategy. Do not ship permissive or guessed tenant policies.
- CO-018: supply/approve the KMS or owner-managed key source, key rotation, recovery, service access and backup-encryption boundary. Do not invent cryptography or store secrets in plaintext.
- The exact individual Part 01 descriptions for CO-015–CO-028 remain required before feature-level acceptance or schema semantics can be claimed. Continue unrelated Core work while these decisions remain open.


## CO-029–CO-044 individual permissions / policy audit (2026-11-05)

Compared Mistral and main before classifying the permission surface. No dedicated `src/modules/authorization`, `src/modules/permissions`, `src/kernel/authorization.ts` or `src/kernel/policy.ts` implementation exists at the inspected paths in either branch. The identity session check and authentication transport are not a role/permission policy engine.

| Feature | Classification | Evidence / limitation |
| --- | --- | --- |
| CO-029 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated authorization or permission implementation evidence in either branch; exact feature title/criteria unavailable. |
| CO-030 — authenticated session check | **PARTIAL** | `src/modules/identity/identity-service.ts` implements `authenticate()`; `src/modules/identity/routes.ts` uses it for `GET /v1/auth/me`. This validates an identity session, not resource ownership, tenant membership or action-level permission decisions. |
| CO-031 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-032 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-033 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-034 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-035 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-036 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-037 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-038 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-039 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-040 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-041 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-042 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-043 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |
| CO-044 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated permission/policy implementation evidence; exact feature title/criteria unavailable. |

### Owner decisions required before policy implementation
- Exact Part 01 wording for CO-029–CO-044.
- Canonical role vocabulary, permission/resource/action model, inheritance and delegation rules, role assignment authority, policy precedence and deny/allow conflict behavior.
- Tenant ownership and membership semantics from CO-015–CO-028; a policy engine must not bypass tenant scoping.
- CO-030's existing identity session check remains a partial foundation only. Do not mark it as full authorization or infer policy behavior from the presence of an authenticated session.


## CO-045–CO-062 individual project intelligence graph audit (2026-11-05)

Compared Mistral and main at candidate graph/service paths. No dedicated `src/modules/project-graph`, `src/modules/graph`, `src/modules/projects/graph.ts`, `src/modules/project-intelligence` or `src/kernel/graph.ts` implementation was found in either branch. The TQ test-generation integration graph and AI workspace retrieval are outside CO and are not counted.

| Feature | Classification | Evidence / limitation |
| --- | --- | --- |
| CO-045 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-046 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-047 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-048 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-049 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-050 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-051 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-052 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-053 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-054 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-055 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-056 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-057 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-058 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-059 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-060 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-061 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-062 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated project-intelligence graph module, feature spec or attributable graph schema/query implementation was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |

### Graph owner decisions required
- Exact Part 01 description and acceptance criteria for each ID.
- Approved node/edge ontology, stable identifiers, provenance/source-of-truth rules, versioning and duplicate-resolution behavior.
- Visibility and access-control rules, including how graph reads and mutations inherit tenant and project permissions.
- Deletion, retention, archival and referential-integrity behavior.
- Query semantics, indexing and expected scale once the catalogue requirements are known.

No graph schema or service was invented from the section heading. The range remains missing pending exact feature requirements and the owner-approved ontology; unrelated Core work continues.


## CO-063–CO-080 individual event backbone / audit ledger audit (2026-11-05)

Compared event store, canonicalization, migration, identity event registry and focused test files between Mistral and main. Core event-store files are inherited in both branches; Mistral-specific canonicalization hardening and focused regressions are additional changes. The exact individual Part 01 descriptions are unavailable for this range; classifications below reflect only concrete code and explicit project documentation.

| Feature | Classification | Evidence / limitation |
| --- | --- | --- |
| CO-063 | **IMPLEMENTED FOUNDATION** | `src/kernel/canonical.ts` and `src/kernel/events.ts` provide deterministic JSON canonicalization and runtime-validated event envelopes. Mistral adds sparse-array/cycle/prototype rejection and runtime shape checks; focused test `test/co-063-canonical-payload.test.ts` covers these cases. Exact catalogue acceptance remains unavailable. |
| CO-064 | **PARTIAL** | SQLite/PostgreSQL append-only hash-chained stores and migrations exist. PostgreSQL event writes serialize chain extension with an advisory transaction lock; SQLite/PostgreSQL migrations protect UPDATE/DELETE, and PostgreSQL also blocks TRUNCATE. Native PostgreSQL execution is not proven: `test/pg-helpers.ts` falls back to a SQLite-backed pool unless `FORGE_TEST_POSTGRES_URL` is set. |
| CO-065 | **PARTIAL** | Transactional event coupling is implemented and regression-tested for identity session creation/sign-out/password-compromise writes in `src/modules/identity/unit-of-work.ts`, SQLite and PostgreSQL adapters. No global transactional outbox, durable subscriber delivery, consumer offsets, retry/dead-letter lifecycle or proof for other domains is present. |
| CO-066 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |
| CO-067 | **PARTIAL** | `src/modules/identity/events.ts` defines a versioned identity event-name contract. This is an identity-only registry, not a global schema registry or compatibility/deprecation lifecycle. |
| CO-068 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |
| CO-069 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |
| CO-070 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |
| CO-071 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |
| CO-072 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |
| CO-073 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |
| CO-074 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |
| CO-075 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |
| CO-076 | **PARTIAL** | `verifyChain()`, `verifyEventsTable()`, `PostgresEventStore.verify()` and `verifyChainAgainstAnchor()` verify internal chain integrity and compare a supplied trusted head checkpoint. The external anchor storage/writer, independent credentials and monotonic persistence are not integrated. |
| CO-077 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |
| CO-078 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |
| CO-079 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |
| CO-080 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature title/criteria or attributable implementation evidence is present in repository docs. |

### Verification boundary and owner-dependent work
- The CO-focused workflow [42024518400](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42024518400) completed its isolated CO typecheck and test step successfully. This is not native PostgreSQL proof.
- `test/pg-helpers.ts` explicitly selects `createSqliteBackedPool()` when `FORGE_TEST_POSTGRES_URL` is absent. The workflow references that secret, but no configured real database is evidenced. The PostgreSQL unit-of-work test can therefore pass against the stand-in.
- CO-064 remains partial until native PostgreSQL migration, append, concurrency, verification and privilege/trigger behavior are exercised against a real PostgreSQL service.
- CO-065 remains partial until durable subscriber-delivery semantics are specified and implemented; the transactional source write alone does not establish delivery guarantees.
- CO-076's verifier can compare a trusted checkpoint but cannot create trust. The owner must approve the independent anchor destination, retention/availability policy and credentials. A checkpoint in the same event database does not protect against database-level truncation.
- CO-067 remains identity-scoped. Do not infer a global event registry from the existing identity event constants.


## CO-081–CO-090 individual context engine audit (2026-11-05)

Compared candidate CO context modules and stores in Mistral and main. No dedicated `src/modules/context`, `src/modules/context-engine`, `src/modules/project-context`, `src/kernel/context.ts` or `src/kernel/context-store.ts` implementation was found at the inspected paths. AI workspace retrieval, AI memory and TQ context used for test generation are separate feature families and are not counted as CO.

| Feature | Classification | Evidence / limitation |
| --- | --- | --- |
| CO-081 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated CO context-engine module, feature specification or attributable context store/route was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-082 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated CO context-engine module, feature specification or attributable context store/route was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-083 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated CO context-engine module, feature specification or attributable context store/route was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-084 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated CO context-engine module, feature specification or attributable context store/route was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-085 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated CO context-engine module, feature specification or attributable context store/route was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-086 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated CO context-engine module, feature specification or attributable context store/route was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-087 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated CO context-engine module, feature specification or attributable context store/route was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-088 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated CO context-engine module, feature specification or attributable context store/route was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-089 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated CO context-engine module, feature specification or attributable context store/route was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |
| CO-090 | **MISSING / ACCEPTANCE UNVERIFIED** | No dedicated CO context-engine module, feature specification or attributable context store/route was found at the inspected paths in either branch. Exact feature title and acceptance criteria are unavailable. |

### Owner decisions required before implementation
- Exact Part 01 description and acceptance criteria for each CO-081–CO-090 ID.
- Approved context source types and source-of-truth hierarchy.
- Data visibility, tenant/project scope, user consent and deletion behavior.
- Expiry, retention, summarization, versioning and recovery semantics.
- Any sensitive-data handling, access logging and export requirements.

No context schema, retention period or source priority was invented. This range remains missing pending exact acceptance text and approved privacy/lifecycle rules; unrelated Core work continues.


## CO-091–CO-100 individual platform reliability audit (2026-11-05)

Compared Mistral and main health, limiter, identity throttle, backup and focused-test paths before classification. Mistral has targeted hardening relative to main for the limiter and backup verifier. The exact individual Part 01 descriptions remain unavailable for this range.

| Feature | Classification | Evidence / limitation |
| --- | --- | --- |
| CO-091 | **PARTIAL** | `src/kernel/health.ts` exposes storage-independent `/healthz` and `/readyz` which checks `EventStore.head()`. `test/co-091-readiness.test.ts` verifies ready and unavailable-storage responses. It does not probe every external dependency or establish SLOs. |
| CO-092 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature description or attributable reliability implementation evidence is present in repository docs. |
| CO-093 | **PARTIAL** | `src/kernel/rate-limit.ts` and `src/modules/identity/throttle.ts` provide bounded process-local sliding windows and account lockout. Mistral fixes fail-open key eviction and validates bounds; focused tests cover capacity churn. There is no shared atomic multi-replica store. |
| CO-094 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature description or attributable reliability implementation evidence is present in repository docs. |
| CO-095 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature description or attributable reliability implementation evidence is present in repository docs. |
| CO-096 | **PARTIAL** | `src/kernel/backup.ts` creates/verifies SQLite snapshots with required checksum sidecar, SQLite integrity and event-chain checks. `test/backup.test.ts` covers missing/invalid/mismatched checksum cases. Automated PostgreSQL/offsite backup and restore are not implemented. |
| CO-097 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature description or attributable reliability implementation evidence is present in repository docs. |
| CO-098 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature description or attributable reliability implementation evidence is present in repository docs. |
| CO-099 | **MISSING / ACCEPTANCE UNVERIFIED** | No individual feature description or attributable reliability implementation evidence is present in repository docs. |
| CO-100 | **MISSING / OWNER-BLOCKED** | Project docs explicitly flag offline sync conflict resolution as high risk. Exact catalogue criteria and conflict authority/merge/delete/offline replay semantics are absent; no offline sync engine is evidenced. |


### Verification and owner dependencies
- CO-focused workflow [42024518400](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42024518400) completed isolated typecheck and tests, 88/88 passing. This is focused-slice evidence, not full-repository typecheck or production deployment proof.
- CO-093 requires a shared atomic Postgres or Redis limiter store decision and configured service. Current limiter/account lockout remain process-local and cannot enforce a common budget across replicas.
- CO-096 requires R2 account/bucket/credentials, PostgreSQL backup/restore implementation, offsite copy policy and owner-approved RPO/RTO/retention. Current verified backups are SQLite-only.
- CO-100 requires exact feature criteria and owner-approved conflict authority, merge/delete semantics, version-vector/clock strategy (if required), offline replay and conflict UX. No sync algorithm is guessed.
- CO-091 needs approved operational dependency coverage and SLO thresholds before it can be called comprehensive readiness.
- CO-092, CO-094, CO-095 and CO-097–CO-099 remain unclassified beyond missing evidence until exact descriptions are supplied; no feature title is invented.


## Latest CO continuation checkpoint (2026-11-05 18:08 Africa/Lagos)

- Repository: `mildredsylvester763-source/forge-repository`; destination branch: `mistral`; comparison branch: `main`.
- Latest verified Mistral commit from this audit batch: `e9170542ab82f2d814d3491f47790149f51c3a4a` (`docs(co): audit platform reliability features CO-091 to CO-100`). The immediately preceding register update is `379a5418450d954ce8d5011c3afe28644644621b`.
- Latest comparison: `mistral` is 384 commits ahead and 1 behind `main`; merge base remains `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`; `main` head is `ec6716fb5ba6c42e940b748581990df9194a2a2b`. No merge, reset, force-push or main write was performed.
- This batch added individual CO audit records for CO-004, CO-008–CO-011, CO-013–CO-014, CO-015–CO-028, CO-029–CO-044, CO-045–CO-062, CO-063–CO-080, CO-081–CO-090 and CO-091–CO-100. The existing CO-001, CO-002, CO-003, CO-005, CO-006, CO-007 and CO-012 evidence was reconciled where relevant. No completion count is inferred from a section heading.
- Documentation commits in this batch: `99d785e07b3de28e34add1864fb1747e8062aa13`, `6263bf666efa4bc585d594be81e7601a318da259`, `37fab03e903c4212f8a2792c1e705ed7d36e75f5`, `7ed60812e08d1f0c2750a510d427c3a59a585703`, `1a7641b11c43b132e107065a3fc5fdf8a3af3133`, `ce52bebdd09e6aef0d237f296d5726d748b98374`, `eeb21632733a626465e706b58c69299bbd037673`, `2ad119c2cb0bcb93f69430bca2b6b28a7081f7d9`, `6882c562fa1008d0bda540bf119227afb33f5770`, `cd8622afd94616435224310ce121f1cbea01dc88`, `a9b3fca74851b4deb0864fdea23793b69e0ce12d`, `1618306e79565724ac141341fe2a30baa603aef3`, `3b0a3968e68f5fc08b9a912584286d92e36decbc`, `379a5418450d954ce8d5011c3afe28644644621b`, `e9170542ab82f2d814d3491f47790149f51c3a4a`. These were documentation-only; no new source or test code was changed in this batch.
- Verification evidence: focused CO workflow [42024518400](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42024518400) completed the isolated CO typecheck and test steps successfully, 88 passed, 0 failed. `test/pg-helpers.ts` uses a SQLite-backed pool unless `FORGE_TEST_POSTGRES_URL` is set; therefore this run is not evidence of native PostgreSQL integration.
- Full repository CI run [41994200934](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/41994200934) failed at `npm run typecheck`; test step was skipped. The known syntax errors are in AI-only `src/modules/ai-training/sqlite-stores.ts`. No AI/TQ files were changed to address it.
- No local test or typecheck command was run in this environment. Report only the GitHub workflow evidence above.
- The original Part 01 text for CO-002–CO-100 is still unavailable in this repository snapshot. Individual status classifications remain evidence-based but cannot be called catalogue-accepted until the original wording is reconciled.
- Continue ordered implementation on the next run. Prioritize any newly supplied exact CO catalogue text, then the next safe independent implementation. Do not stop on owner-blocked dependencies; carry them forward in `docs/CO_APPROVAL_NEEDED.md`.


## CO implementation continuation checkpoint (2026-11-06 09:42 Africa/Lagos)

### Branch and scope verification
- Repository: `mildredsylvester763-source/forge-repository`; destination branch `mistral`; comparison branch `main`.
- Observed Mistral head before this checkpoint: `684230ba7ff9c3910c85c1bf21457d54faf4f4c6`.
- Observed main head: `ec6716fb5ba6c42e940b748581990df9194a2a2b`.
- Comparison: Mistral is 389 commits ahead and 1 behind; merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`. No main write, merge, reset or force-push.
- Work remained inside CO-002 identity/passkey files and tests. No AI or TQ source was changed.

### CO-002 evidence and classification
- Classification: **PARTIAL — backend implementation and focused verification are present; catalogue acceptance and production activation remain unverified**. The exact Part 01 CO-002 acceptance text was not located in the inspected repository documentation or supplied in the current conversation, so this is not labelled catalogue-complete.
- Evidence: `docs/features/CO-002.md`; `src/modules/identity/passkey-service.ts`; `src/modules/identity/passkey-store.ts`; `src/modules/identity/webauthn.ts`; `src/modules/identity/passkey-routes.ts`; `src/modules/identity/migrations.ts`; `src/modules/identity/postgres-migrations.ts`; `test/webauthn.test.ts`; `test/passkey-store.test.ts`; `test/passkey-service.test.ts`; `test/passkey-routes.test.ts`; `test/identity-service.test.ts`.
- Hardening completed in this run: registration options now exclude credentials already registered to that user; excluded credential IDs/transports are bounded and validated. SQLite and PostgreSQL counter updates reject a backup-state assertion for a credential that is not backup-eligible. Added regression tests for exclusion-list behavior and SQLite backup-eligibility enforcement.
- Known implementation commits in this continuation: `4482e11e57c150794308dc6bbabaa90f1151f48d`, `fdd659203dd7b21515ae1918f731d264cb894e8f`, `dfbdec2a38831255d0247b633dbd9f964a13c858`, `3f5184e0fba8b18ae5644425617397e5532298d0`, `684230ba7ff9c3910c85a5c684f7d8d5d0c204e3` (note: final SHA is the latest test-file commit, not the source implementation commit).
- Focused workflow [42189718374](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42189718374): isolated CO typecheck **passed**; **99 tests passed, 0 failed**. This is the current verified CO test result. It does not prove a live PostgreSQL integration run.
- Full CI [42189718459](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42189718459): failed at the repository-wide TypeScript check before tests. Logged syntax errors are in AI-only `src/modules/ai-training/sqlite-stores.ts` (e.g. TS1005 around lines 503–657). The failure is outside CO scope; AI/TQ files were not modified to repair it.
- CO-002 production/owner dependencies remain in `docs/CO_APPROVAL_NEEDED.md`: exact catalogue wording; production RP ID and exact allowed origins; RP display-name and attestation/authenticator/algorithm/backup-credential policy approval; real PostgreSQL CI/migration proof; shared rate-limit storage for multi-replica enforcement; and native-client secure credential storage/HTTPS integration validation. These do **not** block further provider-neutral backend implementation.

### Next ordered work
- Continue to CO-003 after this CO-002 verification checkpoint. Before each feature, compare `main` and `mistral`, inspect both feature implementations and tests, classify, then implement safe independent work.
- Keep social-provider client IDs/secrets as deployment inputs only. Build and test provider-neutral OAuth/OIDC state, nonce, PKCE, callback, issuer/audience/signature validation and account-linking logic where repository requirements support it; do not invent supported providers or account-linking semantics when exact feature criteria are absent.


## CO-003 implementation continuation checkpoint (2026-11-06 09:54 Africa/Lagos)

### Branch comparison and classification
- Repository: `mildredsylvester763-source/forge-repository`; destination `mistral`; comparison `main`.
- Before CO-003 implementation, main head was `ec6716fb5ba6c42e940b748581990df9194a2a2b`, Mistral head was `76a24d599b123f733f7ae2015269e4561a760105`; Mistral was 392 commits ahead and 1 behind, merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Main did not contain `src/modules/identity/oidc-authorization.ts`, `test/oidc-authorization.test.ts` or `docs/features/CO-003.md`; those provider-neutral OIDC transaction files/spec were Mistral-only. No main changes were ported.
- Classification: **PARTIAL**. Existing state/nonce/PKCE transaction groundwork was expanded into a provider-neutral authorization-code exchange, OIDC discovery/JWKS validation and signed ID-token verifier. The exact Part 01 acceptance text for CO-003 remains unavailable, and no account-linking/session route is claimed.

### Implemented and verified
- New `src/modules/identity/oidc-token.ts`: bounded OIDC discovery and JWKS fetch; exact discovery issuer validation; secure endpoint validation; authorization-code exchange using PKCE and optional server-side client secret; no redirect following; bounded response parsing; RS256, PS256, ES256 and EdDSA/Ed25519 ID-token signature verification; issuer, audience, azp, exp, iat, nbf and nonce validation; explicit `emailVerified` handling.
- New `src/modules/identity/oidc-authentication.ts`: consumes one-time state before network calls, exchanges the authorization code, retrieves provider signing keys and returns only a verified OIDC identity. Replayed callbacks are rejected before another provider request.
- `test/oidc-token.test.ts`: validates RS256, ES256, EdDSA, token exchange, OIDC discovery, JWKS handling, claim mismatches, verified-email semantics and full callback orchestration.
- Focused workflow [42190915585](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42190915585): isolated CO typecheck **passed**; **110 tests passed, 0 failed**.
- Relevant commits: `b7a98269d56e48ed50c7ee438749c146b1521aae` (token engine), `c6d0d755c93e18c6b2b42c18ff3d854d4936596f` (token tests), `52859156d76505b8ea519d9b1b8de28870af4c7a` (focused typecheck inclusion), `3ab6cf82ec9aed0d64864f3895dd042b20502439` (workflow inclusion), `96fd781c1f5e3a862d73768db35a052804b19889` and `a1629ddcefb3b4a960439b5db6861c1bc127d213` (Fetch RequestInit compatibility corrections), `b1571db11a5f9b47ab16a607953389b5bb058e5b` (algorithm allow-list fix), `74b065f783d7a6fefd35d5c3c42503640b726ef6` (ES256/EdDSA tests), `b15a95219b2679f88dba1ab686de2a916c135f2e` (workflow trigger), `ef6df648ce6a1c04bd4816918c542fbc6315d156` (callback orchestration), `b255c30e016fb32c7d34373a4dc8d862d0082c25` (callback test), `11cb65cffc4f4e69e2ec2f13c3772cf31d59b6c2` (discovery validation), `595aa99aff3ede7e0c649b302ed0381df8f6a131` (discovery test).
- Full repository CI continues to fail outside CO at `src/modules/ai-training/sqlite-stores.ts`; AI/TQ was not modified.

### Remaining CO-003 work and external inputs
- No HTTP callback route, external identity-to-user mapping, account-link policy, account creation, or FORGE session issuance exists yet. These remain necessary before claiming social sign-in is complete.
- The transaction store remains in-memory. Multi-instance/restart continuity requires a durable store and approved encryption/key-custody design for the PKCE verifier.
- Provider shortlist and per-provider issuer/client ID/client secret/token endpoint/JWKS endpoint/callback URI are deployment inputs. No provider has been selected or credentials invented.
- Account-linking/auto-provisioning rules and verified-email policy need owner approval. Until then, do not silently match provider email to an existing FORGE account or create a user automatically.
- Continue safe provider-neutral implementation while these external inputs/semantics remain outstanding.


## CO-004 implementation continuation checkpoint (2026-11-06 10:00 Africa/Lagos)

### Branch comparison and evidence
- Repository: `mildredsylvester763-source/forge-repository`; destination `mistral`; comparison `main`.
- Before CO-004 implementation, main head was `ec6716fb5ba6c42e940b748581990df9194a2a2b`, Mistral head was `d1d45d6d0feedfb4075fe4b9d1f2b8f38cfca2ad`; Mistral was 408 commits ahead and 1 behind, merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Main identity/test directories contained no SAML/OIDC modules or related tests. Mistral had the CO-003 OIDC implementation but no SAML implementation or CO-004 feature spec. `docs/CO_APPROVAL_NEEDED.md` explicitly names CO-004 Enterprise SSO and calls for SAML/OIDC protocol support, certificate validation and provisioning contracts. Exact Part 01 CO-004 acceptance text remains unavailable.
- Classification: **PARTIAL** — a secure SAML service-provider engine and durable replay-cache adapters now exist; customer account provisioning, session integration and production activation remain incomplete.

### Implemented and verified
- Added `@node-saml/node-saml@5.2.0` and `src/modules/identity/saml-service.ts`: provider config validation, SP-initiated AuthnRequest, SP metadata, exact IdP issuer/audience configuration, signed response + assertion requirements, `InResponseTo: always`, replayed assertion rejection, bounded assertion age, RelayState bounds and explicit SHA-256 SP request signing when configured.
- Added `src/modules/identity/saml-cache.ts`: provider-namespaced cache plus atomic SQLite/PostgreSQL implementations of `CacheProvider` operations. Request IDs are atomically consumed; replayed assertion IDs use atomic insert-if-absent; entries are bounded and expire.
- Added identity migration v3 for `saml_cache` in both `src/modules/identity/migrations.ts` and `src/modules/identity/postgres-migrations.ts`.
- Added `test/saml-service.test.ts` for config validation, SP metadata, AuthnRequest/RelayState, malformed response rejection, SQLite cache expiry/atomic consumption and provider cache namespacing.
- Focused workflow [42191568654](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42191568654): isolated CO typecheck **passed**; **116 tests passed, 0 failed**.
- Relevant commits: `9e21caaec8716b756925e4c4c21a6d10ae6e134e` (SAML library dependency), `5abb04cd93dd9aae6ea9e00553e4deb99c0fd773` (SAML SP engine), `9bd8511aa23490de8a2c7c8f0dd9cd51e0411dcf` (SAML service tests), `81e61067232b2d33812f63627650d7c29087719d` (focused typecheck inclusion), `ec83aa6e9f9cbf4fffcc315b6efa432c1daa1657` (focused workflow inclusion), `9ca69ca265d61abaa4fadc2ee57ac09579020b6d` and `96f5817fc6f95199623ee2863ad6a7996c81e206` (SQLite/PostgreSQL SAML cache migrations), `fa90d617d33b720cf904f619ad3b92488cd147e4` (durable SAML cache adapters), `bf2e206c9ca6ca4934d83359af9adaf519dc821f` (provider cache namespace), `b44d7bb7fc3c146d30408df42126237c0facf1c7` (require atomic cache operations), `736a69fa31c812fc052f32618046c04100140bc2` (persistent cache test), `ef9c494a5da36416415d25dc7b6575c38118e355` (namespace and atomic capability tests).
- Full repository CI still fails at unrelated AI-only `src/modules/ai-training/sqlite-stores.ts` syntax errors; no AI/TQ files were changed. The focused CO workflow is the valid CO-slice verification.

### Remaining CO-004 work
- Add customer-specific metadata import/validation, callback HTTP integration, verified NameID/attribute mapping, tenant/user provisioning and FORGE session issuance only after owner-approved semantics are available.
- Real PostgreSQL integration/cache concurrency testing remains outstanding. SQLite tests do not prove PostgreSQL behavior.
- SLO, encrypted assertions, SP key rotation and customer certificate rollover remain unimplemented unless exact catalogue criteria later require them.
- External customer IdP details and approval items are listed in `docs/CO_APPROVAL_NEEDED.md`. Do not wait for credentials to continue independent CO backend work.


## CO-005 implementation continuation checkpoint (2026-11-06 10:05 Africa/Lagos)

### Branch comparison and classification
- Repository: `mildredsylvester763-source/forge-repository`; destination `mistral`; comparison `main`.
- Before CO-005 work, main head was `ec6716fb5ba6c42e940b748581990df9194a2a2b`, Mistral head was `6ee2a659b0dac91abde38566bd8e71c5bd640341`; Mistral was 433 commits ahead and 1 behind, merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Main did not contain `src/modules/identity/totp.ts`, `test/totp.test.ts` or `docs/features/CO-005.md`; Mistral contained the documented RFC 6238 primitive slice.
- Classification: **PARTIAL**. TOTP primitives were extended with encrypted enrollment, confirmation, SQLite/PostgreSQL persistence and atomic replay prevention. MFA enforcement and recovery remain owner-policy dependent.

### Implemented and verified
- New `src/modules/identity/totp-store.ts`: SQLite and PostgreSQL factor stores with atomic enrollment activation and moving-factor compare-and-swap; one pending/active factor per user; factor deletion/cancel and pending-expiry operations.
- New `src/modules/identity/totp-service.ts`: AES-256-GCM encrypted seed storage with user-bound associated data, injected 32-byte key, pending enrollment expiry, confirmation before activation, immediate consumption of the enrollment step, replay-safe verification, and code-verified factor disable.
- Identity migration v4 adds `totp_factors` to SQLite and PostgreSQL schemas. The secret is not stored in plaintext; the encryption key is not stored in the database or source.
- New `test/totp-service.test.ts`: encryption-at-rest, confirmation, wrong-code handling, replay rejection, concurrent same-code consumption, pending expiry, wrong-key failure and constructor policy bounds.
- Focused workflow [42192070778](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42192070778): isolated CO typecheck **passed**; **120 tests passed, 0 failed**.
- Relevant commits: `d8441de38c54fc18bce624421a63b762f7e6f301` (factor stores), `2059b9e275074d596850124c45615bc6f48885b9` (SQLite schema), `0214c1692fb569168c4de4c121e1b98bb763196c` (PostgreSQL schema), `b757bda21a7cd4c5d13994eaadffc242c646bb3e` (store typecheck correction), `15250cba931c573ee81bb5e69012792b275a4fcf` (encrypted enrollment service), `2683589ab1689486382cad394b375ce0e02de21f` (service tests), `ea6bffd6a3fd0ee5fbb5ef6f81472b95f26828c0` (test fixture correction), `87261c76503028b289a938bdacba293f570b695f` (focused typecheck inclusion), `c6d513083850c89661d7c129dbea667c8111c6ad` (workflow inclusion), `694a72f9f5df383a85eaf2ae97bc81fa762d6b51` (unused parameter correction).
- Full repository CI remains blocked by unrelated syntax errors in AI-only `src/modules/ai-training/sqlite-stores.ts`; no AI/TQ files were touched.

### Remaining CO-005 work and owner inputs
- MFA policy (optional/mandatory/tenant/step-up), accepted algorithms/digits/period/drift, enrollment and recovery behavior remain unapproved.
- Production 32-byte encryption key source, KMS/key rotation, backup and recovery are owner/security dependencies. The service accepts an injected key; application wiring is intentionally not enabled without approved key custody.
- No login/step-up enforcement route, recovery codes, assisted reset, notifications or MFA audit-event integration is claimed.
- PostgreSQL adapter/migration have not been validated against a live PostgreSQL service.
- Continue independent backend work; do not block the CO sequence on these owner inputs.


## CO-006 implementation continuation checkpoint (2026-11-06 10:07 Africa/Lagos)

### Branch comparison and classification
- Repository: `mildredsylvester763-source/forge-repository`; destination `mistral`; comparison `main`.
- Before CO-006 work, main head was `ec6716fb5ba6c42e940b748581990df9194a2a2b`, Mistral head was `29cfe446fa3012540fa765e68080667da44af1b8`; Mistral was 436 commits ahead and 1 behind, merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Main had the session store core but did not have the Mistral request-auth helper, session-manager routes, session-revocation event constant, or `test/co-006-session-manager.test.ts`. Mistral had the complete owner-scoped session manager route and transactional revoke path.
- Classification: **IMPLEMENTED against repository-documented behavior; catalogue acceptance unverified** because exact Part 01 CO-006 wording is not present.

### Defect found and fixed
- `SessionService.validate()` previously fell back to the stale pre-touch record when `SessionStore.touch()` returned null. If a concurrent request revoked or removed the session between the initial read and touch, this could allow the stale record to authenticate.
- Changed validation to fail closed when conditional touch returns null, revoked state or expired state.
- Changed the in-memory store to refuse touching revoked/expired sessions; SQLite touch now updates only where `revoked_at IS NULL AND expires_at > now`; PostgreSQL uses the same conditional predicate and `RETURNING *`.
- Added a regression test in `test/co-006-session-manager.test.ts` for concurrent revocation/removal during idle touch.

### Verification
- Focused workflow [42192318904](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42192318904): isolated CO typecheck **passed**; **121 tests passed, 0 failed**.
- Relevant commits: `54e50a3a789dd8dd650e5887d7478f601fb7d6d8` (fail closed on failed touch), `c480bd19d5809ef1c5675dd15eec1fff2d02c4f3` (conditional SQLite touch), `4c411566894d4970ae62bc628219bcb890ed408b` (conditional PostgreSQL touch), `f448999cb5558a2b91c861522b25dea0d612cc6b` (race regression test).
- Full repository CI remains blocked by syntax errors in AI-only `src/modules/ai-training/sqlite-stores.ts`; no AI/TQ files were changed.

### Remaining boundaries
- Exact Part 01 acceptance wording remains required for owner catalogue sign-off.
- IP address and user-agent retention/privacy duration should be reconciled with the owner's data policy. The API currently exposes these values only to the authenticated session owner.
- Administrator-wide session management, device naming/location enrichment and bulk UX are not claimed unless required by the exact catalogue entry.
- CO-006 does not close separate CO-007/CO-009 native token semantics or CO-005 MFA policy.


## CO-007 implementation continuation checkpoint (2026-11-06 10:08 Africa/Lagos)

### Branch comparison and classification
- Repository: `mildredsylvester763-source/forge-repository`; destination `mistral`; comparison `main`.
- Before CO-007 audit, main head was `ec6716fb5ba6c42e940b748581990df9194a2a2b`, Mistral head was `55e0bbafee31663c993393ad4547507a39a92626`; Mistral was 443 commits ahead and 1 behind, merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Main has the cookie-based session foundation but no Mistral `request-auth.ts`, native sign-in/sign-out routes or `test/co-007-native-token.test.ts`.
- Classification: **IMPLEMENTED against repository-documented behavior; catalogue acceptance unverified** because exact Part 01 CO-007 text is unavailable.

### Evidence and security behavior
- `src/modules/identity/request-auth.ts` parses opaque 256-bit bearer sessions and makes a malformed Authorization header fail closed rather than falling back to a browser cookie.
- `src/modules/identity/routes.ts` implements native sign-in (token returned in body, no cookie) and native sign-out (server-side revocation). Protected routes and CO-006 session manager use the same session credential resolver.
- `src/modules/identity/sessions.ts` stores only SHA-256 session references and enforces idle/absolute expiry and server-side revocation.
- `test/co-007-native-token.test.ts` covers no-cookie token issuance, bearer-protected access/session management, bearer sign-out and malformed-header no-fallback behavior.
- Focused workflow [42192318904](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42192318904): isolated CO typecheck **passed**; **121 tests passed, 0 failed** across the CO slice.
- No new source changes were required for CO-007 during this audit; its current backend behavior already matched the repository's explicit documented contract.

### Remaining owner validation
- Exact Part 01 acceptance text; approved native token audience and whether the existing opaque session model satisfies all intended native clients.
- Owner decision on refresh-token issuance versus reauthentication, device enrollment/attestation and native-device lifecycle.
- Real Android Keystore/iOS Keychain secure-storage and HTTPS transport validation in native clients. These are client integration checks, not reasons to invent JWT/refresh-token code.
- CO-009 desktop-specific semantics remain separate.


## CO-008 implementation continuation checkpoint (2026-11-06 10:09 Africa/Lagos)

### Branch comparison and classification
- Repository: `mildredsylvester763-source/forge-repository`; destination `mistral`; comparison `main`.
- Before CO-008 work, main head was `ec6716fb5ba6c42e940b748581990df9194a2a2b`, Mistral head was `dc3c424a12f51ac81e00245cc9e2ef3523f738e6`; Mistral was 446 commits ahead and 1 behind, merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Neither branch had an email-verification/password-recovery module or route. `docs/PROGRESS.md` explicitly records email verification, password reset and recovery as outstanding under CO-008. No CO-008 feature document existed before this implementation.
- Classification: **PARTIAL**. Provider-neutral action-token security and persistence are implemented; email delivery, account state changes, password/session recovery and routes remain incomplete.

### Implemented and verified
- New `src/modules/identity/action-tokens.ts`: issues random 256-bit tokens, stores SHA-256 hashes only, binds purpose/user/version/expiry, replaces previous active tokens for the same user+purpose, and atomically consumes tokens once.
- Added SQLite and PostgreSQL stores and identity migration v5 (`identity_action_tokens`). PostgreSQL issue/replacement locks the user row; consumption uses a locked transaction.
- New `test/action-tokens.test.ts`: hash-only storage, purpose mismatch, one-time consumption, replacement invalidation, user-version mismatch, expiry, malformed token rejection and concurrent-consumer race.
- Focused workflow [42192717126](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42192717126): isolated CO typecheck **passed**; **126 tests passed, 0 failed**.
- Relevant commits: `d9cae313b8cd1cfcc0d3c917b26324fb6b7b2a3a` (token service and stores), `b5cacf40dc6647e5fcaf51eb0a49e08309252e01` (SQLite migration), `025473310f4e6af1ff1547bb5c68b4a83a66c6aa` (PostgreSQL migration), `e375b2e1adb66ba30c6ea21ceb0ce002925478c1` (tests), `925f78a6c2b1f9f406715c59b494a117d7ce8a21` (focused typecheck inclusion), `f5f21b85680e24f7b433292de020785322b88698` (workflow inclusion), `af48c0c9dbe657c616d66acbff63e09cc96bcde5` (runtime purpose validation), `bab28be0baee915c1b2b55194f235b1aea71d6bc` (concurrent-consume regression).
- Full repository CI continues to fail in AI-only `src/modules/ai-training/sqlite-stores.ts`; no AI/TQ files were modified.

### Remaining CO-008 work
- No delivery provider, HTTP routes, email verification state, password reset hash update, session revocation or recovery audit workflow is wired.
- Account-enumeration response, token TTL, identity-proofing, password reset policy, verified-email gating and session revocation scope need owner decisions before activation.
- PostgreSQL adapter/migration has not been live-tested. Provider credentials and sender-domain verification remain external activation inputs.


## CO-009 audit checkpoint (2026-11-06 10:10 Africa/Lagos)

### Branch comparison and classification
- Repository: `mildredsylvester763-source/forge-repository`; destination `mistral`; comparison `main`.
- Main head `ec6716fb5ba6c42e940b748581990df9194a2a2b`; Mistral head `f00da15fe6b6bfa941474ab0a828e86522a7b883`; Mistral was 457 commits ahead and 1 behind, merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Main identity directory has no bearer request-auth helper or native-token tests. Mistral adds CO-007 `request-auth.ts`, native sign-in/sign-out routes and `test/co-007-native-token.test.ts`, but these contain no desktop-specific audience, device enrollment, refresh or credential-lifecycle contract.
- `docs/CO_APPROVAL_NEEDED.md` explicitly states that CO-009 desktop token behavior is separate from CO-007 and the exact desktop contract is NOT SUPPLIED / NOT APPROVED.
- Classification: **MISSING / OWNER-BLOCKED**. No code change made because the security contract is undefined; no guessed JWT/refresh/device-token implementation is safe.

### Evidence and next step
- Evidence recorded in `docs/features/CO-009.md`, `docs/PROGRESS.md`, `docs/CO_APPROVAL_NEEDED.md`, `src/modules/identity/request-auth.ts`, `src/modules/identity/routes.ts`, and `test/co-007-native-token.test.ts`.
- Required owner input: exact CO-009 Part 01 wording; desktop client audience; whether per-device registration/attestation is required; token expiry/refresh/rotation/offline policy; secure-storage and revocation requirements.
- No tests were added because no implementation was safe to write against an unknown contract. Proceed to CO-010 rather than waiting for owner input.


## CO-010 audit checkpoint (2026-11-06 10:11 Africa/Lagos)

- Branch comparison before audit: main `ec6716fb5ba6c42e940b748581990df9194a2a2b`; Mistral `70886f9056ceb89c006e37c8305ca0f692f22323`; 459 commits ahead, 1 behind; merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Classification: **MISSING / OWNER-BLOCKED**. The exact CO-010 feature title and acceptance criteria are absent.
- Mistral's `identity-anomaly.ts` is documented and tracked as CO-012, not CO-010; it must not be relabelled to inflate CO-010 progress.
- Neither branch has a CO-010 feature document, dedicated source/test/migration evidence. No implementation or test was added because the target behavior is unknown.
- Evidence and owner request recorded in `docs/features/CO-010.md`, `docs/PROGRESS.md` and `docs/CO_APPROVAL_NEEDED.md`. Continue to CO-011/next independently specified work.


## CO-011 implementation continuation checkpoint (2026-11-06 10:12 Africa/Lagos)

### Branch comparison and classification
- Repository: `mildredsylvester763-source/forge-repository`; destination `mistral`; comparison `main`.
- Before CO-011 work, main head was `ec6716fb5ba6c42e940b748581990df9194a2a2b`, Mistral head was `b562bacfb4289c45cc654b6bf48c9d6b9d976bb5`; Mistral was 462 commits ahead and 1 behind, merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Main and Mistral both have the generic event `Actor.kind = 'agent'` concept, but this is audit metadata only. Neither branch had an agent credential store, principal authentication or credential lifecycle.
- Classification: **PARTIAL**. A scoped, tenant-bound opaque agent credential engine is implemented; agent principal registry, route authorization and delegation semantics remain owner-dependent.

### Implemented and verified
- New `src/modules/identity/agent-credentials.ts`: random opaque credentials, SHA-256 hash-only storage, explicit tenant binding, configured scope allowlist, expiry, last-used tracking, individual revoke, tenant-scoped revoke-all and atomic rotate.
- Added SQLite and PostgreSQL stores and identity migration v6 (`agent_credentials`).
- `AgentCredentialService.authenticate` requires the expected tenant and rejects revoked/expired credentials, scope data outside the configured allowlist and credentials concurrently revoked during last-used update.
- New `test/agent-credentials.test.ts`: hash-only storage, tenant mismatch, scope allowlist, expiry, rotation, individual revocation and tenant-scoped revoke-all.
- Focused workflow [42193074634](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42193074634): isolated CO typecheck **passed**; **130 tests passed, 0 failed**.
- Relevant commits: `ff1fe4eaf4bc6e91e06614c44d5b30b4a0641749` (agent credential service/store), `ce81f6874ef68109b5d8ceb7254d9df3e43ef350` (SQLite schema), `df43bd2b82dd8e9a7b7e323e52b38d02e0b5b2c6` (PostgreSQL schema), `734184c97d706da3f0141eee7dfb44a329aa2f7d` (tenant/scope validation), `be8cfd85bfa8736bd896b206a243287f7b936e3f` (agent credential tests), `a2c122b1464ed91d356456af94961639bb210b2a` (focused typecheck inclusion), `b6933952921cb9fe0442a68d7804bff414db829e` (focused workflow inclusion).
- Full repository CI remains failing outside CO in AI-only `src/modules/ai-training/sqlite-stores.ts`; AI/TQ files were not modified.

### Remaining CO-011 owner decisions
- Agent principal types/registry, creator/owner and credential rotation authority, tenant binding source, scopes, delegation/impersonation, audience, workload identity and audit event policy.
- No routes or application authorization integration are enabled until the principal and scope model is approved.
- PostgreSQL adapter/migration have not been live-tested.


## CO-012 anomaly detector continuation checkpoint (2026-11-06 10:13 Africa/Lagos)

### Branch comparison and classification
- Repository: `mildredsylvester763-source/forge-repository`; destination `mistral`; comparison `main`.
- Before this CO-012 pass, main head was `ec6716fb5ba6c42e940b748581990df9194a2a2b`, Mistral head was `18fb57d0dc00eb1dfbb74d32327e78f5dc458808`; Mistral was 472 commits ahead and 1 behind, merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Main had no `identity-anomaly.ts` or anomaly event; Mistral had the observe-only detector, password/passkey sign-in integration and `identity.sign_in.anomaly_observed` event.
- Classification: **PARTIAL**. Observe-only current-session signals exist; historical behavioral models, alerts, scores and automatic response remain unimplemented and owner-policy dependent.

### Defect found and fixed
- The detector previously treated any non-empty active-session list as a valid baseline. If those sessions had empty/invalid IP and user-agent metadata, it could report false new-IP/new-agent/new-device signals.
- IPs are now syntax-validated with `node:net.isIP`; user-agent values are bounded. Each dimension is compared only if both the current request and baseline contain usable metadata for that dimension. No usable baseline returns `insufficient_metadata`.
- A missing dimension no longer manufactures a device signal or suppresses comparison of the other usable dimension. No raw client metadata is added to assessment/event payloads.

### Verification
- Added baseline-quality and dimension-specific regressions to `test/co-012-anomaly.test.ts`.
- Focused workflow [42193333427](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/42193333427): isolated CO typecheck **passed**; **133 tests passed, 0 failed**.
- Relevant commits: `ac55c958f7617fce6e8095b6cca97a1a46620020` (baseline-quality detector fix), `111424ffb679b97aad81379501103b4a319ed02e` (baseline-quality tests), `7b26ab5a1b5a9f57bdd2adfb693760e4bb7efe4a` (focused typecheck inclusion), `c730570e2783e35932fa5412fc2f73fe1d29fe75` (workflow inclusion).
- Full CI remains failing outside CO in AI-only `src/modules/ai-training/sqlite-stores.ts`; no AI/TQ files were changed.

### Remaining owner decisions
- Exact Part 01 CO-012 acceptance wording; whether any risk score, threshold, challenge, alert recipient, lockout or revocation is required.
- Approval of retention for historical device/IP/UA telemetry and data-minimization policy. Current detector uses only active-session metadata and does not persist a behavioral history.


## CO-013 audit checkpoint (2026-11-06 10:14 Africa/Lagos)

- Branch comparison: main `ec6716fb5ba6c42e940b748581990df9194a2a2b`; Mistral `50494fa7e9c94158aa9a615f833921414f27776a`; 479 commits ahead, 1 behind; merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Classification: **MISSING / OWNER-BLOCKED**. The exact CO-013 feature name and acceptance criteria are not present.
- Mistral's identity module contains multiple capabilities, but no source/test/migration is attributable to CO-013 by the available documentation. No neighboring capability was guessed or relabelled.
- No code or tests were added. Evidence and owner request are recorded in `docs/features/CO-013.md`, `docs/PROGRESS.md` and `docs/CO_APPROVAL_NEEDED.md`.
- Required owner input: exact Part 01 CO-013 title, description and acceptance criteria. Continue to CO-014.


## CO-014 audit checkpoint (2026-11-06 10:15 Africa/Lagos)

- Branch comparison: main `ec6716fb5ba6c42e940b748581990df9194a2a2b`; Mistral `65571260bcd9d88a7ccaf7a62813bcbcf80c219b`; 482 commits ahead, 1 behind; merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Classification: **MISSING / OWNER-BLOCKED**. No CO-014 feature title, description or acceptance criteria are present.
- No feature document, dedicated source/test/migration evidence is attributable to CO-014. Existing identity capabilities are not reassigned to this ID.
- No code or tests were added because the target behavior is unknown. Evidence is recorded in `docs/features/CO-014.md`, `docs/PROGRESS.md` and `docs/CO_APPROVAL_NEEDED.md`.
- Required owner input: exact Part 01 CO-014 title, description and acceptance criteria. Continue to CO-015.


## CO-015 audit checkpoint (2026-11-06 10:16 Africa/Lagos)

- Branch comparison: main `ec6716fb5ba6c42e940b748581990df9194a2a2b`; Mistral `393431dbf46e7211440f9c9240f70a373014b928`; 485 commits ahead, 1 behind; merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Classification: **MISSING / OWNER-BLOCKED**. Only the CO-015–CO-028 section heading "Workspaces and tenancy" is present; no individual CO-015 feature title or acceptance criteria exist.
- Mistral has no dedicated workspace/tenancy module or CO-015 source/test/migration evidence. The catalogue checklist marks the section not started.
- No code or tests were added. Exact CO-015 wording is required before implementation. Evidence recorded in `docs/features/CO-015.md`.


## CO-016 audit checkpoint (2026-11-06 10:17 Africa/Lagos)

- Branch comparison: main `ec6716fb5ba6c42e940b748581990df9194a2a2b`; Mistral `5bdeef4f01a0e378691223d37e3831088b4bae01`; 488 commits ahead, 1 behind; merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Classification: **MISSING / OWNER-BLOCKED**. Repository progress and approval registers explicitly say the CO-016 title/acceptance criteria are unavailable.
- No dedicated source module, feature document, test or migration exists on Mistral. No membership/invitation semantics were invented.
- Evidence and required owner input recorded in `docs/features/CO-016.md`, `docs/PROGRESS.md` and `docs/CO_APPROVAL_NEEDED.md`. No code/tests added.


## CO-017 audit checkpoint (2026-11-06 10:18 Africa/Lagos)

- Branch comparison: main `ec6716fb5ba6c42e940b748581990df9194a2a2b`; Mistral `b060d1f0d2509041b4b18189accfe40c45a8efb9`; 491 commits ahead, 1 behind; merge base `9c65e6a2b187fefb8511bc15fda8221899a1cdb8`.
- Classification: **MISSING / OWNER-BLOCKED**. Neither branch has a general tenant-scoped data-access layer or PostgreSQL RLS policies/migrations.
- Mistral's `tenant_id` on `agent_credentials` only binds an agent credential; it does not provide row isolation for business data. Identity stores have no tenant membership join. Kernel contains no tenant context/query guard.
- The owner has not approved app-only scoping versus PostgreSQL RLS, nor supplied database role/connection strategy. No tenant policy was guessed or implemented.
- Evidence and required owner decision recorded in `docs/features/CO-017.md`, `docs/PROGRESS.md` and `docs/CO_APPROVAL_NEEDED.md`. Proceed to CO-018.
