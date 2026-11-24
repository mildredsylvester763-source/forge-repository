# FORGE Part 02 and Plan Hooks — implementation audit ledger

**Governing scope:** only the user's two documents: **FORGE Plan Hooks (Subscription, Billing & Entitlements)** (Library source file: `Forge Feature — Plan Hooks (build notes).pdf`) and **Forge Feature — Catalog Part 02 With Plans.pdf**. Their requirement text is authoritative.

**Repository:** `mildredsylvester763-source/forge-repository`  
**Working branch:** `forge-part02-audit`, retained as an isolated branch based on `manus/part36-safety`.  
**Latest code commit:** `8c008ecdc518aaa9ea13be318f49c63932d3cde5`; this ledger update follows that code checkpoint.  
**Latest verified code checkpoint:** `8c008ecdc518aaa9ea13be318f49c63932d3cde5`. GitHub Actions run [45134257552](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/45134257552) passed typecheck and the full test job: 982 tests, 981 passed, 0 failed, 1 skipped.  
**Intermediate verification:** `9f31ddc` passed in [run 45133878250](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/45133878250). `69ba292` initially failed because the export test assumed the optional trusted-device store was configured; `8c008ec` explicitly represents that capability as unavailable and the full suite then passed.  
**Audit date:** 2026-11-24.

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
| 16 — User export and deletion with jurisdiction-specific retention | **PARTIAL / OWNER LEGAL APPROVAL REQUIRED** | The export is now returned as a no-store JSON attachment and includes the public profile, plan, passes, subscription items, credit ledger and active session metadata. Trusted-device metadata is included when that optional store is configured; otherwise the export explicitly reports `trustedDevices: null` rather than failing or implying an empty list. Password hashes and session credentials are not exported. It still omits records owned by workspace, task, test, search, training and other product modules, so it is not yet a complete account export. A confirmed request durably pauses and queues the account and records an audit event; it does not hard-purge data. Full export requires a complete user-data inventory. Hard deletion must remain disabled until the owner verifies applicable retention requirements, including Nigeria's NDPR and other relevant jurisdictions. |

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
9. Hook 16 needs a full user-data inventory and jurisdiction-approved retention/deletion policy.

Do not invent missing prices, algorithms, legal retention rules, admin identities, provider event semantics or free-tier engine profiles. These blockers are recorded so independent work can proceed without repeating the same inspection.

## Part 02 catalogue

- The catalog has **459 distinct feature IDs** across DP, OB, CG, RV, BD and SC. The repeated CG-061 occurrence is a cross-reference, not another feature.
- **452** rows are tiered.
- These seven rows are explicitly **Not tiered here** and must stay outside ordinary subscription gating: `SC-020`, `SC-021`, `SC-022`, `SC-023`, `SC-041`, `SC-062`, `SC-063`.
- The 452-row Part 02 gate metadata is registered centrally; the seven SC rows remain excluded.
- The 452-row central gate registry is metadata, not feature delivery. DP-015 now has a partial, Pro-gated dependency-planning endpoint; no other Part 02 feature is yet implemented end-to-end.

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

