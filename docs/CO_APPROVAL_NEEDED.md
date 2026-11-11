# FORGE Core external integration inputs — final handover register

**This is not an engineering approval queue.** Internal FORGE architecture, schemas, migrations, APIs, algorithms, security controls, tests, retry policies, recovery procedures, and provider-neutral adapters are to be designed and implemented in the repository without waiting for owner approval.

Last reviewed: 2026-11-11
Repository: mildredsylvester763-source/forge-repository
Implementation branch: mistral

## Operating rule

1. Complete all application-side implementation that can be built and tested locally or in CI.
2. Use secure, documented engineering defaults for internal design choices. Record the chosen behavior and its rationale in the relevant architecture/feature documentation.
3. Never classify a feature as owner-blocked merely because a design choice, schema, protocol behavior, retry policy, storage abstraction, or algorithm needs to be designed. Designing those is implementation work.
4. Missing credentials, production accounts, customer-issued certificates, production domains, or external account permissions block only live activation against that external system. They do not block provider-neutral code, configuration validation, local fixtures, contract tests, simulations, or integration adapters.
5. Never commit secrets. Supply them only through the deployment platform's secret manager or the relevant customer onboarding configuration.
6. Keep this register for the final external handover. Do not ask the owner to supply these items until the application is ready for deployment or the relevant provider is being connected.

## Engineering defaults — no owner approval required

These are internal implementation choices, not owner approval requests:

- **CO-064:** validate PostgreSQL behavior in CI using an ephemeral PostgreSQL service. A user-managed database is needed only for production.
- **CO-065:** use a transactional outbox with at-least-once delivery, event-ID idempotency, persisted attempts, bounded exponential retry, dead-letter state, and explicit replay. A subscriber failure must never roll back a committed domain transaction.
- **CO-067:** use one global, namespaced event-contract registry. Event versions are immutable; additive compatible changes register a new contract version, while breaking changes require a new major contract version and explicit upcasters where old stored events must be consumed.
- **CO-076:** define an independent object-store anchor interface and a Cloudflare R2 adapter. Use in-memory/local test adapters in CI. A checkpoint stored only beside the event database is not an independent anchor.
- **CO-091:** use deterministic health/readiness probes and distinguish process liveness from dependency readiness.
- **CO-093:** provide an atomic shared-store rate-limiter abstraction with PostgreSQL as the default application store; keep a deterministic in-memory adapter for tests and local development.
- **CO-096:** build backup manifests, integrity checks, encryption hooks, off-site upload, restore verification and retention execution. Production R2 credentials and the real PostgreSQL source are supplied at deployment.
- **CO-017:** enforce tenant scope in application queries and services as the mandatory boundary; add PostgreSQL RLS as defense in depth where the runtime database role and connection-pool strategy can enforce it safely.
- **CO-018:** use a standard envelope-encryption boundary with managed KMS/key-provider integration. Do not implement custom cryptography.
- **CO-029–CO-044:** use deny-by-default authorization, explicit resource/action checks, tenant-aware grants, revocation and audit evidence. The exact per-feature catalogue text remains the acceptance authority when recovered.
- **CO-045–CO-062:** implement the project-intelligence graph as an application-owned, tenant-scoped graph model with provenance and versioned edges; do not couple the feature to AI/TQ graph modules.
- **CO-081–CO-090:** implement context as a permission-aware, source-traceable, size-bounded assembly layer with explicit expiry and deletion propagation; keep it separate from AI retrieval features.
- **CO-100:** use deterministic operation IDs, per-entity versions, tombstones, causal metadata, idempotent replay and explicit conflict records. Prefer preserving both conflicting edits over silently overwriting user data.

These defaults may be refined when the exact original Part 01 text is reconciled. They are not represented as verbatim catalogue requirements.

## External inputs to supply at final handover

### Production database and hosting
- Production PostgreSQL project (the planned Supabase PostgreSQL project or another standard PostgreSQL host).
- FORGE_DATABASE_URL connection string and the applicable TLS/SSL mode.
- Production database role/permissions sufficient for the application's migrations and runtime, without using a superuser for normal application traffic.
- Production hosting account/project, runtime service identity, region, resource limits and deployment permissions (Google Cloud Run is the current deployment direction).

### Independent event-chain anchor and off-site backups (CO-076, CO-096)
- Cloudflare account ID.
- R2 bucket name and account-specific S3-compatible endpoint.
- R2 access key ID and secret with least-privilege read/write permissions for the selected bucket.
- Production PostgreSQL backup source/connection and the deployment's approved backup execution identity.
- Production retention, recovery-point and recovery-time objectives will be set as operational deployment values; the backup engine and restore workflow must already exist and be testable before these values are applied.

### Email and identity providers
- Email delivery provider API key, verified sender address/domain, and any required DNS records for verification and account recovery.
- Google OAuth client ID/secret and approved production callback/origin settings, if Google sign-in is enabled.
- GitHub OAuth app client ID/secret and approved production callback/origin settings, if GitHub sign-in is enabled.
- Apple sign-in service ID, team identifier, key identifier, private key and approved return URLs, if Apple sign-in is enabled.
- For each enterprise customer connecting SAML/OIDC: issuer/entity ID, metadata URL or metadata document, signing certificates, client credentials where applicable, and the customer's approved callback/ACS URLs. These are customer-specific onboarding inputs, not code-development blockers.

### Encryption and security operations
- KMS/key-management account and key reference if application-managed envelope encryption is enabled in the deployment.
- Production secret-manager location and access policy for password pepper, signing keys, encryption data keys, session-token secrets and other generated runtime secrets. FORGE generates these values; the owner supplies the approved secret-storage destination and access permissions.
- Production domain, DNS control and TLS certificate/termination configuration.
- Any external security monitoring or alerting account selected for production operations.

### Mobile push (only when native mobile push is activated)
- Firebase project and Firebase Cloud Messaging service-account credentials, with least-privilege send permissions.

## CI does not require owner-supplied PostgreSQL credentials

The CO verification workflow now provisions a disposable PostgreSQL service inside the GitHub Actions job and uses its temporary test-only credentials. FORGE_TEST_POSTGRES_URL is therefore not a required owner secret for CI. Production database credentials remain a final handover item.

## Secret handling

- Never put a real credential, private key, token, production connection string or secret value in Git, documentation, issue comments, test fixtures, logs or chat-generated source.
- Example/test credentials in CI are disposable and must never be reused in production.
- Store production values in GitHub Actions Secrets for CI deployment tasks and in the production runtime secret manager for the running application.
- Verify that secret values are redacted and that logs never print connection strings or authorization headers.
- External provider activation is marked complete only after a real authenticated integration test has passed. Code presence alone is not evidence of a live provider connection.

## Catalogue and acceptance limitation

The original owner-supplied Part 01 catalogue remains the acceptance authority. The exact original individual wording for many CO IDs is not currently present in the repository documentation or the retrieved audit dossier. Do not fabricate catalogue titles or claim guessed requirements as verbatim. Continue to implement every independently documented CO behavior and reusable Core foundation; record only the precise acceptance gap where the original text is unavailable.

AI and TQ are outside this implementation register and must not be modified during CO work.


## Original Part 01 acceptance inputs still missing (2026-11-07)

These are missing source-material inputs for accurate catalogue reconciliation, not permission gates for unrelated engineering work. Do not invent feature titles or requirements.

- **CO-097:** supply the exact original Part 01 feature title, description and acceptance criteria. Until recovered, it remains MISSING / OWNER-BLOCKED because no safe feature-specific implementation can be attributed to this ID.
- **CO-098:** supply the exact original Part 01 feature title, description and acceptance criteria. Until recovered, it remains MISSING / OWNER-BLOCKED for the same reason.
- **CO-099:** supply the exact original Part 01 feature title, description and acceptance criteria. Until recovered, it remains MISSING / OWNER-BLOCKED for the same reason.
- **CO-100:** the exact original Part 01 wording is still needed for formal acceptance reconciliation, but it does not block the documented baseline. The provider-neutral engine, SQLite/PostgreSQL stores, version-2 migrations, authenticated routes and application composition are now wired on `mistral`. Route-boundary tests and in-memory/SQLite application-composition tests are added. The new repository CI/native PostgreSQL result is not yet verified; no owner design approval or provider credential is required for the remaining verification.

The CO-097–CO-100 branch evidence and current verification boundary are recorded in `docs/PROGRESS.md` under the 2026-11-07 sequential follow-up audit.


## Additional CO-100 decision input (2026-11-09)

- **CO-100 With-Plans gate:** `CO-100` has no entry in `src/modules/plans/engine/feature-gates.ts`, and the new `/v1/sync/*` paths have no entries in `src/modules/plans/engine/route-gates.ts`. The current gate middleware intentionally leaves routes without a catalog entry ungated. Supply the exact With-Plans catalog row and gate before a paid-plan restriction is assigned. Do not infer or invent a tier. Session authentication remains enforced independently.
- **CO status source conflict:** `docs/BUILD_NOTES.md` states CO-001–CO-080 and CO-096 are implemented, while the detailed evidence in `docs/PROGRESS.md` records partial/not-started/owner-blocked states for some of the same ranges. Owner reconciliation is needed to decide which status statement is authoritative. Until then, retain per-feature evidence classifications and do not bulk-promote.

## Partially implemented features — owner items (audit of 11 Nov 2026, updated after batch C1 at mistral head 6029744)

Verified live against FEATURE_GATES and ROUTE_GATES on the mistral lane. Every partially implemented row from the old build notes, with what is still outstanding and who must bring it:

- CO-030 (server-side session check) — registered free, zero gated routes. Needs the C2 audit batch: verify where its code lives (kernel middleware has no ROUTE_GATES entry by design; confirm the check exists and is wired) and record the acceptance evidence.
- CO-063 (official catalog acceptance) — registered internal. Acceptance by the owner against the With-Plans catalog remains unverified; the C2 batch records the in-repo evidence, the acceptance call stays with the owner.
- CO-064 (append-only/hash-chain proof) — registered internal. The native PostgreSQL proof now runs in CI on the disposable PostgreSQL service (no owner secret needed for CI); what remains is the acceptance record in the C3 batch, plus the production database at deployment (already in the handover list above).
- CO-065 (durable subscriber delivery) — registered internal. The transactional outbox is the approved engineering default (see above); the in-repo build is the C3 batch. Only a production queue provider choice at deployment touches the owner.
- CO-076 (independent external anchor) — registered enterprise. The anchor interface and R2 adapter are the C4 build batch (engineering); the deployed external anchor needs the owner's Cloudflare account and R2 credentials (listed above).
- CO-091 (health and readiness) — COMPLETE as of batch C1 (11 Nov 2026, mistral head 6029744): registered internal in FEATURE_GATES, readiness tests run in the CO focused workflow. No owner item remains.
- CO-093 (rate limiting) — COMPLETE as of batch C1 (11 Nov 2026, mistral head 6029744): registered internal, shared-store limiter (atomic upsert, In-memory/SQLite/PostgreSQL adapters, kernel migration v3, PlansService wiring) with native PostgreSQL concurrency proof. Production enforcement still needs the owner to set FORGE_RATE_LIMITS (configuration, not a credential); multi-replica honesty needs every replica pointed at the same PostgreSQL.
- CO-096 (verified backups) — registered free. The off-site upload manifest and R2 backup adapter are the C4 build batch (engineering); the nightly backup to Cloudflare R2 needs the owner to bring R2 credentials and a bucket (already an approved next step, listed above).
