# FORGE Part 02 and Plan Hooks — implementation audit ledger

**Scope:** only `Forge Feature — Plan Hooks (build notes)` and `Forge Feature — Catalog Part 02 With Plans`. The PDF requirements remain authoritative; this ledger records repository evidence and verified gaps, not inferred completion.

**Working branch:** `forge-part02-audit`  
**Baseline checkpoint before this run:** `7eaf02362bd15cc05f215c0264a23c2688d990e7`  
**Audit date:** 2026-11-20

## Plan Hooks — prerequisite gate

| Hook | Requirement summary | Status at this checkpoint | Evidence / remaining gap |
|---|---|---|---|
| 1 | Subscription items list; one live base plan; any number of passes; provider-controlled status | PARTIAL | `subscription_items`, pure subscription engine, SQLite/PostgreSQL adapters exist. This run makes payment application transactional and serializes per-user PostgreSQL mutations; admin comp still writes the legacy plan record. Need database invariant and a unified migration off legacy direct plan writes. |
| 2 | One `canUse(user, featureId)` access decision | PARTIAL | `PlansService.canUse`, access engine and route gate middleware are wired. Legacy plan/pass columns remain a fallback path and must be retired only after migration evidence. |
| 2b | Unpaid engines remain open at free limits; paid pass raises only named engine limits | PARTIAL | Engine rows return free/paid levels and credit ledger has engine tags. Need enforcement of the free 40-per-5-hour and 600-monthly caps at spend time; free limits are currently decision metadata, not a complete consumption meter. |
| 3 | Append-only engine-tagged ledger; deterministic allocation order; rebuildable balances | PARTIAL | Ledger rows are append-only and balances are derived. This run moves grant/spend calculation and writes into a per-user storage transaction; expiry-linked spend allocations are fixed. Need explicit free-window/monthly cap accounting and stronger idempotency for job IDs. |
| 4 | Configured product catalog with product code, type, engines, credits/caps, regional minor-unit prices, billing period and sellable switch; ALG margin guard and pass-vs-bundle cap | BLOCKED / PARTIAL | Config supports a basic catalog and it defaults empty. Regional price/cost-floor and per-window-cap fields are absent. The two governing PDFs reference ALG-43/52/56 but do not provide their formulas or input tables; do not invent them. Product-code-to-engine mapping and multi-engine credit allocation need a precise schema. |
| 5 | Master and per-feature switches | IMPLEMENTED WITH CAVEAT | Strict `FORGE_GATES_ENABLED` and per-feature switches exist; production cannot disable the master gate. |
| 6 | Verify signed payment events and process each event ID once | PARTIAL — RACE FIX COMMITTED IN THIS CHECKPOINT | HMAC verification precedes service processing. This run introduces atomic event claiming plus subscription and payment-credit writes in one transaction for SQLite/PostgreSQL, and adds concurrent duplicate/replacement tests. Hash-chained event emission remains outside that database transaction; add a durable outbox before claiming fully atomic audit. |
| 7 | Store money as integer minor units plus currency | PARTIAL | Webhook amounts are integer minor units and currency-coded; credit cost is integer micro-dollars. Display price configuration still uses decimal USD numbers and is not a complete checkout price book. |
| 8 | Country table with currency, region, checked tax rule, payment methods, enabled flag and minimum payout | PARTIAL | Config-driven validated country registry and routes exist; catalog remains empty until owner supplies verified rows. |
| 9 | Signed short-lived access snapshot; server remains authoritative | IMPLEMENTED WITH CAVEAT | HMAC-signed snapshot, TTL and live server-state verification exist. Client-side offline cache/refresh lifecycle is not in this backend. |
| 10 | Append-only who/when/what/why audit for plan, credit, refund, override and admin actions | PARTIAL — ADMIN CONTEXT IMPROVED | Hash-chained event store exists. This run adds admin actor/target/action/reason events, plus promotion-redemption and account-deletion-request events. Events are still appended after billing writes; refunds and atomic outbox are not implemented. |
| 11 | Admin grant, comp, pause and ledger view | PARTIAL | Endpoints and allowlist exist. Actor/reason now recorded for admin actions. Paused-account state remains process memory and does not survive restart; no durable admin-state store yet. |
| 12 | One durable model for coupons, trials and referrals, with limits and expiry, adding credits or time | PARTIAL | Pure validation/redemption engine and routes exist. Definitions and redemptions remain in memory; concurrent redemption limits are not atomic; day-based benefits remain unsupported pending subscription lifecycle semantics. |
| 13 | Server UTC clock for windows and expiry | IMPLEMENTED WITH CAVEAT | Services use injected server clock; migrations use server timestamps. Need production clock/UTC operational verification. |
| 14 | Gateway rate limits per user and per device before AI work | PARTIAL | Per-user fixed-window gate is wired. Device rule exists but no trusted device identifier reaches the gateway; configured device cap is therefore not operationally enforced. |
| 15 | Fake payment/test mode and fake clock for renewal, failure, upgrade and refund scenarios | PARTIAL | Fake clock and signed test webhook paths exist. No complete provider test-mode state machine for renewals, failures and refunds is evidenced. |
| 16 | User data export and deletion with jurisdiction-specific retention | PARTIAL / OWNER APPROVAL REQUIRED | Export and confirmed deletion-request routes exist. Export currently covers plan/pass/subscription/credit data rather than the full account dataset; pause/queue are in memory; hard purge is intentionally disabled pending verified NDPR and other jurisdiction retention rules. |

### Work committed in this checkpoint

- Atomic payment-event claim + subscription replacement + payment credit grants in SQLite and PostgreSQL billing stores.
- Atomic per-user credit grant/spend calculation and append operations.
- Subscription-period expiry applied to plan/pass credit grants.
- Append-only admin action events carrying authenticated admin actor, target, action and required reason.
- Promotion redemption and account deletion request events.
- Regression tests for concurrent duplicate webhook delivery, concurrent base-plan replacements, and concurrent overspend prevention.
- Admin promotion definition now requires a reason.

**Verification pending:** GitHub Actions must pass before these changes are marked verified. Native PostgreSQL execution remains unverified unless CI is configured with `FORGE_TEST_POSTGRES_URL`.

## Part 02 feature catalogue

- Source PDF declares 459 distinct feature IDs across DP, OB, CG, RV, BD and SC; one additional CG-061 occurrence is a cross-reference, not a new feature.
- Seven SC rows marked **Not tiered here** remain outside ordinary subscription gating: `SC-020`, `SC-021`, `SC-022`, `SC-023`, `SC-041`, `SC-062`, `SC-063`.
- Existing Part 02 gate metadata contains 452 tiered rows and excludes those seven. Central registry wiring is present.
- **No Part 02 feature implementation batch has started.** The prerequisite Plan Hooks audit remains incomplete; therefore no four-feature batch is claimed.
- First Part 02 batch will be the first four IDs in document order, after all Plan Hooks blockers are resolved and verified.
