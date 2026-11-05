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
| CO-063 / CO-064 / CO-076 | Event chain anchoring | Choose independent anchor destination and retention/availability model; provide account/credentials if external storage is selected | A hash chain stored only beside the events cannot detect tail truncation. A trusted external head checkpoint is required to detect removal of the newest suffix | Internal append-only verification and the pure `verifyChainAgainstAnchor()` check are implemented; the external store, latest-checkpoint update consistency and operational retention remain owner/deployment decisions |
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

## Identity-range audit note (2026-11-05)

- CO-006 is partial, not complete: active-session listing/revocation primitives and transactional session-cap enforcement exist, but no user-facing session manager route or accepted device/revocation behavior is documented.
- CO-011 is partial, not complete: the event actor enum includes `agent`, but there is no per-agent credential or identity lifecycle.
- CO-005–CO-014 exact individual catalogue descriptions remain unavailable. Do not infer the unnamed IDs from the section heading. The safe work is to fix existing demonstrable defects and wait for the exact acceptance text or owner-approved semantics before adding security-sensitive flows.


## Workspace and tenancy audit note (2026-11-05)

- CO-015–CO-028 have no dedicated workspace/tenant implementation evidence in either branch. The Mistral `workspace-retrieval` module is an AI retrieval feature and is excluded from CO.
- CO-017 remains owner-blocked on the application-only versus PostgreSQL RLS decision. CO-018 remains owner-blocked on the KMS/key source, rotation and recovery boundary. The exact original feature wording for the other IDs in this range is absent; do not invent membership, invitation, ownership-transfer, deletion or billing semantics.


## Permissions and policy audit note (2026-11-05)

- CO-030 is partial: identity session validation exists for `GET /v1/auth/me`, but this is not proof of resource-level or tenant-level authorization.
- CO-029 and CO-031–CO-044 have no dedicated CO permissions/policy implementation evidence in either branch. The AI web-search domain-policy engine is not CO and is not counted.
- Exact feature-level catalogue wording and the owner's role, permission, delegation and policy-precedence decisions are required before adding authorization rules.


## Project intelligence graph audit note (2026-11-05)

- CO-045–CO-062 have no dedicated CO graph implementation evidence in either branch. The TQ test-generation integration graph is not a project intelligence graph and is excluded.
- Exact Part 01 feature descriptions and owner-approved graph node/edge ontology, source-of-truth, visibility, deletion and retention rules are required before schema or query code is safe to add.


## Event backbone audit note (2026-11-05)

- CO-063's documented event-envelope/canonicalization foundation is implemented and focused-workflow verified; exact catalogue acceptance wording is still unavailable.
- CO-064 and CO-076 remain partial until native PostgreSQL proof and an independent latest-head anchor mechanism are available.
- CO-065's transactional event coupling is evidenced for identity writes only. The owner still needs to decide whether durable subscriber delivery requires a transactional outbox, consumer offsets, retries and dead-letter handling.
- CO-067 currently has an identity event-name/version registry only; do not treat it as a complete global event schema registry.
- The individual names and acceptance criteria for CO-066, CO-068–CO-075 and CO-077–CO-080 are not present in repository docs.


## Context engine audit note (2026-11-05)

- CO-081–CO-090 have no dedicated CO context-engine implementation evidence in either branch. The Mistral workspace-retrieval module is AI-062–AI-072 and is excluded from CO.
- The exact individual catalogue descriptions are required before context source, privacy, visibility, expiry, summarization or retention semantics can be implemented safely. No owner decision is assumed beyond the missing acceptance text.


## Platform reliability audit note (2026-11-05)

- CO-091, CO-093 and CO-096 remain partial with bounded, tested implementations only; deployment dependencies and owner decisions are listed above.
- CO-100 remains owner-blocked until the exact catalogue wording and conflict authority/merge/delete policy are supplied. No offline synchronization behavior was guessed.
- CO-092, CO-094, CO-095 and CO-097–CO-099 have no individual feature descriptions in the repository; exact acceptance text is needed before implementation.
