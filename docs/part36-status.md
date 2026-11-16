# Part 36 implementation status — Safety Toggles and the Hard Floor

Source: **Catalog Part 36 Safety Toggles and the Hard Floor (With Plans)**, dated 16 Nov 2026, TS-761..TS-800. Related sources: Plan Hooks (8 Nov, later Hook 5–16 and 10 Nov engine-law additions), Tag Rules v1 (14 Nov), Modes: Linking, Combining and Level Value v1 (14 Nov), Catalog Part 35 (13 Nov), and Engines and Algorithms (v1). Part 36 is newer and governs safety behavior. The repository implementation is on a separate `manus/part36-safety` branch based on `origin/mistral`; shared `mistral` has not been changed.

## Source reconciliation and binding rules

- Part 36 supersedes older safety-toggle assumptions. Safety state is read through the Part 36 `toggleService.read` boundary; `canUse` is still for feature access and administrative-console authorization, not for turning protections on/off.
- `INTERNAL` and `FREE (not sold)` refer to the same non-customer machinery. Existing Mistral gate vocabulary calls that `internal`; no parallel gate system is being added.
- Tag Rules (14 Nov) and Plan Hooks (10 Nov clarification) agree that creative engine features remain available at free level; a plan/pass changes limits, not whether an engine exists. Existing Mistral `canUse` implements this.
- Modes v1 (14 Nov), Part 35 (13 Nov), and Part 36 (16 Nov) agree that there is no minimum effort level and no level-based safety block. Lower effort gets an honest value warning/receipt; the immutable child-safety floor is not an effort level and cannot be toggled.
- Jurisdictional requirements remain pinned ON when the applicable law requires them. The dual-use review gate and authorization floor remain owner decisions; the interim behavior is ON by default, owner-controlled only, and logged. Minor protection is intended to be non-exemptible (Part 36 decision, with the source's noted confirmation caveat); no override path is being built for minors.
- Prices, credit quantities, limits, and numeric examples are not approved values. They must be moved to one settings/price-book structure and not embedded in algorithms. The credit meter counts units only; it does not carry monetary value. This repository currently violates that new constraint in its plan defaults and ledger's cost field; that remains an explicit hook-retrofit item below.
- Engines and Algorithms requires stable interfaces: any future open-source component must sit behind the same Forge-owned interface and be replaceable after benchmark evidence. No detection library/provider is selected here.

## Implemented in this first safety slice

- `src/modules/safety/engine/toggle-state-engine.ts`: provider-neutral read contract, versioned snapshots, all-on defaults, legal compliance marked law-sourced, fail-safe reader, and a child-safety floor represented outside mutable categories.
- `src/modules/safety/index.ts`: public module export boundary.
- `test/safety-toggle-state.test.ts`: tests of default-on state, fail-safe behavior, floor immutability, law pinning, open-decision defaults, and scope isolation.
- Focused verification: `node --test test/safety-toggle-state.test.ts` — 6 passed.
- These are an in-memory/reference boundary only, not a persistent production toggle service, audit vault, detection/classifier/reporting system, or operational integration. No Part 36 row is yet declared fully complete solely from this slice.

## Row-by-row ledger

| ID | Status | Evidence / next dependency |
|---|---|---|
| TS-761 | **BLOCKED / floor primitive only** | Immutable constant exists. Hash matching, classifier, grooming detection, evaluated test samples, and jurisdiction-specific reporting integration are absent. Do not claim operational CSAM detection or reporting. Requires owner-approved provider/process, privacy/legal review, and validated safe test corpus. |
| TS-762 | NOT STARTED | Needs vetted detector/model, fixed benchmark, recall acceptance criteria (settings), red-team/evasion harness, alerting/incident integration. |
| TS-763 | PARTIAL | Mutable state excludes the floor; no release gate that proves policy changes cannot weaken it yet. |
| TS-764 | PARTIAL | User state reads ON and the service policy refuses writes to the user lane; account-integrated route and component-wide enforcement remain absent. |
| TS-765 | NOT STARTED | Requires complete protection catalog and public/user panel; use free access, never plan-gate safety. |
| TS-766 | NOT STARTED | Notification and appeal/review integrations absent. |
| TS-767 | NOT STARTED | Plain-language safety lessons absent. |
| TS-768 | PARTIAL | Personalization is categorized and defaults on at the protection layer; explicit consent capture and no-consent measurement are absent. |
| TS-769 | PARTIAL | `minor_ceiling` is represented and has no OFF path in the policy engine/service; age/AA age-law integration and maximum-profile wiring are absent. Must remain non-exemptible. |
| TS-770 | NOT STARTED | Appeal workflow/review queue and verified restoration path absent. |
| TS-771 | PARTIAL | Owner-only decision/service path can change owner-lane state and requires an audit event; durable repository adapter, optimistic concurrency implementation, and runtime console are absent. |
| TS-772 | PARTIAL | Legal/dual-use/authorization categories are represented and default on; no country law adapter or authorization review integration. |
| TS-773 | NOT STARTED | Admin console and state display/enforcement parity absent. |
| TS-774 | PARTIAL | Owner target scope is validated and scoped reads/writes are represented; persistent workspace/sandbox adapters and Enterprise workspace-admin lane are absent. |
| TS-775 | PARTIAL | Safety audit-event shape is built and passed with state to an atomic-commit port; it is not yet written to the existing hash-chained event store. |
| TS-776 | NOT STARTED | No self-audit report. |
| TS-777 | NOT STARTED | No mutation history/restore-all action. |
| TS-778 | NOT STARTED | No delegation/role model for scoped toggles. |
| TS-779 | NOT STARTED | Formal, visible, time-boxed user/workspace overrides and minor/floor exclusions absent. |
| TS-780 | NOT STARTED | Override artifact schema/validation absent; duration bounds remain configuration decisions. |
| TS-781 | NOT STARTED | Override history and export absent. |
| TS-782 | NOT STARTED | Expiry scheduler and automatic restore absent. |
| TS-783 | NOT STARTED | Platform-wide revoke-all absent. |
| TS-784 | NOT STARTED | User-facing override notice absent. |
| TS-785 | PARTIAL | Public state reader and service boundary with versioned scoped writes are added; persistent storage, runtime component adoption, and app-level version propagation absent. |
| TS-786 | PARTIAL | Versioned toggle audit-event payload is generated with each allowed service write; hash-chain persistence and chain verification are not wired. |
| TS-787 | NOT STARTED | Owner alert integration absent. |
| TS-788 | PARTIAL | Fail-safe and resilient readers plus service outage handling return ON/degraded snapshots; truthful user/admin degraded-state messaging and deployed adapter outage tests remain absent. |
| TS-789 | PARTIAL | Jurisdictional compliance category is hard-pinned ON in the reference reader; country-specific law mapping and enforcement integration absent. |
| TS-790 | NOT STARTED | Agent runner does not yet consume this public toggle contract. |
| TS-791 | NOT STARTED | Legal basis is not yet stored per protection or release-validated. |
| TS-792 | NOT STARTED | Safety dashboard/incident feed absent. |
| TS-793 | NOT STARTED | False-positive measurement and review task trigger absent. |
| TS-794 | NOT STARTED | Versioned harm-set harness and release blocking absent. |
| TS-795 | NOT STARTED | Safety incident postmortem workflow absent. |
| TS-796 | NOT STARTED | Plain-language descriptions/readability check absent. |
| TS-797 | NOT STARTED | Research subscription/update-ticket workflow absent. |
| TS-798 | NOT STARTED | Classifier registry, evaluation and rollback integration absent. |
| TS-799 | NOT STARTED | Independent annual review process absent. |
| TS-800 | NOT STARTED | Public safety manifest absent. |

## Separate Plan Hooks settings/count-only reconciliation still required

Existing `src/config.ts` contains hard-coded default prices and credit quantities (including figures from Plan Hooks) and plan storage retains the existing `costUsdMicros` placeholder. They are not changed in this safety slice. Owner clarification: preserve every existing monetary placeholder field; do not delete or set a price. The remaining config work is additive: provide one settings-table/config location for undecided values, leaving them unselected and without invented amounts. The displayed meter may count credits; do not change existing ledger/schema fields absent a later explicit instruction. Never edit shipped migrations.

## Baseline verification caveats

- Baseline `npm test` before edits: 845 passed, 1 failed, 1 skipped. The pre-existing failure is `test/saml-service.test.ts` because `@node-saml/node-saml` is absent from this checkout's `node_modules`.
- Baseline `npm run typecheck`: could not start because `@types/node` is absent.
- No claim of full-suite/typecheck success is made. Re-run both after the dependencies are restored/installed and record any remaining baseline failures separately.

## Owner clarification — preserve existing monetary placeholders (16 Nov 2026)

The owner clarified that `costUsdMicros` and related existing ledger/schema fields are placeholders, not prices. Preserve them exactly as existing code; do not remove, rename, migrate, or delete them. Do not set or invent a price or credit amount. The previous attempted field-removal migration and associated code/test edits were fully reverted before continuing. Any future settings-table/config work must be additive and leave undecided values unpopulated. The statement above proposing removal of monetary values from existing ledger entries is superseded by this clarification; no such removal is authorized.

Verification after that reversion and the additive safety-reader resilience tests: typecheck passes; full suite 859 passed, 0 failed, 1 skipped; the focused safety suite passes 8/8. `npm install --ignore-scripts --no-save --package-lock=false` restored declared packages only in local `node_modules`; tracked package manifests/lockfiles remain untouched.
