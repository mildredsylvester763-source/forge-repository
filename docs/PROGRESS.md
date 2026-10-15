# Progress, decisions and things to polish

This file is the project's memory. Update it with every change. Nothing the owner has decided should live only in a chat.

## Working rules (from the owner)

1. Before building anything, list the features about to be built and wait for confirmation.
2. Every correction and decision is recorded, even if it makes the notes long.
3. If a shared file conflicts with something the owner already changed in chat, the chat decision wins. Flag the conflict.
4. Backend logic belongs to us. Rent only the pipes that cannot reasonably be built: DNS and attack protection, delivery of phone push messages, email delivery, GPUs.
5. Flag features that are risky, wrong or unrealistic as we reach them.

## Done

| ID | Feature | Notes |
| --- | --- | --- |
| CO-001 | Email and password sign-in with breached-password checks | Register, sign in, sign out, session check. 94 tests. |

## Partly built (so CO-001 could work)

CO-063, 064, 065, 076 (event envelope, hash-chained audit log, atomic write plus event, tamper check), CO-091 (health and readiness), CO-093 (rate limiting), CO-096 (verified backups, SQLite only), CO-030 (server-side session check). Finish each properly when its section is reached.

## Approved next steps

1. PostgreSQL adapter for accounts, sessions and the audit log. Cannot be tested on the build machine; verified by running the whole suite against a real Postgres in GitHub's automatic checks.
2. SQLite layer pushed with tests as the local-testing backend. **Done.**
3. Nightly backup to Cloudflare R2.
4. Chat endpoint and conversation tables (the first agent).

## Decisions made

- **Language:** TypeScript (strict) on Node 22, no runtime dependencies so far. The PostgreSQL driver will be the first one. (ADR 0001)
- **Production database:** PostgreSQL through Supabase, used as plain Postgres. Not Supabase's login system, because we built our own. SQLite is only for development and tests.
- **Files:** Cloudflare R2. Model weights and datasets live there, never in the database.
- **Agents:** run on Google Cloud Run.
- **Job queue:** proposed to build on a Postgres table instead of Cloud Tasks or Pub/Sub, to depend on fewer vendors. Not yet confirmed.
- **Front end:** proposed web app that installs on a phone (PWA). Real phone apps can follow later with no backend change.
- **Notifications:** build the engine ourselves. First in-app notifications and browser push. Add Firebase Cloud Messaging only when a phone app exists.
- **Feed:** same Postgres at first, in its own tables. Split into a separate database only when traffic proves it is needed. Uploads should have no limits or very generous ones, to be planned when the feed is built.
- **AI memory:** limited, not unlimited long-term storage. Expiry, compression into summaries, and the user can see and delete what is remembered.
- **AI learning:** it learns in an isolated sandbox and only verified material is absorbed. Sources: real users' manhua artwork (strokes and edits), uploaded pictures, uploaded manhua. Fine-tuning on GPUs, starting from an existing model. Consent, memorization checks and rollback are required.
- **Free video allowance:** a pool of seconds per month that resets monthly, kept as a setting, started very low and lowered further at the owner's request. Outside video AI costs roughly $0.03 to $0.70 per second, so the real numbers come once a provider is chosen and a hard spending cap exists.

## Polish later (do not forget)

- Usage and pricing algorithms: the owner will provide them. Polish when reached.
- Exact free video numbers.
- Email verification, password reset and recovery (CO-008). Registration currently reveals duplicate emails.
- Encryption at rest for the database and backups (CO-018).
- Off-site backups.
- Anchor the audit chain's latest hash outside the database so deleting the newest events cannot go unnoticed.
- Spending alerts and hard limits on every cloud account.
- Content moderation for user videos, and a clear "not a real lawyer" notice on the lawyer agent.

## Risky or unrealistic features flagged so far

- AI-013 training a model from scratch: extremely expensive. Use an existing model.
- CO-100 offline sync with conflict resolution: one of the hardest features to get right.
- TQ-020 real device farm: needs physical phones.
- Learning from users' artwork and writing: needs opt-in consent, withdrawal, and memorization tests.

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
