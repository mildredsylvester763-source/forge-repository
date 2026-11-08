# FORGE Core external integration inputs — final handover register

**This is not an engineering approval queue.** Internal FORGE architecture, schemas, migrations, APIs, algorithms, security controls, tests, retry policies, recovery procedures, and provider-neutral adapters are to be designed and implemented in the repository without waiting for owner approval.

Last reviewed: 2026-11-07
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
- **CO-100:** the exact original Part 01 wording is still needed for formal acceptance reconciliation, but it does not block the documented baseline. The provider-neutral engine, SQLite/PostgreSQL stores and version-2 migrations are now partially implemented on `mistral`; application composition/HTTP authentication wiring and native PostgreSQL CI verification remain. No owner design approval or external credential is required for that remaining backend work.

The CO-097–CO-100 branch evidence and current verification boundary are recorded in `docs/PROGRESS.md` under the 2026-11-07 sequential follow-up audit.
