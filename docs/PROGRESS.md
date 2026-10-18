# Progress, decisions and things to polish

This file is the project's memory. Update it with every change. Nothing the owner has decided should live only in a chat.

## Working rules (from the owner)

1. Before building anything, list the features about to be built and wait for confirmation. For each feature: check it, show the plan, wait for the owner to weigh in.
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
