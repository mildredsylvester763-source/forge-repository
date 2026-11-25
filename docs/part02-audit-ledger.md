# FORGE Part 02 and Plan Hooks — implementation audit ledger

**Governing scope:** only the user's two documents: **FORGE Plan Hooks (Subscription, Billing & Entitlements)** (Library source file: `Forge Feature — Plan Hooks (build notes).pdf`) and **Forge Feature — Catalog Part 02 With Plans.pdf**. Their requirement text is authoritative.

**Repository:** `mildredsylvester763-source/forge-repository`  
**Working branch:** `forge-part02-audit`, retained as an isolated branch based on `manus/part36-safety`.  
**Latest CI-verified code checkpoint:** `b95158d1a16c371f6d0659e90d41f3e6e64e4de7`. GitHub Actions run [45568327170](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/45568327170) completed successfully: typecheck passed and the full test job reported 994 tests, 993 passed, 0 failed, 0 cancelled, 1 skipped.  
**Feature-status caveat:** CI verifies typecheck and the automated test suite at the recorded branch head; it does not mean every Part 02 catalogue feature is complete. DP-015 remains partial. OB-052's backend management API and durable component-history implementation now pass CI. Hook 16's cross-module export is expanded but explicitly incomplete. Feature delivery status remains per-row below.  
**Intermediate verification:** `9f31ddc` passed in [run 45133878250](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/45133878250). `69ba292` initially failed because the export test assumed the optional trusted-device store was configured; `8c008ec` explicitly represents that capability as unavailable and the full suite then passed.  
**Audit date:** 2026-11-25.

## Plan Hooks — prerequisite audit

| Hook | Status | Current repository evidence and remaining work |
|---|---|---|
| 1 — Subscription items list; one live base plan; any number of passes | **IMPLEMENTED** | SQLite/PostgreSQL `subscription_items`, partial unique index for one active/grace base plan, migration v11 from legacy `user_plans`, provider event application, and audited admin comp. Entitlement reads in `getEntitlementState` and `canUse` derive from subscription items only. `user_plans` remains a compatibility mirror; direct seeding is test-only. |
| 2 — One `canUse(user, featureId)` decision | **IMPLEMENTED; ROUTE COVERAGE FIXED AND CI-VERIFIED** | Every catalogued non-auth route now passes through `canUse`, including Free and Internal rows, so feature switches and paused/deletion-queued account state cannot be bypassed by a Free route. Public `/v1/auth/*` routes use the same decision with a null user (Free plan context) to apply feature switches; identity handlers retain their own authentication and sign-in throttles. Unknown feature IDs fail closed. Routes with no catalog entry (health and plan-management routes) remain intentionally outside the feature map. |
| 2b — Unpaid engines stay open at Free level; a pass raises only its engine | **PARTIAL / OWNER + ENGINE-INTEGRATION BLOCKER** | Engine rows remain available and return per-engine `free`/`paid` levels. Free-window credits, the 600-credit monthly ceiling, engine-tagged spending and the $0.20 monthly free-engine cost cap are enforced. The repository does not yet enforce the document's free-model-only, quality, output-size, watermark and commercial-use restrictions end-to-end in each engine consumer. The governing documents do not enumerate the approved free model/quality/output profiles; do not invent them. |
| 3 — Append-only, engine-tagged credit ledger; derived balances; deterministic spending; job identity | **IMPLEMENTED; CONCURRENCY TESTS CI-VERIFIED** | Balances are derived from ledger entries. Engine-pool then general-pool allocation, source priority and expiry ordering are deterministic; spend allocations expire with their source grants. Migration v9 persists `job_engine`; every spend entry records `jobId` and initiating `jobEngine`. A same-job retry returns the original result; a changed amount, cost or engine is rejected with `credit_job_conflict`. SQLite transactions and PostgreSQL per-user row locks serialize competing charges. SQLite and PostgreSQL concurrent retry tests are included in the 982-test CI run `45134257552`. |
| 4 — Product catalog, per-window cap, regional minor-unit price book, ALG-43/52/56 | **OWNER-BLOCKED; PRODUCTS SAFELY NON-SELLABLE** | Product-code/type/plan/engine mapping and credit allocation validation exist. Production rejects sellable catalog entries until regional minor-unit prices, per-window caps and the ALG-43 cost floor, ALG-52 margin guard and ALG-56 pass-versus-all-round-plan comparison are implemented and configured. The two governing documents reference those algorithms but do not provide the formulas or verified cost/price inputs. No prices or formulas have been fabricated; the catalog remains empty/non-sellable. |
| 5 — Master and per-feature switches | **IMPLEMENTED; FREE/INTERNAL ROUTE GAP CLOSED** | Strict `FORGE_GATES_ENABLED` parsing, per-feature switches and production refusal to disable the master gate are present. Previously Free/Internal feature routes bypassed the middleware; they now pass through `canUse`, and public identity routes check their feature switch without requiring a pre-existing session. Route tests prove a Free AI feature can be switched off with HTTP 503. |
| 6 — Verify payment signatures and process each event ID once | **IMPLEMENTED** | HMAC verification precedes mutation. SQLite claims the unique event ID and applies subscription/ledger changes in one write transaction; PostgreSQL locks the user row and claims the unique event ID in one transaction. Duplicate deliveries do not grant twice. Hash-chained audit events are appended inside the same transaction; notifications are emitted after commit. PostgreSQL audit-failure rollback tests prove that payment claims, entitlements and credits roll back together. |
| 7 — Money stored in smallest units with currency | **IMPLEMENTED FOR EVENT STORAGE; PRICE RECONCILIATION BLOCKED BY HOOK 4** | Payment events persist integer `amountMinor` plus ISO currency; actual compute cost is stored as integer micro-dollars. Reconciliation against the checkout's configured regional product price cannot be completed while the price book and margin rules are absent. |
| 8 — Country table with currency, region band, checked tax rule, methods, enabled flag and payout minimum | **IMPLEMENTED; OWNER DATA REQUIRED** | Country-row validation, registry engine and authenticated routes exist. `FORGE_COUNTRY_CATALOG` is empty by default. Owner must provide verified country rows, tax-rule text and check dates, payment methods and minimum payout before enabling a country. |
| 9 — Signed short-lived access snapshot for bad networks | **BACKEND IMPLEMENTED; CLIENT INTEGRATION REMAINS** | Backend signs plan/pass/expiry snapshots, binds verification to the authenticated user, checks expiry and current server state, and refuses paused/deletion-queued accounts. The client-side offline cache, refresh and reconnect lifecycle is not present in this backend repository. |
| 10 — Append-only who/when/what/why audit for plan, credits, refunds, overrides and admin actions | **IMPLEMENTED FOR EXISTING MUTATIONS; REFUND LIFECYCLE BLOCKED** | Payment, credit grant/spend, promotion definition/redemption, account-control changes and admin comp append hash-chained audit records in their database transaction; notifications occur after commit. Admin records carry actor, target, action and reason. Refund/reversal operations are not implemented, so their audit lifecycle remains open with Hook 15. |
| 11 — Admin grant, comp, pause and ledger view | **IMPLEMENTED; OWNER ACTIVATION REQUIRED** | Authenticated admin routes, allowlist checks, required reasons, actor attribution, credit grants, subscription-item comp, pause/resume and ledger view exist. `FORGE_ADMIN_USERS` intentionally remains empty until the owner names the administrators. Admin comp updates the subscription item and compatibility mirror atomically with both audit events. |
| 12 — One durable coupons/trials/referrals model; limits, expiry, credits or time | **PARTIAL / TIME-BENEFIT POLICY BLOCKER** | Durable promotion definitions/redemptions, redemption limits, expiry, credit grant and transactional audit are implemented. Day-based benefits are rejected as `promotion-days-unsupported` because no target subscription item or renewal/extension policy is defined in the governing documents. |
| 13 — Server UTC clock for windows and expiry | **IMPLEMENTED** | Credit windows, monthly resets and entitlement decisions use the injected server clock and UTC boundaries. Production clock synchronization remains an operational responsibility. |
| 14 — Per-user and per-device gateway rate limits before AI work | **IMPLEMENTED; PRODUCTION THRESHOLDS OWNER-SUPPLIED** | Every catalogued non-auth feature route, including Free AI routes, now authenticates and enforces the signed server-issued HttpOnly device limit and user limit before handler execution. Shared SQLite/PostgreSQL rate-limit stores remain wired into the composition root. Production startup fails unless both user and device rules are explicitly configured. New route tests prove Free AI requests are limited by both device and user budgets. The owner must still supply real `FORGE_RATE_LIMITS` thresholds. Identity routes use IdentityService's own sign-in throttles. |
| 15 — Fake payment/test mode and fake clock for renewals, failures, upgrades and refunds | **PARTIAL / LIFECYCLE POLICY BLOCKER** | Fake clock, HMAC-signed test payment events and event idempotency exist. Renewal, failed-payment/grace transitions, upgrade/downgrade, refund and reversal state machines are not complete. The governing documents do not define provider event types or refund/reversal accounting semantics; do not invent money or entitlement behavior. |
| 16 — User export and deletion with jurisdiction-specific retention | **PARTIAL / OWNER LEGAL APPROVAL REQUIRED** | The no-store JSON export includes the public profile, plan, passes, subscription items, credit ledger and security metadata, plus owner-scoped records from task runtime, orchestrator, test quality, test generation, live testing, web search, workspace retrieval, search-integrity knowledge packs/open sync conflicts, enumerable AI-training records, training-data records and status pages with component history. Live-testing exports only the requesting user's participant row and strips generated test-account passwords; training-asset storage keys are omitted. `exportCoverage.complete` is explicitly `false` and enumerates remaining gaps: offline-sync entity/operation/resolved-conflict history; search-cache entries and unobserved domain rules; AI-training records requiring parent identifiers; external binary/model artifacts; other participants' identities and generated test-account passwords; and the uncomposed workspaces module. Password hashes and session credentials remain excluded. A confirmed deletion request durably pauses and queues the account and records an audit event; it does not hard-purge data. Hard deletion remains disabled until the owner verifies applicable retention requirements, including Nigeria's NDPR and other relevant jurisdictions. |

### Plan Hooks completion gate

The following are **owner/external-input blockers**, not reasons to repeatedly re-audit already inspected code:

1. Hook 2b needs approved free-model, quality, output-size, watermark and commercial-use profiles plus integration in each engine consumer.
2. Hook 4 needs the missing ALG-43/52/56 formulas and owner-verified regional prices, currencies, per-window caps and cost inputs. Sellable products remain disabled.
3. Hook 8 needs the owner-verified country/tax/payment/payout registry.
4. Hook 9 needs the client application to implement the signed snapshot cache and refresh lifecycle.
5. Hooks 10/15 need an agreed provider refund/reversal and failed-payment/renewal state machine.
6. Hook 11 needs the owner to name the admin allowlist.
7. Hook 12 needs a defined target and renewal/extension policy for time-based benefits.
8. Hook 14 needs the owner to set production user/device thresholds; production now fails closed if either is absent.
9. Hook 16 now exports owner-scoped records from the currently composed core modules, including all offline-sync operations, current entity snapshots, open and resolved conflicts, every search-integrity cache entry, and all web-search domain rules. Remaining engineering work is to expose parent-keyed AI-training records and define an external binary-artifact export contract; the workspaces module is still not composed. The owner must verify the full data inventory and jurisdiction-approved retention/deletion policy.

Do not invent missing prices, algorithms, legal retention rules, admin identities, provider event semantics or free-tier engine profiles. These blockers are recorded so independent work can proceed without repeating the same inspection.

## Part 02 catalogue


### Active 20-feature batch map

The original audit was recorded in 37 four-ID detail slices. Those are historical evidence sections, not the active batch boundaries. The active implementation/audit batches are exactly 20 catalogue IDs each (only the final remainder may be smaller):

| 20-ID batch | Catalogue-order range | Historical detail slices | Audit coverage |
|---|---|---|---|
| 1 | DP-001–DP-020 | 1–5 | Audited; per-feature delivery status below |
| 2 | DP-021–DP-040 | 6–10 | Audited; per-feature delivery status below |
| 3 | DP-041–DP-060 | 11–15 | Audited; per-feature delivery status below |
| 4 | DP-061–DP-080 | 16–20 | Audited; per-feature delivery status below |
| 5 | DP-081–DP-094, OB-001–OB-006 | 21–25 | Audited; per-feature delivery status below |
| 6 | OB-007–OB-026 | 26–30 | Audited; per-feature delivery status below |
| 7 | OB-027–OB-046 | 31–35 | Audited; per-feature delivery status below |
| 8 | OB-047–OB-066 | 36–40 | **8 of 20 audited** (OB-047–OB-054); next is OB-055, then continue through OB-066 |

The 20-ID batch is an organizational checkpoint, not a daily quota. Do not restart or re-audit completed detail slices; implement and verify the first unfinished feature in the active range.

- The catalog has **459 distinct feature IDs** across DP, OB, CG, RV, BD and SC. The repeated CG-061 occurrence is a cross-reference, not another feature.
- **452** rows are tiered.
- These seven rows are explicitly **Not tiered here** and must stay outside ordinary subscription gating: `SC-020`, `SC-021`, `SC-022`, `SC-023`, `SC-041`, `SC-062`, `SC-063`.
- The 452-row Part 02 gate metadata is registered centrally; the seven SC rows remain excluded.
- The 452-row central gate registry is metadata, not feature delivery. DP-015 has a partial, Pro-gated dependency-planning endpoint. OB-052 has a backend implementation with SQLite/PostgreSQL persistence and component-history enforcement, verified by CI; its separately hosted public frontend/domain is outside this repository. Other Part 02 feature status remains per-row below.

### First four-feature batch: DP-001–DP-004 — BLOCKED BEFORE IMPLEMENTATION

Exact catalog requirements (Part 02 PDF, page 2):
- **DP-001:** One-click deploy from any branch, tag, or commit.
- **DP-002:** Environment pipeline: dev, staging, production with promotion rules.
- **DP-003:** Preview deployments per PR with shareable URLs.
- **DP-004:** Blue-green deployments with instant switch.

Repository inspection: `src/app.ts` currently composes task runtime, orchestrator, test quality/generation, live testing, web search, workspace retrieval, search integrity, AI training, training data, plans and offline sync. It does not compose a deployment module or expose deployment routes/stores/providers. No deploy-target adapter or authorized infrastructure credentials are present in the governing documents or current repository configuration.

A real implementation cannot be completed by adding placeholder APIs or simulated deployment success. These four features require the owner to select and authorize the deployment provider/target and supply its integration credentials, plus the production promotion/rollback boundary. Until that is available, all four remain blocked and no mock deployment implementation has been added. DP-005–DP-008 are audited as the next four-feature batch below; they share the same missing deployment substrate.

Cross-branch preservation check: `src/app.ts` on `main`, `claude`, `mistral`, `plan-hooks-foundation`, `manus/part36-safety` and `forge-part02-audit` has no deployment module. `gpt-part2-build-ci` contains a separate `build-ci` module but no deployment wiring. No divergent branch was modified or merged; retain `gpt-part2-build-ci` for its later catalogue audit rather than cherry-picking it into the deployment batch.

### Second four-feature batch: DP-005–DP-008 — BLOCKED BEFORE IMPLEMENTATION

Exact catalog requirements (Part 02 PDF, pages 2–3):
- **DP-005 (Pro):** Canary deployments with automatic traffic stepping.
- **DP-006 (Plus):** Rolling deployments with health gating.
- **DP-007 (Plus):** Feature-flag-driven progressive delivery.
- **DP-008 (Pro):** Deployment risk score before release, fed by the impact engine.

The existing central gate registry already records these plan levels. No runtime deployment implementation was found: there is still no deployment provider/target adapter, traffic-control integration, rollout health/SLO source or deployment module. DP-008 additionally requires an impact engine, which is not present in the current application module composition. Static feature switches are not a substitute for rollout cohorts or traffic progression. These four IDs therefore remain blocked by the same owner-authorized deployment-provider/target prerequisite recorded for DP-001–DP-004; DP-008 also needs the impact-engine dependency. No simulated deployment or placeholder risk score was added.

**Next batch in document order:** DP-009–DP-012. The existing deployment-substrate blocker is recorded once; do not repeat the same cross-branch inspection unless repository evidence changes.

### Third four-feature batch: DP-009–DP-012 — BLOCKED BEFORE IMPLEMENTATION

Exact catalog requirements (Part 02 PDF, page 3):
- **DP-009 (Plus):** Automatic rollback on errors, latency, or SLO breach.
- **DP-010 (Plus):** Rollback to any previous release with a data-compatibility check.
- **DP-011 (Pro):** Database migration orchestration with expand-and-contract safety.
- **DP-012 (Team, or Studio):** Deployment windows and freeze periods; the Team route requires at least three seats.

The gate registry already reflects these plan levels. The repository has a versioned, checksummed, forward-only migration framework, but it applies registered migrations as application startup work; it has no expand/contract phase model, compatibility window, deployment coordinator or release-aware migration state machine. There is no deployment history or rollback actuator, no telemetry/SLO source connected to a deployment controller, and no deployment calendar/freeze policy. These are not completed by the existing generic migration runner or static feature switches.

All four remain blocked on the deployment provider/target and its authorized integration. DP-009 additionally needs trusted error/latency/SLO signals and a rollback actuator; DP-010 needs release history and schema/data compatibility metadata; DP-011 needs a staged migration lifecycle; DP-012 needs a deployment scheduler integrated with Team/Studio seat policy. No unsafe automatic rollback or migration-phase behavior has been invented.

**Next batch in document order:** DP-013–DP-016. Reuse the recorded deployment-substrate blocker unless repository evidence changes.

## Recent implementation evidence

- `949e0bad` / `e937f2f` — production configuration requires both user and device rate-limit rules; config tests cover missing, partial and valid production settings.
- `23ad4ce` / `87600b9` — concurrent SQLite and PostgreSQL job-charge retries prove the same job is charged once and keeps its engine identity.
- `9f31ddc` — routes all catalogued Free/Internal features through the access decision and applies per-user/per-device gateway limits to Free AI routes; adds tests for feature switches, paused accounts and both rate-limit scopes. Full typecheck and tests passed in [run 45133878250](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/45133878250).
- `69ba292` — adds profile, session and trusted-device metadata to the downloadable account export. Its first CI run failed because trusted-device storage is optional in the harness; the follow-up fixed that assumption.
- `8c008ec` — represents an unavailable trusted-device store explicitly as `null`, while preserving the account export. Full typecheck and all tests passed in [run 45134257552](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/45134257552): 982 tests, 981 passed, 0 failed, 1 skipped.
- The latest ledger-only commit will not change the verified code checkpoint above; any later code changes require their own CI run.

`main` has not been modified. Divergent branches have not been merged or overwritten. Continue only on `forge-part02-audit`; preserve the seven SC exclusions in all subsequent gate and feature work.


### Fourth four-feature batch: DP-013–DP-016 — ONE PARTIAL IMPLEMENTATION; THREE BLOCKED

Exact catalog requirements (Part 02 PDF, page 3):
- **DP-013 (PRO tag; Team, also Studio):** Release trains with scheduled cuts. Team requires at least three seats; Studio also qualifies.
- **DP-014 (ENTERPRISE):** Deployment approvals tied to policy-as-code.
- **DP-015 (PRO):** Deployment dependency graph so services ship in the right order.
- **DP-016 (PRO):** Multi-service atomic releases.

**DP-013 — BLOCKED BEFORE IMPLEMENTATION.** The backend has no release-train scheduler, durable release-train state, deployment provider or scheduled-cut executor. The existing Team minimum-seat setting is not a deployment team-membership/seat authority. A schedule that cannot safely execute or be cancelled against a real deployment target would be misleading, so no inert scheduling API was added.

**DP-014 — BLOCKED BEFORE IMPLEMENTATION.** There is no policy-as-code evaluator or deployment approval state machine connected to release execution. The governing catalog names the capability but does not define a policy language, policy schema, approver quorum, expiry or override semantics. These must not be invented. Enterprise gate metadata already exists.

**DP-015 — PARTIAL IMPLEMENTATION.** Added a deterministic dependency-graph planner and Pro-gated authenticated route at `POST /v1/deployments/dependency-graph/plan`. It validates bounded service DAGs, rejects unknown/self/duplicate dependencies and cycles, and returns stable dependency-first order plus parallelizable waves. It is a planning primitive only: service discovery/registry, persistence and provider-backed release execution are not present. See `src/modules/deployments/dependency-graph.ts`, `src/modules/deployments/routes.ts`, `src/modules/plans/engine/route-gates.ts`, `src/app.ts`, and `test/deployment-dependency-graph.test.ts`.

**DP-016 — BLOCKED BEFORE IMPLEMENTATION.** Atomic multi-service releases require a deployment adapter with a prepare/activate/rollback or equivalent atomic-visibility contract across all participating targets. No provider or target has been authorized/configured, and no such capability exists in the current application. A fake in-memory deploy adapter would not establish production atomicity; no simulated release endpoint was added.

**Verification:** Initial run [45348330363](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/45348330363) passed typecheck but exposed a stale route-inventory assertion (expected 294; actual 295 after adding DP-015). Commit `b6ec86b` updated the expected count and explicitly pinned the DP-015 route. Follow-up run [45348651252](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/45348651252) passed typecheck and all tests: 989 tests, 988 passed, 0 failed, 1 skipped.

**Next batch in document order:** DP-017–DP-020. Continue only after this batch's code and audit ledger have a recorded CI result.


### Fifth four-feature batch: DP-017–DP-020 — DEPLOYMENT INTEGRATION BLOCKED

Exact catalog requirements (Part 02 PDF, page 4):
- **DP-017 (FREE):** Deployment diff — what changed in code, config, infrastructure and data.
- **DP-018 (Plus):** Automatic live verification after rollout.
- **DP-019 (FREE):** Deploy from mobile with biometric confirmation.
- **DP-020 (FREE):** Deployment history with full audit and revert.

The existing modules provide useful adjacent primitives, but none is wired to a deployment lifecycle:

- **DP-017 — PARTIAL ADJACENT PRIMITIVE; NOT IMPLEMENTED.** The preserved `gpt-part2-build-ci` branch has `src/modules/build-ci/changed-files.ts`, a bounded GitHub/GitLab pull-request file-list resolver. It returns changed paths and explicitly marks provider-limited or incomplete results. That is not a deployment diff: it does not compare release artifacts, classify code/config/infrastructure/data changes, or connect changes to a deployment target. The module is not copied or merged into this branch; preserve it for a later selective integration.
- **DP-018 — BLOCKED.** The current branch has a durable `LiveTestingService` and test-session lifecycle, but there is no rollout-complete event, deployment provider, or automatic handoff from a successful release to a live-verification run. A manually created test session is not automatic post-rollout verification.
- **DP-019 — PARTIAL SECURITY PRIMITIVE; NOT IMPLEMENTED.** Existing passkey authentication requests WebAuthn `userVerification: required`, which is appropriate for a device user-verification ceremony. However, no deployment action-bound challenge, one-time deploy authorization, mobile deployment UI, or deployment provider is wired. A normal sign-in passkey assertion is not proof that a specific deployment was confirmed.
- **DP-020 — PARTIAL ADJACENT PRIMITIVES; NOT IMPLEMENTED.** The main branch has an append-only event store. The preserved `gpt-part2-build-ci` branch has immutable pipeline-definition versions and pipeline rollback, but those are Build & CI configuration versions, not deployment release records or artifact/environment rollback history. No deployment event model or release revert actuator exists on `forge-part02-audit`.

All four remain blocked for end-to-end delivery by the missing authorized deployment provider/target and release lifecycle. DP-017 also needs a complete source/artifact/infrastructure/data diff contract; DP-018 needs trusted rollout signals and live-test orchestration; DP-019 needs action-bound step-up authorization and a mobile client; DP-020 needs immutable deployment release records and a provider-backed revert operation. No simulated deployment status, fake biometric assertion, or fake rollback was added.

**Cross-branch preservation:** `gpt-part2-build-ci` remains untouched at `43436fd`. Its changed-file resolver and pipeline-version history are recorded as future integration candidates only; no wholesale merge was performed.

**Next batch in document order:** DP-021–DP-024. Inspect the preserved Build & CI branch for artifact-registry, signing, SBOM and provenance work before implementing anything.



### Sixth four-feature batch: DP-021–DP-024 — ARTIFACT PIPELINE BLOCKED

Exact catalog requirements (Part 02 PDF, page 4):
- **DP-021 (FREE):** Artifact registry for containers, packages, binaries and app bundles.
- **DP-022 (Plus):** Artifact signing and verification at deploy time.
- **DP-023 (Plus):** SBOM attached to every artifact.
- **DP-024 (Pro):** Build provenance records.

Current-branch inspection: `forge-part02-audit` has no artifact registry, artifact metadata/blob store, build runner, artifact signing service, SBOM generator/attachment path or provenance record store. Existing model/country/tool registries are unrelated and are not being counted as artifact delivery.

Divergent-branch inspection: `gpt-part2-build-ci` contains a Build & CI pipeline-definition service, provider connections, webhook ingress, schedule dispatch and bounded changed-file retrieval. Its pipeline module explicitly describes itself as planning only and states that it does not execute tasks, write queues or deploy. The inspected pipeline/store/routes/migrations do not implement artifact storage, SBOM generation, artifact signing, deployment verification or build provenance. The branch remains untouched; no speculative partial port was made.

Per-feature status:
- **DP-021 — BLOCKED.** No durable artifact blob-storage provider or registry metadata model is configured. A database row without durable blob storage would not be an artifact registry.
- **DP-022 — BLOCKED.** Requires artifact digests, a trusted signing-key/KMS boundary, signature verification and a deployment-time verification hook. No artifact pipeline or signing-key provider exists.
- **DP-023 — BLOCKED.** No build execution/output pipeline exists to generate an SBOM from the actual artifact inputs and attach it to every artifact. A source-tree dependency list would not prove every emitted artifact is covered.
- **DP-024 — BLOCKED.** No trusted build runner emits source, toolchain, inputs and output digests, and there is no immutable provenance store. Pipeline-definition versions are not build provenance.

These four features need an authorized durable artifact-storage target and a real build/runner integration before production behavior can be implemented. DP-022 additionally needs a key-management/signing authority; DP-023 needs an agreed SBOM format and artifact-input inventory; DP-024 needs trusted runner attestations and provenance retention. No fake registry, unsigned-as-signed status, empty SBOM or fabricated provenance record was added.

**Next batch in document order:** DP-025–DP-028. Continue to preserve the separate `gpt-part2-build-ci` branch and inspect its relevant release/build work before porting anything.



### Seventh four-feature batch: DP-025–DP-028 — PLATFORM RELEASE INFRASTRUCTURE BLOCKED

Exact catalog requirements (Part 02 PDF, page 4):
- **DP-025 (Plus):** Android release pipeline: bundles, signing keys, store submission.
- **DP-026 (Plus):** iOS build and store submission pipeline.
- **DP-027 (Pro):** Desktop installers with auto-update channels.
- **DP-028 (Pro):** Over-the-air updates for web and mobile where allowed.

Repository evidence: neither `forge-part02-audit` nor the preserved `gpt-part2-build-ci` tree contains Android/iOS store integration, desktop packaging, installer/update-channel code, OTA update distribution, or app-store submission modules. The preserved Build & CI branch has pipeline definitions, provider webhooks and schedule dispatch, but the pipeline code is a planner/queueing subsystem and explicitly does not execute build tasks or deployments. No macOS build runner, mobile signing material, app-store credentials or update-distribution target is configured.

Per-feature status:
- **DP-025 — BLOCKED.** No Android bundle build runner, keystore/KMS signing path, artifact registry or Google Play submission integration. Store credentials and signing authority are not present.
- **DP-026 — BLOCKED.** No macOS/iOS build runner, certificate/provisioning-profile management, artifact pipeline or App Store Connect submission integration. These platform-specific credentials and build infrastructure cannot be inferred.
- **DP-027 — BLOCKED.** No desktop packaging/signing pipeline, installer artifact store, update manifest service or channel-aware updater. A release-channel label without signed update delivery is not an auto-update system.
- **DP-028 — BLOCKED.** No web/mobile OTA distribution adapter or platform policy matrix defining which update classes are permitted. A generic download endpoint would not prove platform-compliant OTA delivery.

The four features require owner-authorized build runners, artifact storage, platform signing-key custody, store/update provider credentials and a defined rollout/update policy. No fake store submission, unsigned package, installer, or OTA-success status was introduced.

**Next batch in document order:** DP-029–DP-032. Reuse this platform/artifact-infrastructure blocker; do not re-audit the same absent integration unless repository evidence changes.



### Eighth four-feature batch: DP-029–DP-032 — RELEASE CHANNEL / ARTIFACT LIFECYCLE BLOCKED

Exact catalog requirements (Part 02 PDF, pages 4–5):
- **DP-029 (Pro):** Staged store rollouts with a halt button.
- **DP-030 (Plus):** Release channels: nightly, beta, stable.
- **DP-031 (Plus):** Artifact retention and cleanup policies.
- **DP-032 (Plus):** Vulnerability scan on artifacts before promotion.

Existing Build & CI schedule dispatch is for pipeline trigger occurrences; it does not control app-store rollout percentages or release channels. The current branch still has no artifact store, artifact metadata, deployment promotion controller or package scanning pipeline. The preserved `gpt-part2-build-ci` branch remains a pipeline-definition/trigger subsystem and does not execute build or deployment steps.

Per-feature status:
- **DP-029 — BLOCKED.** No app-store provider, staged percentage rollout control, release-health feedback or independent halt actuator exists. A halt button without authority to stop an active store rollout would be unsafe.
- **DP-030 — BLOCKED.** No immutable release artifacts or channel-aware promotion model exists. Pipeline schedule triggers are not nightly/beta/stable release channels.
- **DP-031 — BLOCKED.** No durable artifact storage, retention metadata, legal-hold state or cleanup worker exists. Deleting source pipeline records would not implement artifact retention.
- **DP-032 — BLOCKED.** No artifact ingestion/verification pipeline or vulnerability scanner is connected to a promotion gate. Scanning the repository's source dependency manifest alone would not establish that the promoted artifact was scanned.

The shared prerequisites are a durable artifact registry, trusted build output, provider-backed promotion and an owner-approved retention policy. DP-029 additionally needs store rollout control and a halt signal; DP-032 needs a defined scanner/source database and severity policy. No channel labels, cleanup jobs or scan pass/fail placeholders were added.

**Next batch in document order:** DP-033–DP-036 (Infrastructure). Before implementing, inspect existing cloud/IaC modules and any preserved branch work; do not assume the deployment blocker automatically applies to independent infrastructure-editor capabilities.



### Ninth four-feature batch: DP-033–DP-036 — INFRASTRUCTURE EDITOR / PLAN / DRIFT BLOCKED

Exact catalog requirements (Part 02 PDF, page 5):
- **DP-033 (FREE):** Infrastructure-as-code editor with visual and code views.
- **DP-034 (Plus):** Infrastructure plan preview with cost and risk.
- **DP-035 (Pro):** Drift detection between declared and actual infrastructure.
- **DP-036 (Pro):** Drift auto-fix proposals.

Branch-preservation audit for IaC/cloud/Kubernetes/provisioning paths found no matching infrastructure module or implementation in these current heads:
- `main`: `ec6716f`
- `mistral`: `a508de2`
- `manus/part36-safety`: `0621556`
- `gpt-part2-build-ci`: `43436fd`
- `forge-part02-audit`: `6c5b8b6`

Per-feature status:
- **DP-033 — BLOCKED.** No frontend/editor subsystem, IaC parser/AST, visual graph model or code serializer exists. A backend-only placeholder cannot deliver both visual and code editing.
- **DP-034 — BLOCKED.** No IaC plan engine, provider plan adapter, cost-estimation catalog or risk policy exists. Producing numeric cost/risk without provider and pricing inputs would fabricate values.
- **DP-035 — BLOCKED.** No declared-state store, cloud inventory adapters, provider credentials or drift reconciliation engine exists. A static diff cannot establish actual cloud state.
- **DP-036 — BLOCKED.** No drift findings or provider write adapter exist. Auto-fix proposals must be derived from a verified drift record and remain non-mutating until an authorized apply workflow exists.

The shared prerequisites are an IaC language/model decision, a frontend editor, provider read access, verified cost data and workspace-scoped cloud credentials. DP-036 additionally needs an explicit proposal approval/apply boundary and provider write authorization. No Terraform/Pulumi parser, guessed cloud costs or fake drift records were added.

**Next batch in document order:** DP-037–DP-040. Inspect cloud provisioning and Kubernetes capabilities across preserved branches; continue without overwriting divergent work.



### Tenth four-feature batch: DP-037–DP-040 — CLOUD / CLUSTER / KUBERNETES INFRASTRUCTURE BLOCKED

Exact catalog requirements (Part 02 PDF, page 5–6):
- **DP-037 (Pro):** Multi-cloud provisioning: AWS, GCP, Azure.
- **DP-038 (Pro):** Local and on-prem cluster support.
- **DP-039 (Pro):** Kubernetes management: nodes, namespaces, workloads.
- **DP-040 (Pro):** Kubernetes manifest generation and Helm packaging.

Branch-preservation check: the latest inspected trees for `main`, `mistral`, `manus/part36-safety`, `gpt-part2-build-ci` and `forge-part02-audit` contain no cloud provisioning, cluster-agent, Kubernetes, Helm or IaC module paths. The existing Build & CI pipeline subsystem does not execute build/deploy tasks and has no cloud provider adapters.

Per-feature status:
- **DP-037 — BLOCKED.** No AWS/GCP/Azure provisioning adapters, workspace-scoped cloud credential vault, resource state store or provider operation authorization exists.
- **DP-038 — BLOCKED.** No local/on-prem cluster agent, enrollment/mTLS identity, outbound control channel, cluster inventory or offline-safe job queue exists. A cloud-only adapter would not satisfy local/on-prem support.
- **DP-039 — BLOCKED.** No Kubernetes API client, cluster credential boundary, node/namespace/workload store or reconciliation controller exists.
- **DP-040 — BLOCKED.** No Kubernetes resource model, manifest validator, Helm chart renderer/package writer or OCI/chart artifact registry exists. Generating unvalidated YAML would not meet manifest generation and Helm packaging safely.

The required prerequisites are owner-authorized cloud accounts/roles, a secret-management boundary, cluster-agent trust/enrollment, Kubernetes/Helm compatibility targets and durable state. DP-038 requires on-prem agent deployment and lifecycle controls; DP-040 requires a defined workload/resource schema and chart validation. No provider credentials, cluster targets or infrastructure resources were invented.

**Next batch in document order:** DP-041–DP-044. Continue in order; reuse these recorded infrastructure prerequisites only where the next exact requirements depend on them.



### Eleventh four-feature batch: DP-041–DP-044 — SERVERLESS / CONTAINER / PREDICTIVE SCALE / GPU POOL PARTIALS

Exact catalog requirements (Part 02 PDF, page 6):
- **DP-041 (Plus):** Serverless functions: deploy, version, trace.
- **DP-042 (FREE):** Container builds with image optimization.
- **DP-043 (Pro):** Autoscaling policies with predictive scaling.
- **DP-044 (Pro):** GPU pool management for AI and render jobs.

Per-feature status:
- **DP-041 — BLOCKED.** No serverless function deployment target, function artifact/version store, invocation gateway or distributed tracing integration exists. AI model serving is not a serverless function deployment platform.
- **DP-042 — BLOCKED.** No container build executor, Docker/BuildKit adapter, image optimizer or image registry exists. The preserved Build & CI branch queues pipeline runs but does not execute pipeline tasks or build container images.
- **DP-043 — PARTIAL ADJACENT IMPLEMENTATION; PREDICTIVE REQUIREMENT MISSING.** Existing `src/modules/ai-training/engine/model-serving-engine.ts` implements reactive serving scale planning using Little's law and current `requestsPerSecond`/latency inputs. It does not forecast future demand or create a persistent autoscaling policy/controller. `recordServingMetrics` stores caller-supplied aggregate samples, but it does not record a trusted request-rate time series or forecast. Evidence: `test/ai-training-lifecycle-engines.test.ts` and `test/ai-training-lifecycle.test.ts` cover reactive scale planning and refusal paths. This does not satisfy predictive scaling.
- **DP-044 — PARTIAL ADJACENT IMPLEMENTATION; SHARED AI/RENDER POOL MISSING.** Existing `planServingScale` assigns model-serving replicas across a caller-supplied GPU list. `reserveSlots` persists per-user/model reservations, but `poolTotal` and `reservedByOthers` are caller-supplied rather than read from a trusted global inventory; reservations are not shared across tenants or render jobs. No authoritative GPU inventory, scheduler, health telemetry or render-job integration exists. Evidence: `src/modules/ai-training/ai-training-service.ts`, `src/modules/ai-training/ai-training-store.ts`, `src/modules/ai-training/engine/model-serving-engine.ts`, and the lifecycle tests. This is not production GPU-pool management.

No fake serverless deploy, container build, predicted traffic curve or authoritative GPU capacity was added. DP-043 requires trusted telemetry with time windows and an owner-approved forecast horizon/scale policy; DP-044 requires a shared inventory/allocator and a render-job consumer with authorized resource ownership.

**Next batch in document order:** DP-045–DP-048. Audit existing job queues/schedulers and the current database migration framework; DP-048 may have a reusable migration foundation, but preview/rollback must be verified separately.



### Twelfth four-feature batch: DP-045–DP-048 — JOB/SCHEDULER AND BACKUP PARTIALS; MANAGED DATABASE AND MIGRATION CONTROL INCOMPLETE

Exact catalog requirements (Part 02 PDF, page 6):
- **DP-045 (PRO; Plus):** Job and queue management.
- **DP-046 (PRO; Plus):** Cron and scheduled job manager.
- **DP-047 (PRO; Plus):** Managed database provisioning, backups, replicas.
- **DP-048 (FREE; Free):** Database migrations with preview and rollback.

Cross-branch audit:
- The working branch `forge-part02-audit` contains task-run history/state management and the kernel transactional outbox. Neither is a general-purpose job queue: task runs are user-owned histories, while the outbox delivers committed events.
- The preserved `gpt-part2-build-ci` branch contains a separate Build & CI module. Comparing it with `forge-part02-audit` reports **diverged**, 343 commits ahead and 834 behind, with 60 changed files. Do not merge it wholesale. Its relevant paths include `src/modules/build-ci/store.ts`, `sqlite-store.ts`, `postgres-store.ts`, `schedule-occurrences.ts`, `schedule-dispatcher.ts`, `cron.ts`, `worker.ts`, and their tests.
- The Build & CI worker explicitly says it creates authorized queued pipeline runs but does not execute registered pipeline tasks. Its scheduled dispatcher creates those queued runs; it is not a general job executor.

Per-feature status:
- **DP-045 — PARTIAL ADJACENT IMPLEMENTATION; EXECUTION CONTRACT MISSING.** The working branch's `src/modules/task-runtime/` persists user task runs and event histories but has no queue claims, worker leases, retry/dead-letter lifecycle or generic job executor. `src/kernel/outbox.ts` provides a durable event-delivery queue, not a job queue. On `gpt-part2-build-ci`, `build_pipeline_runs` persists idempotent queued pipeline-run records, and webhook delivery has leases/retries/dead letters, but the worker does not execute pipeline tasks. This is useful adjacent work, not a complete DP-045 job/queue manager. A trusted task-executor registry and job lifecycle contract are still absent; arbitrary caller-supplied commands must not be executable.
- **DP-046 — PARTIAL ON DIVERGENT BRANCH; NOT IN WORKING BRANCH.** The preserved Build & CI branch has a five-field cron parser, IANA timezone handling, bounded occurrence scans, durable schedule occurrences with unique identities, leases, retries, scan cursors and a scheduler worker. Tests in `test/build-ci-cron.test.ts`, `test/build-ci-schedule-dispatcher.test.ts` and `test/build-ci-worker.test.ts` cover timezone/DST behavior, exactly-once occurrence dispatch, retry after authorization failure, superseded pipeline versions, paused schedules, bounded worker cycles and workspace pagination. However, the dispatcher only creates queued pipeline-run records; the worker does not execute jobs. The module is not integrated into `forge-part02-audit`, and the source branch is materially divergent. No wholesale merge or duplicate scheduler port was made.
- **DP-047 — PARTIAL ADJACENT BACKUP CAPABILITY; PROVISIONING/REPLICAS MISSING.** The working branch's `src/kernel/backup.ts` creates consistent SQLite snapshots, checksums and verifies database integrity/audit-chain integrity; it also supports retention pruning and a local schedule. `src/kernel/backup-offsite.ts` defines and verifies off-site backup manifests/receipts. These are application backup/restore primitives, not managed database provisioning, replica creation/monitoring, failover or provider-managed lifecycle. No cloud database provider, authorized account, target region or replica policy exists.
- **DP-048 — BLOCKED / NOT IMPLEMENTED.** `src/kernel/sqlite.ts` and `src/kernel/postgres-migrations.ts` apply versioned, checksummed, forward-only application migrations. The migration contract contains version, name and SQL only; it has no preview/diff model or down/compensation migration contract. Build & CI's `createRollbackVersion` rolls back pipeline definitions by appending a new immutable version; it is not database rollback. Applying a generic down-SQL convention to already-shipped schemas without an explicit compatibility and data-loss policy would be unsafe. No fake preview or rollback was added.

No functional code was changed in this batch: DP-045/046 need a trusted executable job contract and careful selective integration of the divergent Build & CI work; DP-047 needs an authorized managed-database provider and replica policy; DP-048 needs a defined migration format and rollback/data-compatibility contract. These are recorded as specific blockers rather than falsely marked complete.

**Next batch in document order:** DP-049–DP-052 (cache management, object storage/CDN management, DNS safe-change previews, and SSL certificate lifecycle). Inspect existing cache/R2/DNS/certificate code and preserved branches before deciding which portions are reusable.


### Thirteenth four-feature batch: DP-049–DP-052 — SEARCH-CACHE / R2 BACKUP PARTIALS; DNS AND CERTIFICATE LIFECYCLE BLOCKED

Exact catalog requirements (Part 02 PDF, pages 6–7):
- **DP-049 (PRO; Plus):** Cache management and invalidation tools.
- **DP-050 (PRO; Plus):** Object storage and CDN management.
- **DP-051 (FREE; Free):** DNS management with safe-change previews.
- **DP-052 (FREE; Free):** SSL certificates: issue, renew, monitor.

Cross-branch inspection: the current `forge-part02-audit` tree has a user-scoped search-integrity cache and a narrow Cloudflare R2 event-chain anchor adapter. The preserved `gpt-part2-build-ci` branch is divergent and contains no DNS, certificate, CDN or general object-storage module in its compared file set. The other preserved branch comparisons did not surface those infrastructure modules either. No DNS or ACME/certificate provider integration was found.

Per-feature status:
- **DP-049 — PARTIAL ADJACENT IMPLEMENTATION; GENERAL CACHE INVALIDATION MISSING.** `src/modules/search-integrity/engine/search-cache.ts` provides TTL state and rate-bucket calculations for AI-070. `SearchIntegrityService.putCacheEntry/getCacheEntry`, the SQLite/PostgreSQL stores and `/v1/search-integrity/cache` routes implement per-user search-payload upsert/read with TTL and hit counts. `test/search-integrity.test.ts` covers owner authentication, normalization, TTL, expiry, hit counts and upsert. There is no cache delete/invalidate/list API, shared cache namespace, distributed cache backend, CDN purge or infrastructure-wide invalidation. This search-result cache does not complete DP-049.
- **DP-050 — PARTIAL ADJACENT OBJECT STORAGE; GENERAL STORAGE/CDN MANAGEMENT MISSING.** `src/kernel/anchor-r2.ts` implements a Cloudflare R2 S3-compatible SigV4 adapter for one fixed event-chain anchor object (GET/PUT). `src/kernel/backup-offsite.ts` builds and verifies off-site backup manifests and receipts; it is not a tenant object-storage product. There is no general object upload/download lifecycle, tenant bucket/object policy, retention/access control, CDN origin configuration, cache purge, custom-domain integration or distribution health management. A single audit-anchor key and backup manifest are not DP-050.
- **DP-051 — BLOCKED / NOT IMPLEMENTED.** No DNS provider adapter, zone/record inventory, record validation model, safe-change preview/diff, apply/rollback workflow or workspace-scoped DNS authorization exists. No provider or domain ownership can be inferred, so no simulated DNS changes or fake preview results were added.
- **DP-052 — BLOCKED / NOT IMPLEMENTED.** The repository enforces HTTPS origins in production and emits HSTS; PostgreSQL connections can require TLS. Those controls do not issue or renew public certificates. No ACME/provider integration, domain-control challenge flow, private-key custody, certificate inventory, renewal worker or expiry/health monitor exists. No certificate issuance or renewal behavior was fabricated.

No functional code was changed in this batch. The cache and R2 components are real but materially narrower than the catalog features; expanding them into shared infrastructure requires an agreed cache/object ownership and lifecycle model. DNS and certificate automation require owner-authorized domains/provider credentials and a key-custody boundary. Those blockers are recorded rather than hidden behind placeholder APIs.

**Next batch in document order:** DP-053–DP-056 (load balancing/traffic routing, private networking/service mesh, secrets management/rotation, and secret access audit/break-glass). Inspect the existing secret store and authorization/audit primitives; do not confuse them with cloud network or secret-manager provider integrations.


### Fourteenth four-feature batch: DP-053–DP-056 — NETWORKING BLOCKED; SECRET-REFERENCE ROTATION AND AUDIT PARTIALS

Exact catalog requirements (Part 02 PDF, page 7):
- **DP-053 (PRO; Pro):** Load balancer and traffic routing rules.
- **DP-054 (ENTERPRISE; Enterprise):** Private networking and service mesh.
- **DP-055 (PRO; Plus):** Secrets manager with rotation.
- **DP-056 (ENTERPRISE; Enterprise):** Secret access audit and break-glass access.

Cross-branch evidence: the current working branch has ordinary application route dispatch and database TLS configuration, not network load-balancer or service-mesh control. The preserved `gpt-part2-build-ci` branch adds workspace-scoped provider-secret references and append-only provider-connection events, but remains divergent from `forge-part02-audit`; its provider connection subsystem was not merged. Its security secret scanner detects secrets in source text; it is not a secrets vault.

Per-feature status:
- **DP-053 — BLOCKED / NOT IMPLEMENTED.** No load-balancer provider adapter, listener/backend inventory, health-probe model, weighted traffic policy, safe route preview, traffic-switch/rollback controller or provider authorization exists. Application route tables and feature gates are not load balancing or network traffic routing.
- **DP-054 — BLOCKED / NOT IMPLEMENTED.** No private-network/VPC/subnet provisioning, private service discovery, service-mesh control plane, workload identity, mTLS certificate lifecycle, mesh policy or sidecar/ambient data plane exists. PostgreSQL TLS and HSTS protect specific connections/HTTP responses; they do not provide private networking or a service mesh.
- **DP-055 — PARTIAL ON DIVERGENT BRANCH; GENERAL SECRETS MANAGER MISSING.** On `gpt-part2-build-ci`, `src/modules/build-ci/provider-connections.ts` and `provider-connection-operations.ts` store workspace-scoped `secret://`, `vault://` or `kms://` references, resolve values only through an external `ProviderSecretResolver`, validate workspace ownership, rotate references with compare-and-swap semantics and revoke connections. `test/build-ci-provider-connections.test.ts` covers inline-secret rejection, cross-workspace isolation, rotation/revocation races and secret-value non-disclosure. `test/build-ci-provider-connection-operations.test.ts` covers workspace authorization, append-only audit and secret-safe summaries. This is a provider-connection integration boundary, not a Forge-owned secrets manager: no central secret CRUD/version store, encryption/key custody, rotation schedule/worker, provider-wide secret inventory or generic application consumer exists.
- **DP-056 — PARTIAL AUDIT PRIMITIVES; ACCESS LOGGING AND BREAK-GLASS MISSING.** The same divergent provider-connection subsystem records append-only `created`, `secret_reference_rotated` and `revoked` events with workspace and actor attribution; tests verify that audit metadata omits secret references and that event rows cannot be updated/deleted. It does not record every actual secret read/use, nor implement emergency break-glass approval, justification, time-bounded elevation, notification, expiry and post-access review. Generic admin/action audit events do not substitute for secret-access audit and break-glass control.

No functional code was changed in this batch. DP-053/054 require owner-authorized network targets and provider integrations; DP-055/056 require a defined secret authority/key-custody boundary and break-glass policy. The useful provider-connection work remains preserved on `gpt-part2-build-ci` and was not copied as though it were a complete secrets product.

**Next batch in document order:** DP-057–DP-060 (environment-variable management with diff/rollback, cost monitoring/forecasts/budgets, cost anomaly alerts, and right-sizing/idle-resource cleanup suggestions). Inspect existing config/secret references and AI cost accounting, while keeping application settings and model-cost ledgers distinct from infrastructure environment and cloud-cost management.


### Fifteenth four-feature batch: DP-057–DP-060 — APPLICATION-LEVEL CONFIG/COST/SCALE PRIMITIVES; INFRASTRUCTURE CONTROL INCOMPLETE

Exact catalog requirements (Part 02 PDF, page 7):
- **DP-057 (FREE; Free):** Environment variable management with diff and rollback.
- **DP-058 (PRO; Plus):** Cost monitoring, forecasts, and budgets per project and service.
- **DP-059 (PRO; Pro):** Cost anomaly alerts.
- **DP-060 (PRO; Pro):** Right-sizing and idle-resource cleanup suggestions.

Per-feature status:
- **DP-057 — PARTIAL ADJACENT VERSIONING; PROJECT ENVIRONMENT MANAGEMENT MISSING.** The working branch's `src/config.ts` reads process-level `FORGE_*` environment settings at service startup; it does not provide workspace/project environment-variable CRUD, encrypted value storage, masked reads, environment promotion, change diff, or rollback. The divergent Build & CI branch versions immutable pipeline definitions and can diff/rollback those definitions, but that is not environment-variable management. Provider secret references are not a general environment-variable store. No project environment mutation API was added without a workspace/environment ownership and secret-value policy.
- **DP-058 — PARTIAL ADJACENT AI COST ACCOUNTING; CLOUD PROJECT/SERVICE COST MONITORING MISSING.** The working branch's `src/modules/ai-training/engine/cost-reproducibility-engine.ts` tracks per-training-run cost against a hard budget, and `task-budget-engine.ts` accounts time, cost and tool-call limits per task. `ai-training-service.ts` persists training-run cost entries. `test/ai-training-engines.test.ts` covers cost ledger limits and task-budget arithmetic; `test/ai-training.test.ts` covers the lifecycle and budget breach. These are model/task costs, not cloud provider invoice ingestion, project/service allocation, forecast models, or budget rollups across infrastructure.
- **DP-059 — BLOCKED / NOT IMPLEMENTED.** No cloud-cost usage feed, project/service spend time series, seasonality/baseline model, anomaly detector, alert threshold policy, notification channel or deduplicated alert lifecycle exists. A hard per-run budget refusal is not anomaly detection and cannot be represented as a cost anomaly alert.
- **DP-060 — PARTIAL ADJACENT MODEL-SERVING SCALE PLANNING; INFRASTRUCTURE RIGHT-SIZING/IDLE CLEANUP MISSING.** `src/modules/ai-training/engine/model-serving-engine.ts` calculates replica recommendations from request rate, latency, replica concurrency, target utilization and GPU assignment, and reduces replicas cautiously one at a time. `test/ai-training-lifecycle-engines.test.ts` covers serving scale planning and refusal cases. This is model-serving capacity planning; there is no cloud resource inventory, utilization history, idle-resource detection, projected savings, safe cleanup recommendation or provider-side cleanup operation. It does not complete DP-060.

No functional code was changed in this batch. The existing configuration, AI cost ledger and model-serving scale planner are real adjacent capabilities, but rebranding them as project infrastructure controls would be inaccurate. DP-057 needs an environment/secret ownership model; DP-058/059 need a trusted cloud billing feed and allocation policy; DP-060 needs provider inventory and a safe cleanup approval boundary.

**Next batch in document order:** DP-061–DP-064 (region/failover configuration, infrastructure template library, ephemeral microVM sandboxes, and runner-fleet management). Audit existing sandbox, template and runner work across the preserved branches before porting anything.


### Sixteenth four-feature batch: DP-061–DP-064 — TEMPLATE ADJACENCY; REGIONAL FAILOVER, MICROVM SANDBOXES AND RUNNER FLEET MISSING

Exact catalog requirements (Part 02 PDF, pages 7–8):
- **DP-061 (ENTERPRISE; Enterprise):** Region and failover configuration.
- **DP-062 (FREE; Free):** Infrastructure template library.
- **DP-063 (FREE; Free):** Ephemeral sandbox environments with microVM isolation.
- **DP-064 (PRO; Pro):** Runner fleet management: shared, dedicated, self-hosted.

Cross-branch inspection: no compared branch exposes a region/failover, microVM sandbox or runner-fleet subsystem. The preserved `gpt-part2-build-ci` branch adds `src/modules/build-ci/templates.ts` and template tests, but those are immutable Build & CI pipeline templates, not infrastructure provisioning templates. Its worker host explicitly does not execute pipeline tasks.

Per-feature status:
- **DP-061 — BLOCKED / NOT IMPLEMENTED.** No region inventory/selection, data-residency policy, regional resource provisioning, health-based failover, traffic failover controller or failback workflow exists. Database TLS and model-serving GPU assignment do not provide regional failover. A production region/failover design needs approved providers, regions, data residency and recovery objectives.
- **DP-062 — PARTIAL ADJACENT PIPELINE TEMPLATES; INFRASTRUCTURE TEMPLATES MISSING.** The divergent Build & CI branch has workspace/shared pipeline templates, immutable versions, import provenance, access grants, revocation/deprecation and template-version diffs. `test/build-ci-templates.test.ts` covers the pipeline-template lifecycle. These templates describe build pipelines; they do not provision cloud infrastructure, validate infrastructure parameters/policies, or apply/destroy resource plans. The branch remains unmerged and materially divergent.
- **DP-063 — BLOCKED / NOT IMPLEMENTED.** No Firecracker/microVM runtime, jailer, kernel/image lifecycle, ephemeral VM provisioner, per-sandbox network/storage boundary, snapshot/teardown controller or isolation verification exists. User task-run persistence and application-level approval gates are not an isolation boundary. No process/container sandbox was relabelled as microVM isolation.
- **DP-064 — BLOCKED / NOT IMPLEMENTED.** No runner registration/identity, heartbeat, capability advertisement, shared/dedicated/self-hosted fleet inventory, capacity scheduler, job claim/lease, runner drain or execution agent exists. Build & CI's `BuildCiWorkerHost` processes webhook and schedule queues but explicitly does not execute pipeline tasks. AI model-serving dedicated instances are not build runners.

No functional code was changed in this batch. DP-061 needs approved region/provider and recovery policy; DP-062 needs infrastructure template schemas and a provisioner; DP-063 needs an authorized microVM runtime and isolation threat model; DP-064 needs a trusted runner execution contract and fleet host lifecycle. Existing pipeline templates were not duplicated or misrepresented as infrastructure templates.

**Next batch in document order:** DP-065–DP-068. DP-065 is explicitly **FREE (not sold), Internal, Not sold (internal)**; preserve it as Forge-internal and do not expose it as a customer feature. DP-066 is network egress policy per job, DP-067 is per-job resource/time limits, and DP-068 is shared build cache across runs. Verify DP-065's feature-gate treatment before adding any customer-facing route.


### Seventeenth four-feature batch: DP-065–DP-068 — INTERNAL RUNNER FLAG PRESERVED; EGRESS/CACHE BLOCKED; TASK-BUDGET PRIMITIVES PARTIAL

Exact catalog requirements (Part 02 PDF, page 8):
- **DP-065 (FREE not sold; Internal):** Runner autoscaling down to zero. Catalog explicitly says **Not sold (internal)**.
- **DP-066 (PRO; Pro):** Network egress policies per job.
- **DP-067 (FREE; Free):** Resource and time limits per job.
- **DP-068 (PRO; Plus):** Build cache shared across runs.

Per-feature status:
- **DP-065 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; RUNNER AUTOSCALING NOT IMPLEMENTED.** `src/modules/plans/engine/part02-feature-gates.ts` places DP-065 in the `internal` range. `feature-gates.ts` explicitly defines internal rows as Forge machinery that is never sold and never enforced as a customer plan gate. Preserve that treatment; do not expose a customer route or convert it into a Free customer entitlement. No runner fleet or zero-capacity autoscaler exists yet.
- **DP-066 — BLOCKED / NOT IMPLEMENTED.** Neither the working branch nor the preserved Build & CI branch provides per-job network namespaces, egress allow/deny rules, DNS/IP/port policy enforcement, proxy controls, or runner-side policy verification. The Build & CI pipeline schema names task steps but has no egress policy contract, and its worker does not execute tasks. A route-level check cannot contain network access from a future job process.
- **DP-067 — PARTIAL ADJACENT TASK BUDGETS; RUNTIME RESOURCE ENFORCEMENT MISSING.** `src/modules/ai-training/engine/task-budget-engine.ts` supports per-task `timeMs`, `costUsdMicros` and `toolCalls` limits, with named refusals and atomic budget arithmetic. `test/ai-training-engines.test.ts` covers definition, charge and budget breach; `test/ai-training.test.ts` covers the service lifecycle. This is an application-level task budget, not a runner-enforced job resource envelope: no CPU, memory, disk, process count, hard wall-clock termination or sandbox quota enforcement exists.
- **DP-068 — BLOCKED / NOT IMPLEMENTED.** No shared build artifact/cache store, cross-run cache key contract, project/tenant namespace, immutable artifact manifest, integrity verification, eviction/retention policy or cache invalidation path exists. AI model-response/search caches are not build caches and were not counted as such.

No functional code was changed in this batch. DP-065 remains internal-only as the catalog requires; DP-066/067/068 depend on an actual isolated runner execution boundary before network, resource and cache guarantees can be enforced. The divergent Build & CI branch is preserved and was not merged wholesale.

**Next batch in document order:** DP-069–DP-072 (browser-based remote development environments, sandbox snapshots, internal-only untrusted-code isolation, and runner location choice). DP-071 is also explicitly **FREE (not sold), Internal, Not sold (internal)**; preserve it as Forge-internal and do not expose it as a customer feature.


### Eighteenth four-feature batch: DP-069–DP-072 — REMOTE DEVELOPMENT AND SNAPSHOTS MISSING; INTERNAL SANDBOX PRECHECK MADE EXPLICIT

Exact catalog requirements (Part 02 PDF, page 8):
- **DP-069 (PRO; Plus):** Remote development environments in the browser.
- **DP-070 (PRO; Pro):** Sandbox snapshots: save and restore a running state.
- **DP-071 (FREE not sold; Internal):** Untrusted-code isolation for marketplace plugins and agents. Catalog explicitly says **Not sold (internal)**.
- **DP-072 (ENTERPRISE; Enterprise):** Runner location choice, including near users.

Per-feature status:
- **DP-069 — BLOCKED / NOT IMPLEMENTED.** No browser-hosted IDE/terminal, remote workspace provisioner, persistent development filesystem, browser session lifecycle, workspace collaboration or remote development host exists. Build & CI pipeline templates and the browser-facing HTTP API are not remote development environments.
- **DP-070 — PARTIAL ADJACENT LOGICAL REPLAY; LIVE SANDBOX SNAPSHOTS MISSING.** `src/modules/task-runtime/engine/task-history.ts` stores a contiguous append-only task event journal and can replay logical task/step/gate state to a sequence number; the task-runtime service persists that journal. This does not snapshot a running VM/container, process memory, open files, filesystem layers or network state, and cannot restore a running sandbox. No snapshot provider, image/delta store, consistency barrier or restore lifecycle exists.
- **DP-071 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; RUNTIME ISOLATION NOT IMPLEMENTED.** `src/modules/plans/engine/part02-feature-gates.ts` maps DP-071 to `internal`, and `feature-gates.ts` states internal rows are Forge machinery, never sold and never enforced as customer plan gates. Preserve that treatment. The existing `src/modules/orchestrator/engine/execution-sandbox.ts` is a pure policy preflight (tool allowlist, command denylist, path and egress checks); it does not launch or isolate untrusted code. To prevent the API from implying otherwise, the verdict now explicitly returns `enforcement: 'preflight-only'`, and the module comment states that a trusted OS/VM runtime must enforce the restrictions. This is a safety-transparency correction, **not** microVM/container isolation or completion of DP-071.
- **DP-072 — BLOCKED / NOT IMPLEMENTED.** No runner fleet, region/zone inventory, placement scheduler, location affinity, user-latency measurement, residency policy or cross-region runner failover exists. The model-serving GPU planner and PostgreSQL TLS setting do not select runner locations.

Functional safety change in this batch:
- `src/modules/orchestrator/engine/execution-sandbox.ts`: every success and refusal now labels the result `enforcement: 'preflight-only'`; documentation explicitly disclaims process/VM/filesystem/network enforcement.
- `test/orchestrator-engines.test.ts` and `test/orchestrator.test.ts`: assert the preflight-only marker for engine verdicts and the HTTP response.
- Commits: `32079ccb5ff36c987055edd47c0e588f2585a93b`, `6772450ecf7ae3901e3d567504ad4fc648a538c5`, `5375a7baca2b91862ad2b7368ffe4a9333dd98ea`.
- Verification: the three files were re-fetched from `forge-part02-audit` and the marker/comment/test assertions were confirmed present. GitHub's combined-status query for `5375a7b` returned no status checks; **the code change is committed but CI/typecheck/full tests remain unverified**. The last CI-verified checkpoint is still the earlier run recorded at the top of this ledger.

No sandbox execution backend, browser development host or runner placement mechanism was fabricated.

**Next batch in document order:** DP-073–DP-076. DP-073 is explicitly **FREE (not sold), Internal, Not sold (internal)** and must remain internal-only. DP-074 is spot/preemptible capacity with retries; inspect the continuation on the next catalog page before implementation, along with DP-075/076 exact wording.


### Nineteenth four-feature batch: DP-073–DP-076 — THREE INTERNAL-ONLY FEATURES; GITHUB REPOSITORY MIGRATION MISSING

Exact catalog requirements (Part 02 PDF, pages 8–9):
- **DP-073 (FREE not sold; Internal):** Compute metering for billing. Catalog explicitly says **Not sold (internal)**.
- **DP-074 (FREE not sold; Internal):** Spot and preemptible capacity with safe retry. Catalog explicitly says **Not sold (internal)**.
- **DP-075 (FREE not sold; Internal):** FORGE hosts FORGE: its own repo, builds, and deploys run inside FORGE. Catalog explicitly says **Not sold (internal)**.
- **DP-076 (FREE; Free):** Migration assistant: import repos with full history, branches, tags, issues, and PRs from GitHub.

Per-feature status:
- **DP-073 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; COMPLETE COMPUTE METERING NOT PRESENT.** `part02-feature-gates.ts` maps DP-073 to `internal`; the registry law keeps internal rows out of customer plan enforcement. Existing per-training-run cost entries and per-task cost budgets are adjacent accounting primitives, but there is no trusted runner/compute usage meter that attributes CPU/GPU/memory/time consumption to billable jobs. Keep the feature internal and do not expose a customer entitlement.
- **DP-074 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; SPOT/PREEMPTIBLE EXECUTION MISSING.** DP-074 is in the internal gate range. No cloud spot/preemptible capacity provider, interruption signal handler, checkpoint-aware retry policy, idempotent requeue or capacity substitution exists. The preserved Build & CI worker does not execute pipeline tasks, so its webhook/schedule retry behavior is not safe retry of preempted compute.
- **DP-075 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; SELF-HOSTING FORGE ON FORGE MISSING.** DP-075 is in the internal gate range. This repository's verified build/test evidence is from GitHub Actions; the working branch has no self-hosted runner fleet or internal deployment pipeline that builds and deploys FORGE itself. The divergent Build & CI branch still has no task executor. Do not claim self-hosting from GitHub Actions CI or from a pipeline-definition module.
- **DP-076 — BLOCKED / NOT IMPLEMENTED.** No GitHub repository migration workflow was found that clones/imports full Git history, branches and tags, then imports issues and pull requests with identity/state/timestamp mapping and reconciliation. The preserved Build & CI branch has GitHub/GitLab webhook ingress and workspace-scoped provider connections, but those are event triggers and trust bindings, not a migration assistant. No GitHub App/API import authorization, repository transfer plan, history-preserving clone worker, issue/PR mapping, resumable checkpoint or post-import verification exists. The required full-history and issue/PR scope cannot be met by a shallow workspace search or webhook subscription.

No functional code was changed in this batch. DP-073–DP-075 remain Forge-internal and not sold, as the catalog requires; DP-076 needs an authorized GitHub App/API migration contract and a resumable import/reconciliation workflow before it can be implemented honestly.

**Next batch in document order:** DP-077–DP-080 (GitLab/Bitbucket import, GitHub↔FORGE mirror mode, verified cutover checklist, and internal-only FORGE upgrade pipeline). DP-080 is explicitly **FREE (not sold), Internal, Not sold (internal)**; preserve it as Forge-internal.


### Twentieth four-feature batch: DP-077–DP-080 — PROVIDER WEBHOOK ADJACENCY; REPOSITORY IMPORT/MIRROR/CUTOVER AND INTERNAL UPGRADE PIPELINE MISSING

Exact catalog requirements (Part 02 PDF, page 9):
- **DP-077 (FREE; Free):** Import from GitLab and Bitbucket.
- **DP-078 (FREE; Free):** Mirror mode: keep GitHub and FORGE in sync during the transition.
- **DP-079 (FREE; Free):** Cutover checklist and verification before retiring the old host.
- **DP-080 (FREE not sold; Internal):** FORGE upgrade pipeline: a canary FORGE instance tests the next FORGE version. Catalog explicitly says **Not sold (internal)**.

Per-feature status:
- **DP-077 — PARTIAL PROVIDER CONNECTIVITY; IMPORT NOT IMPLEMENTED.** The preserved `gpt-part2-build-ci` branch supports GitHub and GitLab webhook ingress and workspace-scoped provider connections. It has no Bitbucket provider adapter and no GitLab/Bitbucket repository importer that preserves full history, branches, tags, issues and merge requests. Webhook subscriptions are not repository migration.
- **DP-078 — PARTIAL EVENT INGRESS; BIDIRECTIONAL MIRROR MISSING.** GitHub/GitLab webhook events can trigger queued Build & CI pipeline runs on the divergent branch, but there is no Git remote mirror engine, scheduled fetch/push reconciliation, ref conflict detection/resolution, LFS/submodule handling, issue/PR synchronization or divergence dashboard. The worker does not execute pipeline tasks, and no GitHub↔FORGE mirror state is maintained.
- **DP-079 — BLOCKED / NOT IMPLEMENTED.** No migration cutover state machine, source/destination parity checks, branch/tag/issue/PR reconciliation report, freeze window, write-stop confirmation, rollback window, DNS/remote switch or old-host retirement verification exists. A static checklist without the preceding import and mirror evidence would be misleading.
- **DP-080 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; CANARY SELF-UPGRADE MISSING.** `part02-feature-gates.ts` maps DP-080 to `internal`; internal rows remain Forge machinery and are not customer plan entitlements. The current repository's verified build/test pipeline is GitHub Actions; no isolated canary FORGE instance, self-hosted build/deploy executor, version promotion controller, health/SLO gate or automatic rollback for FORGE's own release exists. The divergent Build & CI module still does not execute pipeline tasks. Preserve DP-080 as internal-only and do not expose it to customers.

No functional code was changed in this batch. GitLab/GitHub event ingress is useful adjacent work but does not satisfy repository import, bidirectional mirror or safe cutover. Those features require provider API authorization, a history-preserving Git transfer engine, reconciliation semantics and a verified cutover/rollback process. DP-080 remains internal-only.

**Next batch in document order:** DP-081–DP-084. DP-081 is explicitly **FREE (not sold), Internal, Not sold (internal)**; DP-083 is also explicitly **FREE (not sold), Internal, Not sold (internal)**. Preserve both as Forge-internal. DP-082 is the customer-facing Enterprise bootstrap installer; verify exact page text and inspect installation/migration tooling before implementation.


### Twenty-first four-feature batch: DP-081–DP-084 — INTERNAL SELF-UPDATE/MULTI-TENANCY; BOOTSTRAP AND DEDICATED STACKS MISSING

Exact catalog requirements (Part 02 PDF, pages 9–10):
- **DP-081 (FREE not sold; Internal):** Self-update with automatic rollback.
- **DP-082 (ENTERPRISE; Enterprise):** Bootstrap installer: bring up a fresh FORGE from nothing.
- **DP-083 (FREE not sold; Internal):** SaaS multi-tenant mode.
- **DP-084 (ENTERPRISE; Enterprise):** Dedicated single-tenant stacks.

Per-feature status:
- **DP-081 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; SELF-UPDATE NOT IMPLEMENTED.** DP-081 is in the internal gate range. No self-update agent, signed release manifest, staged upgrade, health gate, migration compatibility check or automatic rollback controller exists. GitHub Actions CI verifies code; it does not self-update a running FORGE installation. Preserve the feature as internal-only.
- **DP-082 — BLOCKED / NOT IMPLEMENTED.** The working branch has a Node backend with `npm run build/start`, database migrations and backup/restore CLI primitives, but no Dockerfile, Compose deployment, Helm chart, installer/bootstrap script, infrastructure provisioning plan, secrets bootstrap or first-admin setup workflow was found. A package start command is not a bootstrap installer. No cloud account or target topology is available to provision a fresh production installation.
- **DP-083 — INTERNAL-ONLY; UNINTEGRATED WORKSPACE FOUNDATION ON DIVERGENT BRANCH, NOT SAAS TENANCY.** DP-083 is in the internal gate range. The preserved `plan-hooks-foundation` branch contains `src/modules/workspaces/` with workspace/member records, SQLite/PostgreSQL stores, migrations and a service, and the `gpt-part2-build-ci` branch has a separate workspace-membership reader for pipeline authorization. However, the workspaces module has no `routes.ts` and is not wired into that branch's `src/app.ts`; the current `forge-part02-audit` app also does not compose it. Neither branch establishes tenant context across all module queries, per-tenant data isolation, tenant lifecycle/provisioning, quotas, tenant billing or cross-tenant access tests. This is partial, unintegrated workspace groundwork—not SaaS multi-tenant mode. Keep DP-083 internal-only and do not expose a customer entitlement.
- **DP-084 — BLOCKED / NOT IMPLEMENTED.** No tenant-specific infrastructure stack provisioner, isolated database/cache/object store, per-tenant network boundary, deployment lifecycle, health/upgrade orchestration or dedicated-stack billing exists. A workspace with `workspaceType: 'enterprise'` on the divergent workspace branch is a metadata classification, not a dedicated single-tenant deployment.

No functional code was changed in this batch. The workspace branch was inspected and preserved; it was not merged because it is divergent and lacks route/app integration and end-to-end tenant isolation. DP-082/084 require an approved deployment topology and provider boundary; DP-081/083 remain internal-only.

**Next batch in document order:** DP-085–DP-088 (on-prem installs via Helm/installer packages, air-gapped installs with offline update bundles, on-prem license/entitlement checks, and self-hosted telemetry controls). Inspect the existing license/entitlement and telemetry code, but do not equate ordinary SaaS billing or application logs with offline on-prem licensing/telemetry controls.


### Twenty-second four-feature batch: DP-085–DP-088 — INSTALLER/ON-PREM DISTRIBUTION MISSING; OFFLINE, LICENSE AND TELEMETRY PRIMITIVES PARTIAL

Exact catalog requirements (Part 02 PDF, page 10):
- **DP-085 (ENTERPRISE; Enterprise):** On-prem installs via Helm and installer packages.
- **DP-086 (ENTERPRISE; Enterprise):** Air-gapped installs with offline update bundles.
- **DP-087 (ENTERPRISE; Enterprise):** License management and entitlement checks for on-prem.
- **DP-088 (ENTERPRISE; Enterprise):** Telemetry controls for self-hosted installs [C].

Per-feature status:
- **DP-085 — BLOCKED / NOT IMPLEMENTED.** The working branch has Node build/start scripts and SQLite/PostgreSQL adapters, but no Dockerfile, Helm chart, installer package, cluster bootstrap, configuration/secret provisioning, health-gated upgrade or uninstall lifecycle. No self-hosted deployment topology is declared. `npm run build && npm start` is a developer/server start path, not Helm or an on-prem installer.
- **DP-086 — PARTIAL ADJACENT OFFLINE CAPABILITIES; SOFTWARE UPDATE BUNDLES MISSING.** `src/modules/ai-training/engine/model-serving-engine.ts` can describe on-device model bundles for llama.cpp/CoreML/ONNX/TFLite/WebGPU, and `src/kernel/offline-sync.ts` plus `src/modules/offline-sync/routes.ts` handle owner-scoped offline data synchronization. Neither creates signed FORGE application release bundles with a complete dependency manifest, version compatibility, signature verification, air-gapped transfer/import, staged apply and rollback. Model bundles and data-sync operations are not on-prem software updates.
- **DP-087 — PARTIAL ADJACENT SAAS ENTITLEMENT; ON-PREM LICENSE MANAGEMENT MISSING.** The working branch has central `canUse` plan gates, subscription-item entitlements and HMAC-signed access snapshots with expiry/user binding. These remain tied to the hosted billing/entitlement service and live server-state checks. There is no signed on-prem license artifact, offline signature verification lifecycle, installation/node binding, activation/renewal, grace period, revocation list, seat/instance count or license administration workflow. The existing access snapshot is not a full on-prem license system.
- **DP-088 — PARTIAL LOG HYGIENE; SELF-HOSTED TELEMETRY CONTROLS MISSING.** `src/kernel/logger.ts` redacts credential-like fields and `FORGE_LOG_LEVEL` controls application log verbosity. The append-only event chain is an audit record, not product telemetry. No self-hosted telemetry enable/disable policy, outbound endpoint selection, sampling/retention controls, payload minimization, tenant/site identity, consent record or verifiable no-egress mode exists. No telemetry was silently enabled or fabricated.

No functional code was changed in this batch. DP-085 needs an agreed supported deployment matrix; DP-086 needs a signed release/bundle format; DP-087 needs license issuance, binding and revocation policy; DP-088 needs a documented telemetry data contract and self-hosted privacy controls.

**Next batch in document order:** DP-089–DP-092 (whole-install backup/restore, internal-only active-active multi-region FORGE, internal-only public FORGE status page, and plugin/agent upgrade compatibility checker). DP-090 is explicitly **FREE (not sold), Internal, Not sold (internal)**; preserve it as Forge-internal.


### Twenty-third four-feature batch: DP-089–DP-092 — SQLITE BACKUP PRIMITIVES PARTIAL; INTERNAL MULTI-REGION/STATUS; PLUGIN COMPATIBILITY MISSING

Exact catalog requirements (Part 02 PDF, page 10):
- **DP-089 (ENTERPRISE; Enterprise):** Backup and restore for the whole FORGE install.
- **DP-090 (FREE not sold; Internal):** Multi-region active-active for FORGE itself.
- **DP-091 (FREE not sold; Internal):** Public status page for FORGE.
- **DP-092 (PRO; Pro):** Upgrade compatibility checker for plugins and agents.

Per-feature status:
- **DP-089 — PARTIAL SQLITE DATABASE BACKUP; WHOLE-INSTALL RESTORE MISSING.** `src/kernel/backup.ts` creates consistent SQLite snapshots, SHA-256 sidecars, verifies the event chain, prunes retained backups and can run a local schedule. `src/cli.ts` exposes `backup` and `verify`, but no restore command. The backup format covers the SQLite database only; it does not package PostgreSQL dumps, object storage, uploads/artifacts, installation configuration, secrets, deployment manifests or a coordinated version-compatible restore. The README explicitly notes that automated PostgreSQL backups are not yet implemented. `backup-offsite.ts` provides manifest/receipt integrity primitives, not a full off-site transfer-and-restore service. This does not satisfy whole-install backup and restore.
- **DP-090 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; ACTIVE-ACTIVE NOT IMPLEMENTED.** `part02-feature-gates.ts` maps DP-090 to `internal`; keep it outside customer entitlements. No multi-region event-log replication, globally consistent sequence/ledger, conflict resolution, region routing, active-active database topology, health failover or failback exists. A single PostgreSQL pool and hash-chained local event store are not active-active multi-region.
- **DP-091 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; PUBLIC STATUS PAGE NOT IMPLEMENTED.** DP-091 is mapped to `internal`. The app exposes `/healthz` and `/readyz` for operational probes, but no public status-page service, component inventory, incident lifecycle, scheduled maintenance notice, uptime history, external monitor ingestion or public status domain exists. Internal health endpoints are not a public status page.
- **DP-092 — BLOCKED / NOT IMPLEMENTED.** The orchestrator has a static agent/tool registry, and the divergent Build & CI branch has versioned pipeline/template definitions. Neither has a plugin/agent package manifest with supported FORGE API ranges, dependency constraints, permission/capability migrations, runtime compatibility matrix, upgrade dry-run, breaking-change report or rollback recommendation. Model-version promotion and pipeline-template diffs are different domains and were not counted as plugin compatibility checking.

No functional code was changed in this batch. DP-090/091 remain internal-only; DP-089 needs a coordinated multi-store backup/restore design and PostgreSQL/object-storage support; DP-092 needs an actual plugin/agent packaging and version contract before a compatibility checker can be meaningful.

**Next batch in document order:** DP-093–DP-094 followed by OB-001–OB-002 (exactly four feature IDs across the DP→OB section boundary). DP-093 and DP-094 are explicitly **FREE (not sold), Internal, Not sold (internal)**; preserve them as Forge-internal.


### Twenty-fourth four-feature batch: DP-093, DP-094, OB-001, OB-002 — INTERNAL DOGFOODING/REHEARSAL MISSING; HEALTH AND CORRELATION PRIMITIVES PARTIAL

Exact catalog requirements (Part 02 PDF, pages 10–11):
- **DP-093 (FREE not sold; Internal):** Dogfooding dashboard: FORGE's own health, builds, and incidents. Catalog explicitly says **Not sold (internal)**.
- **DP-094 (FREE not sold; Internal):** Disaster rehearsal: simulate a FORGE outage and test recovery. Catalog explicitly says **Not sold (internal)**.
- **OB-001 (FREE; Free):** Application performance monitoring.
- **OB-002 (FREE; Free):** Distributed tracing across services.

Per-feature status:
- **DP-093 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; DOGFOODING DASHBOARD MISSING.** DP-093 is in the internal gate range. The working branch has `/healthz` and `/readyz`, structured application logs, and external GitHub Actions build/test runs, but no consolidated FORGE-owned dashboard combining health, builds, deployment state, incidents, alerts and historical trends. Keep this internal-only; do not expose it as a customer plan feature.
- **DP-094 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; DISASTER REHEARSAL MISSING.** DP-094 is in the internal gate range. SQLite backup creation and `verifyBackup` verify a backup file and event-chain integrity, but no controlled outage simulator, fault injection, failover/recovery drill, measured RTO/RPO, restore verification against a clean environment or rehearsal report exists. A backup verification test is not a disaster rehearsal.
- **OB-001 — PARTIAL HEALTH/DOMAIN METRICS; APPLICATION PERFORMANCE MONITORING MISSING.** `src/kernel/health.ts` exposes liveness/readiness endpoints and an audit sequence head; it does not measure request latency distributions, throughput, error rates, resource utilization, saturation or dependency timings. AI model-serving code has domain-specific latency/usage metrics, but there is no general application APM instrumentation, metric aggregation/exporter, retention policy or performance dashboard.
- **OB-002 — PARTIAL EVENT CORRELATION; DISTRIBUTED TRACING MISSING.** `src/kernel/events.ts` carries `correlationId` and `causationId` in event envelopes, providing useful audit/event linkage. The HTTP request context does not establish a trace/span context propagated across service boundaries, and there is no traceparent/W3C context propagation, span creation, parent/child timing, sampling, trace exporter or cross-service trace backend. Event correlation IDs alone are not distributed tracing.

No functional code was changed in this batch. DP-093/094 remain internal-only. OB-001/002 have useful health/event correlation primitives, but the full monitoring and tracing data paths are absent; no fake metrics or spans were added.

**Next batch in document order:** OB-003–OB-006 (log aggregation with fast search, auto-instrumentation and structured logging helpers, custom/infrastructure/business metrics, and dashboard builder with templates).


### Twenty-fifth four-feature batch: OB-003–OB-006 — STRUCTURED LOGGING/EVENT HISTORY PARTIAL; AGGREGATION, GENERAL METRICS AND DASHBOARDS MISSING

Exact catalog requirements (Part 02 PDF, page 11):
- **OB-003 (FREE; Free):** Log aggregation with fast search.
- **OB-004 (FREE; Free):** Auto-instrumentation and structured logging helpers.
- **OB-005 (FREE; Free):** Metrics: custom, infrastructure, business.
- **OB-006 (FREE; Free):** Dashboard builder with templates.

Per-feature status:
- **OB-003 — PARTIAL LOG SOURCES; AGGREGATION/SEARCH MISSING.** `src/kernel/logger.ts` emits structured JSON records through a configurable sink, and `src/kernel/events.ts` stores an append-only hash-chained event stream with bounded sequence reads. There is no multi-process log collector, indexed log store, query/filter/search API, time/field index, retention/partition policy or fast-search UI. The audit event chain is not a searchable application log aggregator.
- **OB-004 — PARTIAL STRUCTURED LOGGER; AUTO-INSTRUMENTATION MISSING.** The logger supports child context and redacts sensitive-looking fields before output. The HTTP kernel dispatches routes but does not automatically create request/dependency spans, capture route latency/status/error metrics, propagate trace context or instrument database/provider calls. Explicit event emission and manually supplied logger fields are not automatic instrumentation.
- **OB-005 — PARTIAL DOMAIN METRICS; GENERAL CUSTOM/INFRASTRUCTURE/BUSINESS METRICS MISSING.** The AI model-serving lifecycle has domain-specific request, latency, success/error, token and cost aggregation, with engine tests. No general metric registry, custom metric ingestion, host/container/DB infrastructure collectors, business metric definitions, label cardinality controls, aggregation windows or metrics exporter exists.
- **OB-006 — BLOCKED / NOT IMPLEMENTED.** No dashboard definition/store, reusable dashboard templates, widget/query model, permission-scoped data source, dashboard renderer or dashboard lifecycle routes exist. Health endpoints and static test reports are not a dashboard builder.

No functional code was changed in this batch. The logger and event store are useful primitives, but implementing aggregation, automatic instrumentation, general metrics and dashboards requires a coherent telemetry pipeline and data-retention/authorization model; no in-memory-only dashboard placeholder was added.

**Next batch in document order:** OB-007–OB-010 (natural-language dashboard creation, error tracking with grouping/regression detection, release health by version, and real-user monitoring for web/mobile [C]).


### Twenty-sixth four-feature batch: OB-007–OB-010 — DASHBOARD/ERROR/RELEASE/RUM SYSTEMS MISSING; REQUEST LOGGING AND TEST REGRESSION ADJACENT

Exact catalog requirements (Part 02 PDF, page 11):
- **OB-007 (FREE; Free):** Natural-language dashboard creation.
- **OB-008 (FREE; Free):** Error tracking with grouping and regression detection.
- **OB-009 (FREE; Free):** Release health: errors and crashes per version.
- **OB-010 (PRO; Plus):** Real user monitoring for web and mobile [C].

Per-feature status:
- **OB-007 — BLOCKED / NOT IMPLEMENTED.** No dashboard definition/query model or dashboard renderer exists, so there is no safe target for natural-language dashboard generation. The orchestrator can classify intents and plan tasks, but it does not translate natural-language requests into validated observability dashboard specifications.
- **OB-008 — PARTIAL ERROR LOGGING/TEST REGRESSION; ERROR TRACKING MISSING.** `src/kernel/http.ts` logs unhandled errors with request ID and route, and `src/kernel/logger.ts` redacts structured log fields. The test-quality module has visual/test regression checks, not runtime exception tracking. There is no durable error-event intake, stack normalization, grouping fingerprint, issue lifecycle, affected-release correlation, regression detection or alert workflow.
- **OB-009 — PARTIAL PIPELINE/VERSION RECORDS ON DIVERGENT BRANCH; RELEASE HEALTH MISSING.** The preserved Build & CI branch records immutable pipeline versions and queued run statuses, but does not execute or deploy releases. The working branch has no release/deployment record tied to runtime errors/crashes. AI model versions and their serving metrics are not FORGE application release health. No per-release crash/error-rate aggregation, regression gate or release health view exists.
- **OB-010 — BLOCKED / NOT IMPLEMENTED.** No browser/mobile RUM SDK, page-view/session sampling, Web Vitals, navigation/resource timing, crash beacon, consent/privacy controls, client-side identity boundary or ingestion pipeline exists. Server request logs and synthetic/live-testing sessions are not real-user monitoring.

No functional code was changed in this batch. The existing request logs, test regression utilities and divergent pipeline version records are adjacent signals only; no error tracker or RUM endpoint was fabricated.

**Next batch in document order:** OB-011–OB-014 (mobile crash and not-responding reports; scripted/AI-driven synthetic monitoring; multi-region uptime monitoring; SLO/SLA tracking with error budgets).


### Twenty-seventh four-feature batch: OB-011–OB-014 — LIVE-TESTING AND HEALTH PRIMITIVES PARTIAL; CRASH INGESTION, SYNTHETIC MONITORS, MULTI-REGION UPTIME AND SLOs MISSING

Exact catalog requirements (Part 02 PDF, pages 11–12):
- **OB-011 (FREE; Free):** Mobile crash and not-responding reports.
- **OB-012 (PRO; Pro):** Synthetic monitoring: scripted and AI-driven user journeys.
- **OB-013 (PRO; Plus):** Uptime monitoring from multiple regions.
- **OB-014 (PRO; Pro):** SLO and SLA tracking with error budgets.

Per-feature status:
- **OB-011 — PARTIAL MOBILE TEST-SESSION SUPPORT; CRASH/ANR TELEMETRY MISSING.** The live-testing module supports web/mobile test-session workflows, step recording, lifecycle transitions and findings. It does not ingest crash dumps or application-not-responding reports from deployed mobile clients, normalize device/OS/app-version metadata, group crash fingerprints, correlate sessions/releases or provide crash-rate dashboards. Testing a mobile journey is not collecting real-user mobile crash telemetry.
- **OB-012 — PARTIAL AGENT-DRIVEN TEST JOURNEYS; SYNTHETIC MONITORING SERVICE MISSING.** `src/modules/live-testing/live-testing-service.ts` creates and manages owner-scoped agent testing sessions, records steps/findings and builds replayable timelines. There is no scheduled monitor definition, multi-region probe fleet, synthetic identity/secret handling, recurring journey runner, expected-result assertion lifecycle, monitor availability series or alert integration. User-triggered live testing is not continuous synthetic monitoring.
- **OB-013 — PARTIAL SINGLE-INSTANCE HEALTH PROBES; MULTI-REGION UPTIME MISSING.** `/healthz` and `/readyz` expose liveness/readiness for the current deployment. There are no geographically distributed probes, independent probe credentials, regional result aggregation, quorum/false-positive policy, outage timeline or uptime/SLA report.
- **OB-014 — BLOCKED / NOT IMPLEMENTED.** Request duration is logged, but no SLO/SLA objective model, good-event/total-event counter, rolling error budget, burn-rate calculation, window policy, exclusion/maintenance handling or SLO report exists. A request log or test-quality threshold is not an operational error budget.

No functional code was changed in this batch. The live-testing, health and request-log features are useful adjacent components, but they do not create production synthetic monitors or SLO accounting. No synthetic uptime or SLA values were invented.

**Next batch in document order:** OB-015–OB-018 (burn-rate alerts; performance regression detection tied to commits/deploys; capacity planning/forecasting; and cost attribution by service, team and feature).


### Twenty-eighth four-feature batch: OB-015–OB-018 — OUTBOX DELIVERY PRIMITIVE PARTIAL; ALERT RULES, OWNERSHIP ROUTING AND CHANNELS MISSING

Exact catalog requirements (Part 02 PDF, page 12):
- **OB-015 (PRO; Pro):** Burn-rate alerts.
- **OB-016 (PRO; Plus):** Alert rules with dedupe, grouping, and suppression.
- **OB-017 (PRO; Team, also Studio):** Alert routing by ownership from the graph. Catalog note: needs team seats (3 minimum) or a Studio plan.
- **OB-018 (PRO; Plus):** Channels: push, email, SMS, chat, voice call.

Per-feature status:
- **OB-015 — BLOCKED / NOT IMPLEMENTED.** The prerequisite SLO/error-budget model (OB-014) is absent. No rolling-window burn-rate calculation, multi-window policy, alert state machine, dedupe key or burn-rate notification exists. No burn-rate value was inferred from request logs.
- **OB-016 — PARTIAL DURABLE EVENT DELIVERY; ALERT RULE ENGINE MISSING.** `src/kernel/outbox.ts` provides transactional event delivery with persisted retry/backoff, delivered/dead-lettered states and event-ID identity. It does not define metric/event alert conditions, rule versions, grouping keys, alert fingerprints, suppression windows, recovery/resolution events or alert lifecycle state. The outbox is a delivery substrate, not an alert manager.
- **OB-017 — BLOCKED / NOT IMPLEMENTED.** No service ownership graph, component-to-team mapping, on-call schedule, escalation chain, fallback owner or ownership-change audit exists. The divergent workspace membership modules provide roles/membership, not an ownership graph or on-call routing. Team plan gates alone cannot route alerts.
- **OB-018 — BLOCKED / NOT IMPLEMENTED.** No push-token registry/provider, email delivery adapter, SMS gateway, chat integration, voice-call provider, delivery preference/consent model, channel retry policy or per-channel delivery receipt exists. Identity email normalization and event outbox delivery do not send notifications.

No functional code was changed in this batch. OB-016 can reuse the durable outbox only after an alert model and channel delivery contract exist; OB-015 depends on SLOs; OB-017 needs an ownership/on-call graph; OB-018 needs provider credentials, consent and channel adapters. No placeholder notification endpoints were added.

**Next batch in document order:** OB-019–OB-022 (explainable metric anomaly detection, commit/deploy-linked performance regression detection, capacity planning/forecasting, and cost attribution by service/team/feature).


### Twenty-ninth four-feature batch: OB-019–OB-022 — AI METRIC/TREND/COST PRIMITIVES PARTIAL; GENERAL ANOMALY, RELEASE REGRESSION, CAPACITY AND COST ALLOCATION MISSING

Exact catalog requirements (Part 02 PDF, page 12):
- **OB-019 (PRO; Pro):** Anomaly detection on any metric with explainable baselines.
- **OB-020 (PRO; Pro):** Performance regression detection tied to commits and deploys.
- **OB-021 (PRO; Pro):** Capacity planning and forecasting.
- **OB-022 (PRO; Team, also Studio):** Cost attribution by service, team, and feature. Catalog note: needs team seats (3 minimum) or a Studio plan.

Per-feature status:
- **OB-019 — PARTIAL AI-SPECIFIC TRENDS/METRICS; GENERAL EXPLAINABLE ANOMALY DETECTION MISSING.** The AI training/model-serving area records domain-specific metrics and trend samples, but there is no arbitrary metric registry, baseline training/selection, seasonality handling, explainable anomaly score, alert lifecycle or cross-domain metric support. AI agent trend histories and serving percentiles do not satisfy anomaly detection on any metric.
- **OB-020 — PARTIAL TEST REGRESSION AND COMMIT TRIGGERS; DEPLOY-LINKED PERFORMANCE REGRESSION MISSING.** Test-quality includes visual/test regression checks, and the divergent Build & CI pipeline schema can receive push/PR events with a commit SHA. The pipeline worker does not execute tasks or deploy releases, and no performance baseline is bound to commit/deploy IDs. There is no latency/throughput comparison, statistical regression threshold, release annotation or automated regression gate tied to a deployed version.
- **OB-021 — PARTIAL MODEL-SERVING REPLICA PLANNING; INFRASTRUCTURE CAPACITY FORECASTING MISSING.** `planServingScale` estimates replicas from current request rate, average latency, replica concurrency, target utilization and GPU assignments. It is a point-in-time model-serving scale decision, not historical demand forecasting, scenario planning, cloud quota/capacity forecasting or multi-service resource planning.
- **OB-022 — PARTIAL PER-RUN/PER-TASK AI COSTS; SERVICE/TEAM/FEATURE ATTRIBUTION MISSING.** The AI cost ledger and task-budget engine record training-run/task costs and enforce local budgets. They do not ingest cloud billing, allocate shared infrastructure costs by service/team/feature, map resources to an ownership graph, apply allocation rules or reconcile allocations to invoices. Workspace membership on divergent branches is not a cost-allocation graph; the Team/Studio gate does not create one.

No functional code was changed in this batch. Existing AI-specific metric, trend, scale and cost primitives are useful but too narrow to represent general observability or cloud-finance capabilities. No synthetic baselines, forecasts, release-performance values or team cost allocations were invented.

**Next batch in document order:** OB-023–OB-026. Read the exact next-page feature names and plan assignments before auditing.


### Thirtieth four-feature batch: OB-023–OB-026 — SOURCE SECURITY, AUDIT AND DATA/MODEL QUALITY PRIMITIVES PARTIAL

Exact catalog requirements (Part 02 PDF, page 13):
- **OB-023 (PRO; Pro):** Security monitoring and detection rules.
- **OB-024 (ENTERPRISE; Enterprise):** Compliance monitoring and evidence collection.
- **OB-025 (PRO; Pro):** Data-quality monitoring.
- **OB-026 (FREE not sold; Internal):** Model monitoring: drift, latency, quality, cost. Catalog explicitly says **Not sold (internal)**.

Per-feature status:
- **OB-023 — PARTIAL SOURCE SCANNING; RUNTIME SECURITY MONITORING MISSING.** The preserved Build & CI branch has `src/modules/security/secrets.ts` and `policy.ts` for secret-pattern and dependency-policy scanning, with redacted findings and configurable source-policy rules. This scans repository content; it does not collect runtime security telemetry, detect suspicious user/service behavior, evaluate a general detection-rule stream, correlate incidents or route alerts. The module is on a divergent branch and is not integrated into `forge-part02-audit`.
- **OB-024 — PARTIAL AUDIT/CONSENT EVIDENCE; COMPLIANCE CONTROL MONITORING MISSING.** The working branch has actor/subject-attributed hash-chained events, identity/plans audit events, and a durable consent grant/revoke ledger in training-data. These are valuable evidence sources. There is no control framework mapping, evidence request/schedule, policy evaluation, retention/attestation workflow, regulatory control coverage, evidence export package or compliance status report.
- **OB-025 — PARTIAL INGESTION QUALITY/PROVENANCE; CONTINUOUS DATA-QUALITY MONITORING MISSING.** Training-data admission records rights, source-terms, consent, license and quality scores; the AI-training data path enforces classification/consent gates and stores dataset snapshots/quality values. This provides admission-time checks and provenance, not ongoing quality monitors for freshness, completeness, schema drift, duplicate rates, distribution shifts, lineage breakage or alerting across data pipelines.
- **OB-026 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; MODEL MONITORING PARTIAL.** `part02-feature-gates.ts` maps OB-026 to `internal`; preserve it outside customer plan entitlements. The AI-training module already records model-serving latency/throughput/cost metrics (including p50/p95/p99), eval scores and trend samples, and can report degraded trend buckets. It does not yet provide a complete input/data drift detector with explainable baselines and a unified monitor lifecycle across drift, latency, quality and cost. Keep this Forge-internal and do not expose it as a customer feature.

No functional code was changed in this batch. Existing source scanners, audit/consent ledgers, dataset admission checks and model-serving metrics are useful primitives, but none was promoted to a complete monitoring product without the missing continuous collection, policy and alert paths.

**Next batch in document order:** OB-027–OB-030 (agent-action monitoring/anomaly detection; trace-to-code navigation; deployment markers on charts; and one query language across logs, metrics and traces).


### Thirty-first four-feature batch: OB-027–OB-030 — AGENT AUDIT AND COMMIT TRIGGER PRIMITIVES PARTIAL; TRACE NAVIGATION, DEPLOY MARKERS AND UNIFIED QUERY MISSING

Exact catalog requirements (Part 02 PDF, page 13):
- **OB-027 (PRO; Pro):** Agent action monitoring with anomaly detection.
- **OB-028 (PRO; Plus):** Trace-to-code: jump from any span to the exact function and commit.
- **OB-029 (FREE; Free):** Deployment markers on every chart.
- **OB-030 (PRO; Plus):** One query language across logs, metrics, and traces.

Per-feature status:
- **OB-027 — PARTIAL AGENT ACTION AUDIT; ANOMALY DETECTION MISSING.** The orchestrator records agent/tool-plan actions and the shared event envelope supports `actor.kind = 'agent'`, correlation and causation identifiers. The source-scanning policy branch also emits findings. There is no baseline over agent action frequency/sequence/permission denials, behavioral anomaly model, risk score, incident state or alert integration. Auditability is not anomaly detection.
- **OB-028 — BLOCKED / NOT IMPLEMENTED.** The HTTP kernel has request IDs and events have correlation/causation IDs, but no distributed spans, source-map/function symbol index, span-to-stack mapping, commit metadata propagation or code navigation link exists. Build & CI triggers can carry a commit SHA, but that does not connect a span to an exact function and commit.
- **OB-029 — BLOCKED / NOT IMPLEMENTED.** No dashboard/chart system exists and there is no deployment lifecycle/record on the working branch. The small DP-015 dependency planner does not deploy releases. The divergent Build & CI branch records pipeline versions and trigger runs but does not deploy, so it cannot emit reliable deployment markers on charts.
- **OB-030 — BLOCKED / NOT IMPLEMENTED.** No shared logs/metrics/traces schema, parser, query planner, authorization-aware query engine, time-series/log/trace backend or cross-signal join semantics exists. Existing module search endpoints are domain-specific and are not an observability query language.

No functional code was changed in this batch. Agent audit events and commit-aware pipeline triggers are partial correlation primitives only; no spans, deployments or unified observability query service were simulated.

**Next batch in document order:** OB-031–OB-034 (saved views/shareable investigations, retention tiers/sampling controls, observability cost controls, and PII scrubbing in logs/traces).


### Thirty-second four-feature batch: OB-031–OB-034 — INVESTIGATION/RETENTION/COST CONTROLS MISSING; CREDENTIAL REDACTION IS NOT PII SCRUBBING

Exact catalog requirements (Part 02 PDF, page 13):
- **OB-031 (PRO; Plus):** Saved views and shareable investigations.
- **OB-032 (PRO; Plus):** Retention tiers and sampling controls.
- **OB-033 (PRO; Plus):** Observability cost controls.
- **OB-034 (FREE; Free):** PII scrubbing in logs and traces.

Per-feature status:
- **OB-031 — BLOCKED / NOT IMPLEMENTED.** No unified observability query/dashboard model exists to save, version, share or permission-scope an investigation. Search endpoints in other product modules are not saved log/metric/trace investigations.
- **OB-032 — BLOCKED / NOT IMPLEMENTED.** There is no observability ingestion pipeline with per-signal retention tiers, sampling configuration, tail-based sampling, retention enforcement or user-visible sampling evidence. Event-chain append-only integrity and backup pruning are different storage policies.
- **OB-033 — BLOCKED / NOT IMPLEMENTED.** No telemetry volume metering, ingest/retention budget, cardinality controls, cost allocation, budget alert or cost-based sampling controller exists. AI model token-cost budgets do not measure observability storage/ingestion cost.
- **OB-034 — PARTIAL CREDENTIAL REDACTION; PII SCRUBBING MISSING.** `src/kernel/logger.ts` redacts values whose field names resemble credentials (password, token, secret, cookie, authorization, key, credential). It does not scrub email addresses, phone numbers, IP addresses, names or other PII from arbitrary strings, error messages or stack traces, and no trace pipeline exists. `src/kernel/http.ts` currently includes request IP in structured request logs. Credential-key redaction must not be described as PII scrubbing.

No functional code was changed in this batch. A safe PII-scrubbing policy needs explicit data classes, field-level exceptions, trace handling and privacy/retention rules; broad regex replacement without a policy could either leak data or destroy operational evidence.

**Next batch in document order:** OB-035–OB-038. Verify the exact next-page requirements and their plan assignments before auditing.


### Thirty-third four-feature batch: OB-035–OB-038 — REQUEST TIMING EXISTS; PROFILING, DB INSIGHTS, FRONTEND TIMING AND CDN ANALYTICS MISSING

Exact catalog requirements (Part 02 PDF, pages 13–14):
- **OB-035 (PRO; Pro):** Production profiling: CPU, memory, flame graphs.
- **OB-036 (PRO; Pro):** Database insights: slow queries, locks, index suggestions.
- **OB-037 (PRO; Plus):** Frontend performance: web vitals, long tasks, render timing.
- **OB-038 (PRO; Pro):** Network and CDN analytics.

Per-feature status:
- **OB-035 — PARTIAL REQUEST DURATION LOGGING; PRODUCTION PROFILING MISSING.** `src/kernel/http.ts` measures request duration and logs status/route, and AI model-serving has latency percentiles. There is no CPU/memory profiler, allocation/GC profile, sampling profiler, flame-graph collector, profile storage or production profile viewer.
- **OB-036 — BLOCKED / NOT IMPLEMENTED.** SQLite/PostgreSQL stores issue queries directly, but no query-duration instrumentation, normalized query fingerprint, slow-query threshold, lock/wait sampling, explain-plan capture, index recommendation engine or DB-insights dashboard exists. Static SQL and successful persistence tests are not database performance insights.
- **OB-037 — BLOCKED / NOT IMPLEMENTED.** The current product tree is a backend service and contains no browser/mobile frontend instrumentation SDK. No Web Vitals, long-task observer, navigation/render timing, device/network classification, client sampling or frontend performance ingestion pipeline exists.
- **OB-038 — BLOCKED / NOT IMPLEMENTED.** No CDN provider or edge distribution is configured. The narrow R2 audit-anchor adapter and server request logs do not expose network path timing, edge cache hit/miss, origin latency, egress volume, regional POP performance or CDN analytics.

No functional code was changed in this batch. Request duration and model-serving latency are narrower application metrics; they do not justify claims of continuous profiling, database insights, frontend monitoring or CDN analytics.

**Next batch in document order:** OB-039–OB-042 (Forge-internal creative-tool telemetry; OpenTelemetry support in/out; incident declaration; severity levels and response playbooks). OB-039 is explicitly **FREE (not sold), Internal, Not sold (internal)** and must remain Forge-internal.


### Thirty-fourth four-feature batch: OB-039–OB-042 — INTERNAL CREATIVE TELEMETRY; OTEL AND INCIDENT MANAGEMENT MISSING

Exact catalog requirements (Part 02 PDF, page 14):
- **OB-039 (FREE not sold; Internal):** Creative tool telemetry: render times, export failures, GPU use [C]. Catalog explicitly says **Not sold (internal)**.
- **OB-040 (PRO; Plus):** OpenTelemetry support in and out.
- **OB-041 (FREE; Free):** Incident declaration, manual and automatic.
- **OB-042 (PRO; Plus):** Severity levels and response playbooks.

Per-feature status:
- **OB-039 — INTERNAL-ONLY / NOT CUSTOMER-SOLD; CREATIVE TELEMETRY NOT IMPLEMENTED.** OB-039 is in the internal gate range. No creative-render/export module, render job lifecycle, GPU telemetry collector or creative-tool failure event stream exists in the working branch. Preserve it as internal-only; do not expose a customer route.
- **OB-040 — BLOCKED / NOT IMPLEMENTED.** No OpenTelemetry SDK/provider, OTLP receiver/exporter, trace/span context propagation, metrics/logs bridge, sampling configuration or collector endpoint exists. Request IDs, event correlation IDs and structured logs are not OpenTelemetry support in or out.
- **OB-041 — BLOCKED / NOT IMPLEMENTED.** No incident entity/store, declaration endpoint, automatic incident trigger, status transition lifecycle, acknowledgement, mitigation/resolution timestamp or incident audit timeline exists. `/healthz`, `/readyz`, event logs and outbox dead letters are inputs that could feed incidents later; they are not incident declarations.
- **OB-042 — BLOCKED / NOT IMPLEMENTED.** No severity taxonomy, impact/scope model, escalation timer, responder assignment, response playbook catalog, action checklist, approval boundary or severity-change audit exists. Error codes and plan tiers are not incident severity levels.

No functional code was changed in this batch. The repository has useful health, event and outbox primitives, but no incident management state machine or OpenTelemetry data path. No synthetic incidents or severity policies were invented.

**Next batch in document order:** OB-043–OB-046 (war room with live channel/timeline/roles/evidence, incident agent with ranked hypotheses, unified logs/metrics/traces/deploy timeline, and postmortems with follow-up tasks).


### Thirty-fifth four-feature batch: OB-043–OB-046 — LIVE-TESTING/AGENT/EVENT PRIMITIVES ADJACENT; INCIDENT WAR ROOM AND CHANGE CAUSALITY MISSING

Exact catalog requirements (Part 02 PDF, pages 14–15):
- **OB-043 (PRO; Team, also Studio):** War room: live channel, timeline, roles, linked evidence. Catalog note: needs team seats (3 minimum) or a Studio plan.
- **OB-044 (PRO; Pro):** Incident Agent live investigation with ranked hypotheses.
- **OB-045 (PRO; Pro):** One timeline for logs, metrics, traces, deploys, and config changes.
- **OB-046 (PRO; Pro):** Suspect-change finder: which commit, deploy, or flag likely caused it.

Per-feature status:
- **OB-043 — PARTIAL COLLABORATION PRIMITIVES; INCIDENT WAR ROOM MISSING.** Live-testing has owner-scoped collaboration roles, session messages, findings and a replayable test timeline. These belong to test sessions, not incidents. There is no incident entity, incident-scoped live channel, responder role/assignment, linked observability evidence, war-room lifecycle or team-seat enforcement for incident collaboration.
- **OB-044 — PARTIAL GENERAL AGENT ORCHESTRATION; INCIDENT INVESTIGATION MISSING.** The orchestrator can select agents, plan tool actions and record agent events. It has no incident context loader, hypothesis schema/ranking/evidence confidence, hypothesis-to-signal links, investigator loop or incident-state integration. General agent planning is not an incident investigation agent.
- **OB-045 — PARTIAL AUDIT EVENT SEQUENCE; UNIFIED CROSS-SIGNAL TIMELINE MISSING.** The event store provides an ordered hash-chained audit sequence and correlation/causation IDs. It does not ingest or normalize logs, metrics, traces, deployments and configuration changes into one queryable timeline. No trace/deploy/config-change sources or cross-signal time alignment exists.
- **OB-046 — BLOCKED / NOT IMPLEMENTED.** No incident baseline, deployment/change inventory, feature-flag change history, commit-to-deploy mapping, temporal correlation model or ranked causal hypothesis engine exists. Build & CI's push/PR trigger events carry commit SHAs but are not deployment events and do not prove causality.

No functional code was changed in this batch. Existing live-testing collaboration and orchestrator agents are not incident management; the event chain is not a multi-signal observability timeline. No suspect commit/deploy/flag was fabricated.

**Next batch in document order:** OB-047–OB-050 (remediation suggestions with risk preview; policy-bounded autopilot remediation; on-call schedules/rotations/overrides/follow-the-sun; and escalation policies with acknowledgement timers).


### Thirty-sixth four-feature batch: OB-047–OB-050 — REMEDIATION/INCIDENT DEPENDENCIES MISSING; ON-CALL TEAM/SEAT FOUNDATION NOT WIRED

Exact catalog requirements (Part 02 PDF, page 15):
- **OB-047 (PRO; Pro):** Suggested remediation with risk preview.
- **OB-048 (PRO; Pro):** Autopilot remediation within policy: rollback, restart, scale, flag off.
- **OB-049 (PRO; Team, also Studio):** On-call schedules with rotations, overrides, follow-the-sun. Catalog note: needs team seats (3 minimum) or a Studio plan.
- **OB-050 (PRO; Team, also Studio):** Escalation policies with acknowledgement timers. Catalog note: needs team seats (3 minimum) or a Studio plan.

Per-feature status:
- **OB-047 — BLOCKED / NOT IMPLEMENTED.** There is no incident record/state model, alert-to-incident linkage, incident evidence bundle, ranked hypothesis engine, remediation catalog or risk-preview evaluator. The orchestrator can plan generic agent actions, but it does not produce incident-specific remediation proposals or quantify their blast radius, reversibility, confidence and expected impact. No generic "safe" score has been fabricated.
- **OB-048 — BLOCKED / NOT IMPLEMENTED.** No approved remediation action registry, per-action policy constraints, approval/authorization boundary, execution journal, rollback verification or incident remediation controller exists. The only deployment feature present is DP-015's dependency-graph planner; it does not deploy or roll back. Restart/scale/feature-flag actuators are not wired. Automatic mutation without those controls would be unsafe.
- **OB-049 — BLOCKED / NOT IMPLEMENTED.** The source tree has no on-call scheduling module, routes, schedule/override persistence or rotation/follow-the-sun resolver. A workspace implementation exists as isolated source, but the application composition root does not wire its membership service or routes, and the plan access decision does not enforce the catalog's three-seat minimum. The governing plan notes also leave the Team seat entitlement/billing model and sellable price book owner-blocked. A schedule built on an unverified team/seat model would misgrant access and could assign responders who are not authorized team members.
- **OB-050 — BLOCKED / NOT IMPLEMENTED.** There is no incident lifecycle, escalation-policy schema, durable acknowledgement state, timer worker or responder notification dispatcher. The generic transactional outbox is a delivery primitive, not an escalation scheduler or notification channel. No acknowledgement timer can be claimed operational until due-stage transitions are driven reliably and the assigned responders are notified.

No functional code was changed in this batch. Existing orchestrator planning, live-testing collaboration, the DP-015 dependency graph, and the generic outbox are adjacent primitives only; none was promoted into incident remediation or on-call functionality. OB-049/050 additionally depend on a confirmed Team/Studio seat and membership model. The seven SC rows marked "Not tiered here" remain excluded from ordinary subscription gating.

**Next batch in document order:** OB-051–OB-054 (on-call load/fatigue reporting; status page management with component states; AI-drafted customer updates for approval; incident roles: commander, scribe and communications). Verify the exact page text and plan notes before assessing.


### Thirty-seventh four-feature batch: OB-051–OB-054 — STATUS PAGE MANAGEMENT IMPLEMENTED; ON-CALL ANALYTICS, AI CUSTOMER DRAFTS AND INCIDENT ROLES DEPEND ON MISSING INCIDENT/ON-CALL FOUNDATION

Exact catalog requirements (Part 02 PDF, page 15):
- **OB-051 (PRO; Team, also Studio):** On-call load and fatigue reporting. Catalog note: needs team seats (3 minimum) or a Studio plan.
- **OB-052 (PRO; Plus):** Status page management with component states.
- **OB-053 (PRO; Plus):** Customer updates drafted by AI for approval.
- **OB-054 (PRO; Team, also Studio):** Incident roles: commander, scribe, comms. Catalog note: needs team seats (3 minimum) or a Studio plan.

Per-feature status:
- **OB-051 — BLOCKED / NOT IMPLEMENTED.** There are no on-call schedules, rotation records, shift handoffs, override history, acknowledgement/response activity or responder workload samples from which to calculate load and fatigue. A report without those underlying facts would be fabricated. This remains dependent on OB-049.
- **OB-052 — IMPLEMENTED IN THE BACKEND; CI-VERIFIED.** Added an owner-scoped status-page model with unique slugs, draft/published lifecycle, component records, validated component states (operational, degraded, partial_outage, major_outage, maintenance), public read of published pages, and an append-only component-state change history carrying actor, previous/next state, reason and timestamp. Added SQLite and PostgreSQL migrations/stores, authenticated Plus-gated management routes, a public read route, and integration tests. Component-state changes and their history rows are written in one database transaction in both durable adapters. The repository is a backend service; a separately hosted status-page frontend/domain is outside this repository.
- **OB-053 — PARTIAL ADJACENT AI CAPABILITY; CUSTOMER APPROVAL WORKFLOW MISSING.** AI-training and orchestrator capabilities exist, but there is no incident context source, customer-impact summary contract, audience/channel policy, generated update versioning, approval/rejection state or publication record. Generic text generation is not an incident customer-update workflow.
- **OB-054 — BLOCKED / NOT IMPLEMENTED.** No incident entity or incident-scoped membership/role assignment exists. Live-testing collaboration roles are bound to test sessions, not incidents, and cannot be reused as incident commander/scribe/comms permissions. The Team three-seat/Studio entitlement is also not backed by a shared incident-team membership model.

Files added: src/modules/status-pages/types.ts, store.ts, in-memory-store.ts, sqlite-store.ts, postgres-store.ts, migrations.ts, postgres-migrations.ts, status-page-service.ts, routes.ts, index.ts, and test/status-pages.test.ts.
Files updated: src/app.ts, src/main.ts, src/modules/plans/engine/route-gates.ts, test/pg-helpers.ts, and this ledger.

**Next batch in document order:** OB-055–OB-058. Verify the exact catalog rows and plan notes before assessment.


OB-052 verification note: the first CI attempt for commit 88575881 failed during TypeScript typecheck because three new classes used constructor parameter properties, which the repository's erasableSyntaxOnly compiler setting forbids. No tests ran in that attempt. The constructor declarations have been rewritten as explicit fields/assignments in the corrective commit; the feature remains unverified until the next full CI run passes.

OB-052 follow-up verification: commit 88df054 passed TypeScript typecheck. Its full test run exposed one stale route-registry assertion (the route map correctly grew from 295 to 300 after adding five OB-052 management paths); both new status-page route tests passed. The next correction updates the pinned route count and expands durable-adapter coverage, adds case-insensitive component-name uniqueness, keeps the page timestamp current on component changes, and prevents in-place mutation of component history while allowing account-deletion cascades.


### OB-052 PostgreSQL migration correction (2026-11-25)

- CI run [45358725450](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/45358725450) for `f1e1227e17582ee1976946891bb55dc1d7ae5c65` passed TypeScript typecheck but failed the test job: 944 passed, 26 failed, 23 cancelled, 1 skipped. The first failures occurred while the shared real-PostgreSQL test harness applied `pgStatusPageMigrations`; the PL/pgSQL trigger body used a single `$` instead of the required `$$` dollar-quote delimiter. This prevented multiple PostgreSQL-backed suites from bootstrapping, including the OB-052 integration test.
- The first documentation checkpoint (commit `9613f4c`) did not include the migration file in its diff, so the malformed delimiter remained in source. This follow-up applies the actual source correction. The existing `test/status-pages-postgres.test.ts` exercises durable component transitions, page timestamp updates, actor/history persistence, and rejection of history mutation against real PostgreSQL. The source correction is verified by CI run [45566518272](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/45566518272): TypeScript typecheck passed; the full test job reported 993 tests, 992 passed, 0 failed, 0 cancelled, and 1 skipped.


### Hook 16 export coverage checkpoint (2026-11-25)

- Commit `9caa56b72d43bbd833bd2e2cad619a87fd77607b` adds owner-scoped enumeration for offline-sync operation history, current entity snapshots and both open and resolved conflicts in the SQLite and PostgreSQL stores. The account export now includes all three collections rather than only open conflicts.
- Search-integrity cache entries and every web-search domain rule are now enumerable by owner in the in-memory, SQLite and PostgreSQL adapters. The export no longer omits rules merely because a workspace has not yet produced a query.
- Regression tests cover owner isolation, resolved-conflict history, export payload inclusion and the PostgreSQL offline-sync adapter. CI run [45570919143](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/45570919143) passed TypeScript typecheck and the full test job.
- Hook 16 remains incomplete: parent-keyed AI-training records still need safe owner-level enumeration; external binary/model artifacts need a storage-provider export contract; the workspaces module is not composed into the application. The export remains explicitly marked incomplete. Hard deletion remains disabled pending owner-verified data inventory and jurisdiction-approved retention policy.

### Hook 16 module-export verification checkpoint (2026-11-25)

- Commit `33374b0182e065aa813d55f1f1214933e970b996` added owner-scoped exports for the application modules and an explicit incomplete-coverage manifest. TypeScript typecheck passed in CI run [45568041936](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/45568041936), but the test job reported 992 passed, 1 failed, 1 skipped. The only failing test was the new export integration fixture: the Orchestrator requires at least one valid plan step, while the fixture supplied only a goal. The fixture now supplies a valid search/write sequence; rerun CI before treating this export expansion as verified.
