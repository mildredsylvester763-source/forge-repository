# FORGE Core owner-approval and external-dependency register

This register is maintained during continuous CO implementation. A listed dependency blocks only the dependent implementation or production activation; unrelated CO work continues. No decision below is implied by silence.

Last reviewed: 2026-11-05
Repository: mildredsylvester763-source/forge-repository
Working branch: mistral

## Decisions / approvals needed

| Ref | CO scope | Required owner input or external dependency | Why it is needed | Safe work that can continue meanwhile |
| --- | --- | --- | --- | --- |
| CO-002 / CO-003 | Passkeys and social sign-in | Confirm supported authenticators/providers and production relying-party origins; provide provider client IDs/secrets for social providers | WebAuthn relying-party configuration and OAuth redirect/client registration are deployment-specific; secrets must not be guessed or committed | Provider-neutral contracts, validation, local test doubles, origin/config checks |
| CO-004 | Enterprise SSO | Customer-specific SAML/OIDC issuer, metadata, certificates and provisioning expectations | SSO cannot be correctly connected without each customer's identity-provider configuration and tenancy semantics | Protocol-neutral interfaces and strict metadata validation |
| CO-005–014 | Identity and credentials | Exact original catalogue acceptance criteria for CO-002–014; recovery/verification email delivery provider credentials; approved native-agent/token audience and lifecycle semantics where applicable | Repository contains only CO-001 feature spec; section-level checklist is insufficient to infer every feature contract | Audit existing identity code, fix demonstrable defects, add tests for explicit documented behavior |
| CO-017 | Tenant isolation | Decide whether PostgreSQL RLS is mandatory as a second isolation boundary in addition to application-enforced tenant scoping | docs/PROGRESS.md explicitly leaves app-only vs DB RLS open; schema/policy design and connection role strategy depend on this | Build tenant-aware application interfaces and tests without asserting a final RLS policy |
| CO-018 | Encryption at rest | Confirm key-management boundary and deployment key source (KMS or owner-managed key) | Encryption design must define key rotation, backup encryption, recovery and access boundaries | Use platform-managed encryption only where already guaranteed; document threat model and avoid custom cryptography |
| CO-015–028 | Workspace and tenancy | Exact catalogue wording and approved membership/invitation/ownership/tenant lifecycle semantics where not explicitly captured in repo docs | Section heading alone does not define transfer, deletion, billing ownership, membership and isolation edge cases | Build independently specified data validation and tenant-scoping primitives once semantics are explicit |
| CO-029–044 | Permissions and policy | Exact catalogue wording and owner-approved role/permission model, delegation rules and policy precedence | Authorization semantics are product/security decisions; inventing roles or inheritance could grant unintended access | Implement deny-by-default primitives, policy evaluation tests and route inventory where behavior is unambiguous |
| CO-045–062 | Project intelligence graph | Exact catalogue wording plus approved graph node/edge types, source-of-truth rules, deletion/retention and visibility semantics | The graph's ontology and consistency model are core product decisions; a guessed schema would cause expensive migration churn | Research graph storage/query options and implement generic validation only after confirmed contracts |
| CO-063 / CO-064 / CO-076 | Event chain anchoring | Choose independent anchor destination and retention/availability model; provide account/credentials if external storage is selected | A hash chain stored only beside the events cannot detect tail truncation. A trusted external head checkpoint is required to detect removal of the newest suffix | Verify internal chain, enforce append-only behavior, test gaps/tampering and expose anchor interface |
| CO-065 | Atomic event writes | Confirm which CO mutations require transactional outbox coupling and whether subscriber delivery needs durable retries, per-consumer offsets and dead-letter handling | SQLite/PostgreSQL appendIn() support same-transaction writes; implemented identity mutations use it. EventDispatcher is only best-effort in-process notification (no durable queue/retry), and domain-wide coverage is not established | Continue auditing CO-owned write paths with clear transaction boundaries; keep durable delivery architecture owner-dependent |
| CO-091 | Production readiness | Supply actual deployment health dependencies and operational SLO thresholds | A readiness probe should reflect required dependencies; thresholds are deployment/product decisions | Improve deterministic dependency probes and test degraded states |
| CO-093 | Distributed rate limiting | Confirm acceptable shared store (Postgres-backed limiter vs managed Redis) and abuse-budget policy | Current limiter is in-memory and does not coordinate replicas; shared atomic limits require a storage/deployment choice | Validate configuration, define limiter interface, add deterministic local tests and protect against unsafe eviction |
| CO-096 | Off-site backup / PostgreSQL restore | Cloudflare account, R2 bucket and least-privilege credentials; PostgreSQL backup retention/RPO/RTO policy | Off-site backups and restore guarantees require destination credentials and explicit recovery objectives | Keep SQLite verification robust, add backup manifests/restore drill logic that can be tested locally |
| CO-100 | Offline sync conflict resolution | Exact catalogue requirements and owner-approved conflict policy for concurrent edits/deletes and authority precedence | Conflict resolution can destroy user work if merge semantics are guessed; project notes flag this as high risk | Research strategies and create invariant/property tests once operation model is supplied |

## External credentials / accounts tracked

- Supabase/PostgreSQL project and connection string (FORGE_DATABASE_URL) for real database integration proof.
- A disposable PostgreSQL integration-test connection string (FORGE_TEST_POSTGRES_URL). The current CO-focused workflow ran with this secret unset, so PostgreSQL adapter tests used the SQLite-backed fallback and did not prove native PostgreSQL row-lock/transaction behavior.
- Cloudflare account ID, R2 bucket, access key ID and secret for off-site backup storage.
- Email delivery provider API key and verified sender/domain for verification and recovery flows.
- Google OAuth client ID/secret if Google sign-in is selected.
- GitHub OAuth app client ID/secret if GitHub sign-in is selected.
- Apple sign-in identifiers, private key and team details if Apple sign-in is selected.
- Customer-specific enterprise SSO metadata, certificates and issuer details.
- KMS/key-management account/configuration if application-managed encryption is required.

Secrets must be supplied through deployment secret configuration, never committed to source control or copied into logs.

## Catalogue source limitation

The repository currently contains docs/features/CO-001.md but no individual feature specifications for CO-002–CO-100. docs/PROGRESS.md contains section ranges and selected notes only. The original Part 01 catalogue remains the acceptance authority when its exact text is available. Until then, feature-level requirements not explicitly written in repository docs are marked acceptance-criteria-unverified rather than invented.