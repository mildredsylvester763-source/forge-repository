# FORGE Part 02 and Plan Hooks — implementation audit ledger

**Governing scope:** only the user's two documents: **FORGE Plan Hooks (Subscription, Billing & Entitlements)** (Library source file: `Forge Feature — Plan Hooks (build notes).pdf`) and **Forge Feature — Catalog Part 02 With Plans.pdf**. Their requirement text is authoritative.

**Repository:** `mildredsylvester763-source/forge-repository`  
**Working branch:** `forge-part02-audit`, retained as an isolated branch based on `manus/part36-safety`.  
**Latest code commit:** `87600b95749e88fb2eea2c14411bc4d61e471d8c`; the ledger is updated after that code commit.  
**Latest verified code checkpoint:** `09467782c1c1798a85e3111b67dde31173271c54`. GitHub Actions run [44887995902](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/44887995902) passed typecheck and the full test job at that checkpoint.  
**New commits after the verified checkpoint:** `949e0bad`, `e937f2f`, `23ad4ce`, `87600b9`. These add production rate-limit configuration enforcement and concurrent job-charge regression tests. GitHub currently reports no commit status checks for the latest SHA, so these commits are **committed but not yet CI-verified**. Do not describe them as passing.  
**Audit date:** 2026-11-22.

## Plan Hooks — prerequisite audit

| Hook | Status | Current repository evidence and remaining work |
|---|---|---|
| 1 — Subscription items list; one live base plan; any number of passes | **IMPLEMENTED** | SQLite/PostgreSQL `subscription_items`, partial unique index for one active/grace base plan, migration v11 from legacy `user_plans`, provider event application, and audited admin comp. Entitlement reads in `getEntitlementState` and `canUse` derive from subscription items only. `user_plans` remains a compatibility mirror; direct seeding is test-only. |
| 2 — One `canUse(user, featureId)` decision | **IMPLEMENTED** | `PlansService.canUse` is the access decision used by the route-gate middleware. Unknown feature IDs fail closed; feature switches and paused/deletion-queued accounts are checked. Keep all new feature gates routed through this path. |
| 2b — Unpaid engines stay open at Free level; a pass raises only its engine | **PARTIAL / OWNER + ENGINE-INTEGRATION BLOCKER** | Engine rows remain available and return per-engine `free`/`paid` levels. Free-window credits, the 600-credit monthly ceiling, engine-tagged spending and the $0.20 monthly free-engine cost cap are enforced. The repository does not yet enforce the document's free-model-only, quality, output-size, watermark and commercial-use restrictions end-to-end in each engine consumer. The governing documents do not enumerate the approved free model/quality/output profiles; do not invent them. |
| 3 — Append-only, engine-tagged credit ledger; derived balances; deterministic spending; job identity | **IMPLEMENTED; NEW CONCURRENCY TESTS CI-PENDING** | Balances are derived from ledger entries. Engine-pool then general-pool allocation, source priority and expiry ordering are deterministic; spend allocations expire with their source grants. Migration v9 persists `job_engine`; every spend entry records `jobId` and initiating `jobEngine`. A same-job retry returns the original result; a changed amount, cost or engine is rejected with `credit_job_conflict`. SQLite transactions and PostgreSQL per-user row locks serialize competing charges. Existing SQLite/PostgreSQL cross-engine tests plus new concurrent retry tests cover this path. New tests are committed in `23ad4ce` and `87600b9`, awaiting CI. |
| 4 — Product catalog, per-window cap, regional minor-unit price book, ALG-43/52/56 | **OWNER-BLOCKED; PRODUCTS SAFELY NON-SELLABLE** | Product-code/type/plan/engine mapping and credit allocation validation exist. Production rejects sellable catalog entries until regional minor-unit prices, per-window caps and the ALG-43 cost floor, ALG-52 margin guard and ALG-56 pass-versus-all-round-plan comparison are implemented and configured. The two governing documents reference those algorithms but do not provide the formulas or verified cost/price inputs. No prices or formulas have been fabricated; the catalog remains empty/non-sellable. |
| 5 — Master and per-feature switches | **IMPLEMENTED** | Strict `FORGE_GATES_ENABLED` parsing, per-feature switches and production refusal to disable the master gate are present. |
| 6 — Verify payment signatures and process each event ID once | **IMPLEMENTED** | HMAC verification precedes mutation. SQLite claims the unique event ID and applies subscription/ledger changes in one write transaction; PostgreSQL locks the user row and claims the unique event ID in one transaction. Duplicate deliveries do not grant twice. Hash-chained audit events are appended inside the same transaction; notifications are emitted after commit. PostgreSQL audit-failure rollback tests prove that payment claims, entitlements and credits roll back together. |
| 7 — Money stored in smallest units with currency | **IMPLEMENTED FOR EVENT STORAGE; PRICE RECONCILIATION BLOCKED BY HOOK 4** | Payment events persist integer `amountMinor` plus ISO currency; actual compute cost is stored as integer micro-dollars. Reconciliation against the checkout's configured regional product price cannot be completed while the price book and margin rules are absent. |
| 8 — Country table with currency, region band, checked tax rule, methods, enabled flag and payout minimum | **IMPLEMENTED; OWNER DATA REQUIRED** | Country-row validation, registry engine and authenticated routes exist. `FORGE_COUNTRY_CATALOG` is empty by default. Owner must provide verified country rows, tax-rule text and check dates, payment methods and minimum payout before enabling a country. |
| 9 — Signed short-lived access snapshot for bad networks | **BACKEND IMPLEMENTED; CLIENT INTEGRATION REMAINS** | Backend signs plan/pass/expiry snapshots, binds verification to the authenticated user, checks expiry and current server state, and refuses paused/deletion-queued accounts. The client-side offline cache, refresh and reconnect lifecycle is not present in this backend repository. |
| 10 — Append-only who/when/what/why audit for plan, credits, refunds, overrides and admin actions | **IMPLEMENTED FOR EXISTING MUTATIONS; REFUND LIFECYCLE BLOCKED** | Payment, credit grant/spend, promotion definition/redemption, account-control changes and admin comp append hash-chained audit records in their database transaction; notifications occur after commit. Admin records carry actor, target, action and reason. Refund/reversal operations are not implemented, so their audit lifecycle remains open with Hook 15. |
| 11 — Admin grant, comp, pause and ledger view | **IMPLEMENTED; OWNER ACTIVATION REQUIRED** | Authenticated admin routes, allowlist checks, required reasons, actor attribution, credit grants, subscription-item comp, pause/resume and ledger view exist. `FORGE_ADMIN_USERS` intentionally remains empty until the owner names the administrators. Admin comp updates the subscription item and compatibility mirror atomically with both audit events. |
| 12 — One durable coupons/trials/referrals model; limits, expiry, credits or time | **PARTIAL / TIME-BENEFIT POLICY BLOCKER** | Durable promotion definitions/redemptions, redemption limits, expiry, credit grant and transactional audit are implemented. Day-based benefits are rejected as `promotion-days-unsupported` because no target subscription item or renewal/extension policy is defined in the governing documents. |
| 13 — Server UTC clock for windows and expiry | **IMPLEMENTED** | Credit windows, monthly resets and entitlement decisions use the injected server clock and UTC boundaries. Production clock synchronization remains an operational responsibility. |
| 14 — Per-user and per-device gateway rate limits before AI work | **IMPLEMENTED IN CODE; NEW PRODUCTION GUARD CI-PENDING; THRESHOLDS OWNER-SUPPLIED** | Gated requests authenticate, enforce the signed server-issued HttpOnly device identity limit, then enforce the user limit before access checks and handler execution. PostgreSQL/SQLite shared rate-limit stores are wired into the production composition root. New commits `949e0bad` and `e937f2f` make production startup fail unless both user and device rules are explicitly configured; tests cover missing/partial configuration. The owner must supply real `FORGE_RATE_LIMITS` thresholds. |
| 15 — Fake payment/test mode and fake clock for renewals, failures, upgrades and refunds | **PARTIAL / LIFECYCLE POLICY BLOCKER** | Fake clock, HMAC-signed test payment events and event idempotency exist. Renewal, failed-payment/grace transitions, upgrade/downgrade, refund and reversal state machines are not complete. The governing documents do not define provider event types or refund/reversal accounting semantics; do not invent money or entitlement behavior. |
| 16 — User export and deletion with jurisdiction-specific retention | **PARTIAL / OWNER LEGAL APPROVAL REQUIRED** | The current export includes plan, passes, subscription items and credit ledger, not all account/workspace data. A confirmed request durably pauses and queues the account and records an audit event; it does not hard-purge data. Full export requires an inventory of all user-owned records. Hard deletion must remain disabled until the owner verifies applicable retention requirements, including Nigeria's NDPR and other relevant jurisdictions. |

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
- No Part 02 functional feature has been committed yet. The first four IDs in document order are DP-001 through DP-004.

### First four-feature batch: DP-001–DP-004 — BLOCKED BEFORE IMPLEMENTATION

Exact catalog requirements (Part 02 PDF, page 2):
- **DP-001:** One-click deploy from any branch, tag, or commit.
- **DP-002:** Environment pipeline: dev, staging, production with promotion rules.
- **DP-003:** Preview deployments per PR with shareable URLs.
- **DP-004:** Blue-green deployments with instant switch.

Repository inspection: `src/app.ts` currently composes task runtime, orchestrator, test quality/generation, live testing, web search, workspace retrieval, search integrity, AI training, training data, plans and offline sync. It does not compose a deployment module or expose deployment routes/stores/providers. No deploy-target adapter or authorized infrastructure credentials are present in the governing documents or current repository configuration.

A real implementation cannot be completed by adding placeholder APIs or simulated deployment success. These four features require the owner to select and authorize the deployment provider/target and supply its integration credentials, plus the production promotion/rollback boundary. Until that is available, all four remain blocked and no mock deployment implementation has been added. DP-005–DP-008 are not started because they depend on the same deployment substrate.

## Recent implementation evidence

- `0946778` — latest previously CI-verified Plan Hooks checkpoint; full typecheck and test job passed in run [44887995902](https://github.com/mildredsylvester763-source/forge-repository/actions/runs/44887995902).
- `949e0bad` — production configuration now requires both per-user and per-device gateway rate-limit rules.
- `e937f2f` — configuration tests cover absent, user-only, device-only and valid production rules.
- `23ad4ce` — SQLite job-charge retry test now exercises concurrent duplicate submissions.
- `87600b9` — PostgreSQL job-charge test proves concurrent submissions charge the persisted job once and preserve its engine identity.
- Latest commit status lookup for `87600b95749e88fb2eea2c14411bc4d61e471d8c` returned no check statuses. The four commits above are committed but **not verified by CI yet**.

`main` has not been modified. Divergent branches have not been merged or overwritten. Continue only on `forge-part02-audit`; preserve the seven SC exclusions in all subsequent gate and feature work.
