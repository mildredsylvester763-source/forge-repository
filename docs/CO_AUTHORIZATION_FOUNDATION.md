# Shared CO authorization foundation

**Status:** Generic fail-closed decision boundary implemented; no CO-029–CO-044 feature is marked complete by this shared foundation.

## Implemented kernel primitive

`src/kernel/authorization.ts` provides:

- `evaluatePolicyEffects()`: no matching effect produces deny; an explicit deny remains deny; unanimous explicit allows produce allow; conflicting allow/deny or invalid runtime effects produce indeterminate.
- `isAuthorized()`: true only for the explicit `allow / explicit_allow` result.
- `assertAuthorized()`: throws the standard 403 `forbidden` AppError for absent, denied, indeterminate or malformed decisions.

This deliberately does **not** define subject identifiers, role names, permission vocabulary, resource/action matching, tenant membership, ownership, inheritance, delegation, policy storage, audit requirements or conflict precedence. Conflicting effects are indeterminate and therefore non-authorizing; no precedence winner is invented. The primitive is not wired into application routes until the owner approves the policy model.

## Read-only route inventory

The current Mistral route modules contain identity-session guards backed by `IdentityService.authenticate()`:

- Identity `/v1/auth/me` and protected passkey operations.
- Task runtime, orchestrator, test quality, test generation, live testing, web search, workspace retrieval, search integrity, AI training and training data route modules.

This inventory records existing authentication wiring only. The listed AI/TQ module files were inspected read-only and were not modified. Session authentication does not establish resource ownership or tenant/action permissions. The training-data route currently extracts its session from the configured cookie directly rather than the shared cookie/bearer helper; it remains untouched because it is AI scope.

## Verification

- `test/authorization.test.ts` covers no-match deny, explicit deny, explicit allow, unanimous allow, conflicting effects, invalid effects, absent/unresolved decisions and malformed allow-shaped values.
- Local isolated command: `node --experimental-strip-types --test test/authorization.test.ts` — **8 passed, 0 failed**.
- Local isolated type-check: `tsc -p tsconfig.json --noEmit` — passed.
- The test is added to `tsconfig.co.json` and the CO-focused GitHub Actions workflow for repository-level verification after commit.
- No database schema or migration is required for this pure decision boundary.

## Owner decisions still required

Exact Part 01 wording for each CO-029–CO-044 feature; canonical role and permission vocabulary; subject/resource/action scope; tenant membership and ownership semantics; inheritance and delegation; assignment authority; conflict/precedence behavior; and which route families require each policy. Until these are approved, do not wire speculative policies into routes or mark any individual feature complete.
