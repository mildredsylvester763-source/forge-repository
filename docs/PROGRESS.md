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
| CO-002 to CO-014 | Identity: passkeys, social, SSO, MFA, sessions, recovery, tokens | not started |
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
- CO-063–065 and CO-076: partial foundation exists in src/kernel/events.ts, src/kernel/sqlite-events.ts, src/kernel/postgres-events.ts and kernel migrations. Envelope, append-only/hash-chain, transactional append helpers and chain verification exist. Tail truncation cannot be detected by an internal chain alone; an independently stored head anchor is still required and is recorded in the approval register. Atomic coupling must be verified per domain write path, not inferred from the identity transaction.
- CO-091: health/readiness endpoints exist in src/app.ts; only a shallow readiness probe (database-backed event head) is evidenced so far.
- CO-093: src/kernel/rate-limit.ts provides an in-memory sliding-window limiter; production multi-instance atomic/shared enforcement is not evidenced. Treat as partial, not complete.
- CO-096: src/kernel/backup.ts provides verified SQLite snapshots (checksum, SQLite integrity and event-chain checks). This does not establish automated off-site PostgreSQL backup/restore.
- CO-030: IdentityService.authenticate() exists and multiple routes receive IdentityService, but complete enforcement across all protected routes and tenant/resource authorization are not proven by this alone. Treat as partial pending exhaustive route audit.

### CO-063/064/065/076 implementation review
- Compared main and mistral: src/kernel/events.ts, src/kernel/canonical.ts, src/kernel/postgres-events.ts and src/kernel/sqlite-events.ts have identical blob SHAs on both branches at the time of review. Existing event foundation is inherited, not a Mistral-only addition.
- SQLite and PostgreSQL verification walk sequence order and validate previous-hash links and recomputed hashes. SQLite events table is protected by append-only triggers (see kernel migrations); PostgreSQL protections and role/privilege behavior still require a real PostgreSQL integration proof.
- A valid chain can still be truncated at its tail and verify as valid if the remaining prefix is intact. The project notes already identify an external head anchor as required; the mechanism and credentials must not be invented.
- The Postgres advisory transaction lock serializes chain extension, and appendIn() allows a domain transaction to append its event atomically. This does not prove every module uses that unit-of-work pattern.

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
- Commits: in-memory user restore `1a6801ce0e351b668922cb7976b103e9f251ef6b`; UOW contract/docs/serialization `2a43ad1eb824d4425cec7e318c38b98d60f5b98b`, `8279894192f7b1b980336853e87458d40f489801`, `3d981f8c48ffd2a37fd8d9e389370fe944a5365f`, `99d16b44e4f4bfd617271e744dcc55b581fb9a34`; SQLite user atomicity `8166154e8e486fe57b26832259ccf3a7f4f1c8c8`, `ba699dc5603c0b84ab63f4b3f13fbeb8b129b5e2`, `e3f7bdbbda6f247921688d4314a808365a6fd644`; PostgreSQL user atomicity `8ae12271c0733f29a5a0003a0dbd309193e25b7e`, `e4104d28c1614445fbebf3e43389eb815801b7f9`, `ef77842a36fc8db1c444e20a4db78f0be890277f`; service integration `182cd7dcb9ddc0c90848a45b8adb7992428a3425`; regression tests `b73451144b08598fe53faa08e685339e88a6fc6c`, `bae82217b6e1692a8b003b7a65289651c2f0e11a`; test-adapter fix `f2cb82bb43d60aefdc85d9ec01597f58b73aa2b7`; focused workflow `0681a25d1f5474848412413d7a86922fe4cffd9e`.
- Status remains PARTIAL until the focused workflow passes and a real PostgreSQL run is evidenced where production PostgreSQL compatibility is claimed. Identity register/sign-in/sign-out/security-flag paths now use transactional writes for the currently implemented operations; this does not prove future identity/domain mutations are covered.


### CO-065 sign-in password-rehash transaction boundary (2026-11-05)
- Final identity write-path audit found one more non-atomic mutation: IdentityService.signIn() persisted a password-hash upgrade before creating the new session and appending identity.sign_in.succeeded. A later session/event failure could therefore leave a rehash without the successful sign-in audit event.
- Change: IdentityUnitOfWork.startSession() accepts an optional user update. IdentityService now computes a replacement hash but does not persist it early. SQLite applies that hash update, new session insertion, session-cap revocations, and sign-in event append inside one transaction. PostgreSQL does the same with one connection/transaction and PostgresUserStore.updateIn(). The update preserves existing account fields, including password-compromise state.
- The in-memory UOW serializes session creation by user key and snapshots the prior user/session state so a failed event append restores both. This remains a non-crash-safe development/test adapter.
- Added failure-injection tests proving invalid event creation rolls back the hash and session together in SQLite and through PostgreSQL adapters. The PostgreSQL adapter test uses a real database only when FORGE_TEST_POSTGRES_URL is configured; its default SQLite-backed stand-in is not production PostgreSQL proof.
- Commits: UOW contract/in-memory transaction `e69dd9dc5d923ae5acd61d54fec0d254b8506f4d`, `bb48b293a2508602bbc97e651a08bdb0917dc72c`, `0d5611306c9a02c3063e63c6d2e566a658ebf38d`; SQLite transaction `29142ee109b1cfb290f1de160a8d046bce0f1425`; PostgreSQL transaction `0356fe671e1450eaa96018d7844aa572661bda4f`; service integration `bfe067e63477aa5718ba124f654463060f1b28e8`; SQLite test `facc40ac1fc4785b0535cb84878fdad825d5aa16`; PostgreSQL tests `85387de49d30cf988b84e4df4d4d46b0bf4ae3eb`, `6a71661fa662d946d291d70f7aa2c801c9bb95e9`.
- Verification is pending: the CO-focused workflow has not yet returned a visible successful check. No local execution was possible. Do not mark CO-065 verified until the workflow passes; a real PostgreSQL run additionally requires the test URL secret.
