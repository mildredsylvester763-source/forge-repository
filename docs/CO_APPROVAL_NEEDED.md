# FORGE Core owner-approval and external-dependency register

This register is maintained during continuous CO implementation. A listed dependency blocks only the dependent implementation or production activation; unrelated CO work continues. No decision below is implied by silence.

Last reviewed: 2026-11-05
Repository: mildredsylvester763-source/forge-repository
Working branch: mistral

## Owner implementation direction (2026-11-05)

The owner has confirmed that FORGE's backend logic and integration mechanisms are to be built in-repository now. Provider credentials, customer certificates/metadata, production origins and external account details will be supplied later when the application is ready for deployment or a customer connects an external identity provider.

Therefore, credentials and provider accounts are **activation-time dependencies, not reasons to postpone backend implementation**. Build provider-neutral protocol handling, configuration validation, callback/redirect verification, certificate/metadata parsing, storage contracts, error handling and local tests from the verified feature requirements. Keep secrets out of source control and logs. Do not claim a live provider integration until real credentials/configuration have been supplied and tested. Only genuinely unresolved product/security semantics—not missing secrets alone—may block a feature.

## Decisions / approvals needed

| Ref | CO scope | Required owner input or external dependency | Why it is needed | Safe work that can continue meanwhile |
| --- | --- | --- | --- | --- |
| CO-002 / CO-003 | Passkeys and social sign-in | Supply final production relying-party origins and social-provider client IDs/secrets at deployment/activation; resolve a product choice only if the exact catalogue leaves supported providers ambiguous | The ceremonies, token validation, callback security, adapters and configuration contracts can be built and tested without live accounts; production origins and client secrets cannot be fabricated | Implement provider-neutral WebAuthn/OAuth/OIDC logic, strict validation, configurable origins/redirects and local test fixtures now |
| CO-004 | Enterprise SSO | Customer-specific SAML/OIDC issuer metadata, signing certificates and any tenant-specific provisioning settings are supplied when that customer connects its IdP; resolve provisioning semantics only if the exact catalogue does not define them | Live federation requires customer metadata and trust material, but protocol support, metadata/certificate parsing, signature/issuer/audience validation and provisioning contracts can be implemented and tested before a customer account is connected | Build the SAML/OIDC backend and validation path with local fixtures and environment/configuration seams now |
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

## CO-006 feature delta and sealed carry-forward register (2026-11-05)

**Feature transition:** CO-001 foundation → CO-006 session manager implementation candidate.

**CO-006 owner approval state: NOT GRANTED.** The owner authorized continuous Core implementation, but the exact original CO-006 acceptance text is not present in this repository snapshot. The routes and field projection in `docs/features/CO-006.md` are a provisional engineering contract, not proof of catalogue equivalence or positive owner acceptance. No approval is inferred from silence.

| Ref | Originating feature/range | Current relevance | Approval / external state | Carry-forward rule |
| --- | --- | --- | --- | --- |
| CO-002 / CO-003 | Identity extension | Passkey/social sign-in follow-on | Product provider scope remains acceptance-text-dependent; production origins and OAuth client credentials are not supplied and are activation-time items | Keep attached to their own feature work; do not drop when CO-006 closes |
| CO-004 | Identity extension | Enterprise SSO | Customer issuer metadata, certificates and tenant federation settings are not supplied; protocol implementation may proceed from verified requirements | Carry all trust-material requirements to the first customer SSO activation |
| CO-005–014 | Identity extension | MFA, native tokens, recovery, agent identity and anomaly work | Exact per-feature acceptance text and any unresolved native-token/agent lifecycle semantics remain unverified; email delivery credentials are activation-time | Keep each dependency mapped to its actual CO feature; no cross-feature assumption |
| CO-015–028 / CO-017 | Workspace and tenancy | Required before downstream tenant-scoped sessions/policy | App-side tenant scope is the recorded direction; PostgreSQL RLS as a second lock remains owner decision NOT GRANTED | Carry RLS decision into tenant isolation and downstream authorization; don't block unrelated work |
| CO-018 | Workspace/security | Encryption at rest and backup key custody | KMS/key source, rotation, recovery and backup encryption boundary NOT APPROVED | Preserve until the encryption design is ready |
| CO-029–044 | Permissions and policy | Future authorization of sessions/resources/workspaces | Canonical role vocabulary, delegation and policy precedence NOT APPROVED; exact catalogue text absent | Do not apply invented roles to CO-006; carry unchanged to policy implementation |
| CO-045–050 | Project intelligence graph | First six graph IDs | Node/edge ontology, provenance, visibility, deletion and retention semantics NOT APPROVED; exact IDs' titles unavailable | Carry all ontology decisions forward; no graph schema is inferred from CO-006 |
| CO-063/064/076 | Event backbone | Auditing session actions depends on internal event append; tail truncation protection is separate | Independent anchor destination, retention and credentials NOT SUPPLIED / NOT APPROVED | Session audit events do not close the external anchor requirement |
| CO-065 | Atomic event writes | CO-006 individual revocation now uses the identity UOW | Durable subscriber outbox, offsets, retries and dead-letter behavior remain NOT APPROVED | Transactional source write does not close subscriber-delivery design |
| CO-091 / CO-093 / CO-096 | Platform reliability | Deployment and operations | SLOs, shared rate-limit store/abuse budget, R2 credentials and backup RPO/RTO NOT SUPPLIED / NOT APPROVED | Preserve for the corresponding production reliability features |
| CO-100 | Offline sync | Not needed for CO-006 | Exact catalogue criteria and merge/delete/authority policy NOT APPROVED | Remains explicitly owner-blocked; never infer sync semantics |

**CO-006 external dependency result:** none is required to exercise the local session listing/revocation backend. Production deployment still inherits the existing PostgreSQL, email, key-custody and operational dependency records above; none is considered supplied by this feature.

The register is append-only in meaning: a feature completion may change an item's current relevance or next target, but it must not erase the original requirement, evidence, approval state or external credential requirement. A status may change to APPROVED only after explicit owner approval is captured.

## CO-012 anomaly detector: bounded completion and approvals (2026-11-05)

- **Implemented safely:** passive comparison against currently active session IP/user-agent metadata; value-free signal names only; no account-access action.
- **Approval state for automated response: NOT GRANTED.** Do not add challenge escalation, automatic lockout, automated revocation, alert recipients or security notifications until the exact feature acceptance criteria and response policy are available.
- **Retention/privacy state: NOT GRANTED for any new historical telemetry.** Current implementation uses the existing active-session records and does not add a new historical fingerprint table or extend retention.
- **External dependency:** no new provider credential is needed for the local detector. A notification provider, SIEM or geo-IP data service is not assumed or required by this provisional implementation.
- **Carry-forward:** CO-012 remains PARTIAL until the exact original catalogue wording and owner-approved response/retention behavior are reconciled. CO-006 ownership/session-management work remains its own feature evidence; using its session listing as an anomaly baseline does not move its outstanding acceptance item or alter any unrelated approvals.

## CO-002 and CO-007 implementation decisions and sealed external register delta (2026-11-05)

### CO-002 — passkeys / WebAuthn
- Current status: protocol core partial; no owner acceptance.
- Still required: exact original CO-002 catalogue acceptance wording; production RP ID and exact allowed origins; owner-approved attestation posture, authenticator/algorithm allowlist, resident/discoverable credential policy, backup-state policy and credential lifecycle.
- RP ID and origins are activation-time customer/deployment configuration. Never commit production origins or treat a test domain as approved.
- No live authenticator credentials or third-party provider account are needed to continue local parser/storage/route engineering, but end-to-end activation must remain disabled until a valid RP configuration is supplied.
- Positive approval: NOT GRANTED. Successful focused tests demonstrate only the protocol primitives, not feature acceptance.

### CO-007 — native bearer sessions
- Current status: provisional native bearer path implemented using the existing opaque server-managed session token; exact CO-007 criteria and audience/lifecycle acceptance remain unverified.
- The implementation does not issue JWTs, OAuth access tokens or refresh tokens. No refresh-token lifecycle is silently chosen.
- Positive approval: NOT GRANTED for token audience, refresh-vs-reauthentication policy, device enrollment/attestation and offline grace semantics. A provider secret is not currently needed for the local session contract.
- Client integration dependency: the shipped native client must use HTTPS and platform secure credential storage; validate this at activation. Do not log or place bearer tokens in URLs or analytics.
- CO-009 desktop token behavior remains separate and is not covered by CO-007.

### Carry-forward / feature transition
- CO-002's RP ID, origin, attestation and credential lifecycle requirements remain attached to CO-002; they do not migrate to CO-007.
- CO-007's token audience and native-client session lifecycle requirements remain attached to CO-007; they do not close or approve CO-009.
- CO-006 session manager implementation remains distinct from CO-007 bearer transport. Its exact catalogue acceptance still needs reconciliation.
- Earlier external requirements (CO-004 SSO metadata/certificates; CO-017 RLS decision; CO-018 KMS/key custody; CO-029–044 policy semantics; CO-045–050 graph ontology; CO-063/064/076 independent external anchor; CO-065 durable delivery; CO-093 shared rate-limit store; CO-096 R2 and restore objectives; CO-100 sync conflict policy) remain recorded and unchanged. No credential or owner approval was supplied by these implementations.

## CO-002 passkey lifecycle: verified implementation and sealed activation register (2026-11-05)

**Implementation evidence:** CO-002 backend ceremony, challenge/credential storage adapters, owner-scoped credential lifecycle, audit coupling, passkey-specific IP throttling and browser/native completion routes are present. Focused workflow 42024518400 passed 88/88 tests.

| Dependency / external role | Required input or action | State | Approval evidence | Next action / feature |
| --- | --- | --- | --- | --- |
| Product owner | Exact CO-002 Part 01 acceptance text; supported authenticator and discoverable-credential requirements | NOT SUPPLIED / NOT APPROVED | No explicit acceptance recorded | Reconcile against original CO-002 catalogue before final feature acceptance |
| Domain / DNS / hosting owner | Production RP ID, exact HTTPS origins, and evidence that FORGE deployment controls them | NOT SUPPLIED / ACTIVATION BLOCKED | No domain supplied or approved | Attach to CO-002 production activation; do not substitute test origins |
| Security / identity owner | Attestation posture, algorithm allowlist, backup-eligible credential semantics and authenticator policy | IMPLEMENTATION DEFAULTS DOCUMENTED; OWNER APPROVAL NOT GRANTED | Focused tests are implementation evidence only | Review CO-002 security policy before enabling passkeys in production |
| Database / platform operator | Real PostgreSQL service for migration, unique constraint, challenge-consumption CAS, audit transaction and restore integration tests | NOT CONFIGURED | No PostgreSQL integration secret/service supplied | Attach to CO-002 adapter acceptance and CO-064/065 evidence; retain SQLite tests as narrower proof |
| SRE / platform operator | Shared rate-limit store and multi-replica consistency | NOT APPROVED / NOT CONFIGURED | Current throttle is in-memory | Move to CO-093 shared enforcement; do not claim cross-replica rate limiting |
| Native app team / mobile security reviewer | HTTPS use and platform secure-storage integration for native passkey bearer session | NOT VERIFIED | Backend route returns opaque server-side session token only | Carry to CO-007 client integration; no token-at-rest approval inferred |

**Positive approval: NOT GRANTED.** A passing focused workflow does not approve a production RP domain, domain ownership, attestation policy, algorithm policy, PostgreSQL deployment, distributed throttling or native-client secure storage.

**Feature transition rule:** CO-002 remains the owner of its RP/origin/authenticator dependencies. The native bearer result is cross-referenced by CO-007 only for client transport; CO-007 retains its token audience, refresh/re-authentication, device enrollment and offline lifecycle decisions. No external staff member or approval record is removed when work advances.

## CO-003 social identity and CO-005 MFA — sealed external/owner dependency delta (2026-11-05)

### CO-003
| Owner / external staff | Required input or action | State | Approval evidence | Carry-forward |
| --- | --- | --- | --- | --- |
| Product owner | Exact CO-003 catalogue wording and approved provider list | NOT SUPPLIED / NOT APPROVED | None | Remains with CO-003 |
| External identity-provider administrator | Issuer metadata, client ID/secret, exact callback URI, test tenant and production credentials for each approved provider | NOT SUPPLIED | No provider account or secret connected | Remains with CO-003; activate one provider at a time after validation |
| Identity/security reviewer | OIDC algorithm/JWKS rotation, issuer/audience/nonce claim policy, verified-email handling | NOT APPROVED | Transaction tests are not token-verification approval | Must review before implementing callback token exchange |
| Account/product owner | Existing-account linking, duplicate-email behavior, account creation and unlink policy | NOT APPROVED | No explicit policy captured | Must be resolved before any identity can be linked or an account created from provider claims |
| Platform/KMS owner | Protected, multi-instance callback transaction persistence and PKCE verifier encryption/key rotation | NOT SUPPLIED | Current store is memory-only | Carry to CO-003 production implementation; CO-018 key custody remains relevant |

No account is authenticated by the current CO-003 transaction module. No provider-specific secret is stored or returned. Positive approval remains **NOT GRANTED**.

### CO-005
| Owner / external staff | Required input or action | State | Approval evidence | Carry-forward |
| --- | --- | --- | --- | --- |
| Product/security owner | Exact CO-005 wording; optional vs mandatory vs step-up policy; accepted algorithms, digits, period and drift window | NOT SUPPLIED / NOT APPROVED | RFC vectors prove primitives only | Remains with CO-005 |
| Security / KMS operator | TOTP seed encryption, storage, rotation, restore and access-control design | NOT SUPPLIED | No seed store is implemented | Must be approved before persistence or enrollment |
| Support/security staff | Recovery, backup-code, factor-reset and identity-proofing process | NOT APPROVED | No recovery flow exists | Remains with CO-005/CO-008; assisted resets require explicit authority |
| External mail/SMS provider administrator | Delivery provider and credentials if approved recovery policy requires codes or alerts | NOT SUPPLIED | No delivery integration assumed | Carry only if accepted policy requires transport |

TOTP secrets and provisioning URIs are high-value credentials. Do not log or store them in plaintext. Positive approval remains **NOT GRANTED**.

### Preservation rule
The role/person dependencies above are retained as durable records. Advancing to the next feature may update their next action, but must not delete the requirement, source, state or approval evidence. The current implementation does not discharge any of these external inputs.


## CO-004 protocol and provisioning boundary (2026-11-05)

- **Status: OWNER-BLOCKED / NOT IMPLEMENTED.** No enterprise SSO route, federation service or CO-004 feature specification is present on Mistral; the main branch has no corresponding SSO implementation to port.
- The exact Part 01 CO-004 acceptance wording is not available. The owner must confirm the required protocol/profile (SAML, OIDC, or both) and tenant provisioning/account-linking semantics before a protocol-specific implementation is treated as correct.
- Customer activation inputs remain: issuer/IdP metadata, signing certificates or JWKS trust material, entity ID/client ID and secret where applicable, callback/ACS URLs, tenant mapping, and a test IdP account. Supply these through deployment/customer configuration, never source control.
- Safe independent work resumes once the protocol and provisioning contract are verified. The CO-003 provider-neutral OIDC authorization transaction is not SSO and must not be counted as CO-004.
- No owner approval is inferred; the approval state remains **NOT GRANTED**.


## CO-008–CO-014 individual owner-dependency register (2026-11-05)

| Feature | Required input / approval | Why it is required | Carry-forward state |
| --- | --- | --- | --- |
| CO-008 | Exact recovery/verification acceptance text; token lifetime, replay, account-enumeration and identity-proofing policy; session handling after recovery; mail provider account, sender/domain verification and API credentials | Account recovery can transfer account control. The service must not invent a weaker proofing path or expose account existence. Email delivery credentials are required only for live activation. | NOT SUPPLIED / NOT APPROVED |
| CO-009 | Exact desktop token contract: intended client audience, device registration (if any), token expiry/revocation and secure-storage requirements | CO-007 native bearer transport explicitly does not close the separate desktop-token feature. | NOT SUPPLIED / NOT APPROVED |
| CO-010 | Exact CO-010 Part 01 description and acceptance criteria | No feature title or behavior is evidenced in the repository; guessing would fabricate requirements. | NOT SUPPLIED |
| CO-011 | Exact agent identity requirements; agent principal types, credential issuance and rotation authority, scopes, delegation and revocation rules | Event actor kind `agent` is only audit metadata; it does not authenticate an agent. | NOT SUPPLIED / NOT APPROVED |
| CO-012 | Exact anomaly acceptance criteria; explicit approval for any score threshold, alert recipient, challenge/lockout/revocation action or new historical telemetry retention | Current implementation is observe-only and uses currently active session metadata. | NOT SUPPLIED / NOT APPROVED |
| CO-013 | Exact CO-013 Part 01 description and acceptance criteria | No feature title or behavior is evidenced in the repository; guessing would fabricate requirements. | NOT SUPPLIED |
| CO-014 | Exact CO-014 Part 01 description and acceptance criteria | No feature title or behavior is evidenced in the repository; guessing would fabricate requirements. | NOT SUPPLIED |

The existing mail-provider, KMS/key-custody and external IdP dependencies remain in the register. These entries do not replace or discharge those earlier dependencies.


## CO-015–CO-028 individual audit carry-forward (2026-11-05)

| Feature | Owner input required | Reason / safe continuation |
| --- | --- | --- |
| CO-015 | Exact Part 01 description and acceptance criteria | No dedicated implementation evidence exists; do not invent workspace lifecycle semantics. |
| CO-016 | Exact Part 01 description and acceptance criteria | No dedicated implementation evidence exists; do not invent membership or invitation semantics. |
| CO-017 | Explicit decision on PostgreSQL RLS as a second tenant-isolation boundary, including database roles/connection strategy | Tenant scoping must be designed without accidentally bypassing or weakening isolation. App-side scoping remains the recorded initial direction; RLS is not approved. |
| CO-018 | KMS/owner-managed key source and approval for rotation, recovery, service access and backup encryption | No application key-management/encryption layer exists; secret and backup protection depends on this boundary. |
| CO-019 | Exact Part 01 description and acceptance criteria | No dedicated implementation evidence exists. |
| CO-020 | Exact Part 01 description and acceptance criteria | No dedicated implementation evidence exists. |
| CO-021 | Exact Part 01 description and acceptance criteria | No dedicated implementation evidence exists. |
| CO-022 | Exact Part 01 description and acceptance criteria | No dedicated implementation evidence exists. |
| CO-023 | Exact Part 01 description and acceptance criteria | No dedicated implementation evidence exists. |
| CO-024 | Exact Part 01 description and acceptance criteria | No dedicated implementation evidence exists. |
| CO-025 | Exact Part 01 description and acceptance criteria | No dedicated implementation evidence exists. |
| CO-026 | Exact Part 01 description and acceptance criteria | No dedicated implementation evidence exists. |
| CO-027 | Exact Part 01 description and acceptance criteria | No dedicated implementation evidence exists. |
| CO-028 | Exact Part 01 description and acceptance criteria | No dedicated implementation evidence exists. |

The existing CO-017 and CO-018 owner decisions remain **NOT APPROVED**. Supplying the original catalogue text does not by itself approve the RLS or KMS decisions; those approvals must be explicit and separately recorded.


## CO-029–CO-044 permission and policy owner decisions (2026-11-05)

- Exact feature-level Part 01 acceptance wording is required for every ID in this range; no role names or feature titles are inferred from the section heading.
- Product/security owner must define the canonical roles, permission vocabulary, resource/action scope, role inheritance, delegation, assignment authority, policy precedence, deny/allow conflict handling and administrator override boundaries.
- Tenant ownership and membership rules must be established alongside CO-015–CO-028. Permission checks cannot be implemented safely by guessing tenant semantics.
- CO-030 currently has only identity session authentication evidence (`IdentityService.authenticate()` and `GET /v1/auth/me`). This does not grant resource- or tenant-level access. It remains PARTIAL.
- Approval state: **NOT GRANTED**. Independent work on unrelated Core features may continue; do not add default-admin or permissive fallback roles.


## CO-045–CO-062 project intelligence graph decisions (2026-11-05)

- Exact Part 01 feature text is required for every ID in this range. No feature names, graph entities or edge types are inferred from the section heading.
- Product/data owner must approve the node and edge ontology, stable identity, provenance, source of truth, versioning, duplicate handling and mutation semantics.
- Security/product owner must approve graph visibility, inheritance from project/tenant permissions, deletion, retention and archival rules.
- Query/indexing behavior and scale targets must follow the accepted feature requirements rather than guessed implementation preferences.
- Current audit found no dedicated CO project graph service/schema in either main or mistral at the inspected paths. AI retrieval graphs and TQ integration graphs are not substitutes.
- Approval state: **NOT SUPPLIED / NOT APPROVED**. No graph schema or API should be introduced until the exact acceptance and ontology are available.


## CO-063–CO-080 event-backbone verification and approval register (2026-11-05)

| Feature | Required owner / external input | Why / next safe action |
| --- | --- | --- |
| CO-064 | A real PostgreSQL test service and `FORGE_TEST_POSTGRES_URL` secret, plus test SSL mode | Current test helper uses a SQLite-backed stand-in without the secret. Configure an isolated throwaway PostgreSQL database before claiming native integration or trigger/privilege proof. |
| CO-065 | Decision on durable event subscriber contract: delivery guarantee, outbox ownership, consumer offsets, retry/backoff and dead-letter semantics | Current atomic identity writes are not a durable event-delivery system. Do not guess at-least-once/exactly-once or consumer retention semantics. |
| CO-067 | Exact Part 01 acceptance text and owner decision on whether a global registry, compatibility rules and deprecation/version lifecycle are required | Current registry only enumerates identity event names/version. Do not broaden it by assumption. |
| CO-076 | Independent anchor destination, credential owner, retention/availability policy, write cadence and recovery procedure | Pure verification compares a supplied checkpoint but does not persist it independently. A same-database anchor does not protect against database truncation. |
| CO-063, CO-066, CO-068–CO-075, CO-077–CO-080 | Exact Part 01 feature descriptions and acceptance criteria for each ID | Preserve current evidence for CO-063; do not infer unnamed feature contracts from the event-backbone section heading. |

No external anchor account, database secret or owner approval was supplied in this run. These items remain NOT SUPPLIED / NOT APPROVED; unrelated Core work may continue.


## CO-081–CO-090 context-engine owner decisions (2026-11-05)

- Exact Part 01 acceptance wording is required for every ID in this range; no feature names or context behaviors are inferred.
- Product/data owner must define context source types, provenance, source-of-truth precedence and update/conflict semantics.
- Security/privacy owner must define tenant/project/user visibility, consent, deletion, export and access logging.
- Product owner must define expiry, retention, summarization, versioning and recovery behavior before persistent context data is introduced.
- Current audit found no dedicated CO context engine/service/store in either branch at the inspected paths. AI workspace retrieval and AI memory modules are outside this CO range and are not substitutes.
- Approval state: **NOT SUPPLIED / NOT APPROVED**. Do not create context tables or retention defaults from assumptions.


## CO-091–CO-100 reliability approvals and external dependencies (2026-11-05)

| Feature | Required owner / external input | Why / next action |
| --- | --- | --- |
| CO-091 | Required dependency list and readiness/liveness contract; SLO/latency/error thresholds | Current readiness only checks the event-store/database path. Do not claim full-system readiness without the accepted dependency model. |
| CO-092 | Exact Part 01 description and acceptance criteria | No feature title or implementation contract is evidenced. |
| CO-093 | Owner choice of shared Postgres-backed limiter or Redis; connection/service configuration and approved per-action abuse budgets | Process-local counters are not consistent across multiple application replicas. Do not claim distributed enforcement. |
| CO-094 | Exact Part 01 description and acceptance criteria | No feature title or implementation contract is evidenced. |
| CO-095 | Exact Part 01 description and acceptance criteria | No feature title or implementation contract is evidenced. |
| CO-096 | Cloudflare account ID, R2 bucket, access key ID/secret, PostgreSQL backup source/credentials, retention and owner-approved RPO/RTO | Current verified backup path covers SQLite only; production offsite PostgreSQL backup/restore is absent. |
| CO-097 | Exact Part 01 description and acceptance criteria | No feature title or implementation contract is evidenced. |
| CO-098 | Exact Part 01 description and acceptance criteria | No feature title or implementation contract is evidenced. |
| CO-099 | Exact Part 01 description and acceptance criteria | No feature title or implementation contract is evidenced. |
| CO-100 | Exact Part 01 description; conflict authority, merge/delete rules, offline replay and user-visible resolution policy | Conflict resolution can silently lose or overwrite user work if semantics are guessed. No sync implementation is added until approved. |

All items remain NOT SUPPLIED / NOT APPROVED where applicable. The existing R2, database, limiter and operational dependencies remain preserved in this register.


## CO-002 external validation and activation register (2026-11-06)

These items are deployment/owner validation inputs, not reasons to pause provider-neutral backend work:

| Item | Required input / validation | Why it remains external | Current handling |
| --- | --- | --- | --- |
| WebAuthn RP ID | Final production relying-party hostname | Must be controlled by the deploying organization and align with browser origins | Configurable through `FORGE_WEBAUTHN_RP_ID`; validation is implemented; no production hostname invented |
| Allowed origins | Exact HTTPS origins for production web clients | Origin trust must match the real deployed frontend domains | Configurable through `FORGE_WEBAUTHN_ORIGINS`; exact origin and RP relationship validation implemented |
| RP display name | Owner-approved product display name | User-facing authenticator prompt branding | Configurable through `FORGE_WEBAUTHN_RP_NAME`; safe development default only |
| Attestation/authenticator policy | Owner/security approval of `none` attestation and accepted algorithms/authenticator posture | Product/security risk acceptance, not a missing coding primitive | Current code implements `none` attestation and ES256, Ed25519 and RS256; approval remains not granted |
| Backup-eligible credential policy | Owner/security approval of discoverable credentials and synced passkeys | This determines acceptable authenticator/account recovery posture | Code validates backup flags and immutable backup eligibility; approval remains not granted |
| PostgreSQL verification | Real PostgreSQL integration service/credentials and migration/restore run | Cannot claim native PostgreSQL validation from SQLite-backed tests | Adapter and migrations exist; focused CI currently verifies SQLite/in-memory path |
| Distributed rate limits | Approved shared Postgres or Redis store and connection/configuration | Process-local limiter cannot coordinate across replicas | Dedicated passkey bucket exists; shared-store work remains outstanding |
| Native app validation | Native client secure credential storage and HTTPS integration test | Requires real native client integration | Server bearer-session path exists; no native client has been validated |

The user has stated that provider credentials and deployment values will be supplied after the backend/application is built. Do not block independent CO implementation waiting for them. Do not fabricate secrets, origins, accounts, owner approvals or production test results.


## CO-003 provider-neutral OIDC external validation register (2026-11-06)

| Item | Required input / owner validation | Why | Safe work already completed / next step |
| --- | --- | --- | --- |
| Provider selection | Owner-approved provider shortlist and provider administrator accounts | Do not assume Google, Apple, GitHub or another provider is the intended product choice | Provider-neutral authorization, discovery, token exchange and verification engine is built and testable without selecting a vendor |
| Per-provider client credentials | Client ID and client secret where the provider requires a confidential client; stored in server-side deployment secrets | Required for real provider token exchange; never put secrets in frontend code or repository | Runtime accepts optional server-side client secret; test credentials are synthetic fixtures only |
| Provider endpoints | Issuer, authorization endpoint, token endpoint, JWKS URI and exact redirect/callback URI for each environment | Must match the provider's official metadata and registered application settings | OIDC discovery validator checks exact issuer, HTTPS endpoints, code flow, public subject support, supported signing algorithms and token endpoint auth methods |
| Account linking | Explicit policy for linking a provider issuer+subject to an existing FORGE account; confirm whether auto-link by verified email is allowed | Email claims are not a stable cross-provider identity key; automatic linking can permit account takeover if policy is guessed | Current verifier returns provider-scoped subject and does not auto-link by email or create accounts |
| Account creation | Owner decision whether first-time social sign-in may create a new FORGE account and which profile fields are accepted | User lifecycle, consent and duplicate-account behavior are product semantics | No automatic account creation is implemented |
| Email trust | Owner/security approval of verified-email handling and whether providers lacking `email_verified` may sign in | Identity proof and email ownership are distinct | Result explicitly marks email verified only when the signed claim is boolean true |
| Callback/session policy | Approved callback behavior, error UX, session lifetime and session event semantics | Must integrate with existing identity session/audit model without bypassing it | Token callback engine returns a verified identity only; route and FORGE session issuance remain to be implemented |
| Transaction persistence | Owner-approved encryption/key-custody source for the PKCE verifier plus durable Postgres/SQLite transaction-store deployment | Verifier is currently held in process memory; storing it plaintext would expose live OAuth transactions | State/nonce hashes are persisted only in the in-memory store today; durable encrypted implementation remains next independent backend work |
| Key rotation/incident response | Credential rotation owner and incident-response procedure | Provider secrets and signing keys rotate independently | No provider credentials are stored in source; JWKS is retrieved per callback and token verification pins to provider key ID/algorithm |

These are activation or owner-policy dependencies, not reasons to stop provider-neutral implementation. Do not fabricate provider credentials or silently choose account-linking semantics.


## CO-004 Enterprise SSO customer inputs and owner approvals (2026-11-06)

| Item | Required external input / approval | Why it is needed | Current implementation state |
| --- | --- | --- | --- |
| Customer IdP identity | IdP entity ID / issuer and customer-specific SSO endpoint | Each customer controls its own identity provider and endpoint | Provider-neutral SAML service accepts exact issuer and entry-point values; no tenant values invented |
| IdP signing trust | Customer IdP signing certificate(s), plus rollover certificates when the IdP rotates | SAML assertions must be verified against the customer's trusted signing keys | SAML engine requires IdP certificate material and verifies signed Response and Assertion |
| FORGE SP registration | Owner-approved SP entity ID, production ACS/callback URL, exact domain and HTTPS/DNS ownership | The customer's IdP must register the real FORGE service-provider endpoint | SP metadata generation and callback configuration are implemented; production domain remains unset |
| SP request signing | Customer requirement for signed AuthnRequests; if required, matching SP private key/public certificate generated and stored through approved key custody | Some IdPs require signed AuthnRequests; private signing material must never be invented or committed | SHA-256 request signing supported and requires both key and certificate |
| Assertion policy | Owner/security approval of accepted signature algorithms, assertion-age window, clock skew, NameID format and attribute set | These are security and interoperability policy choices | Strict signed response/assertion, InResponseTo and replay defaults are implemented provisionally |
| Identity/tenant mapping | Attribute mapping, tenant resolution, group/role mapping, provisioning/deprovisioning, account linking and SSO-only policy | Mapping an IdP subject to a FORGE user/tenant changes account access and authorization | Not implemented; do not auto-create users or grant roles from unapproved attributes |
| PostgreSQL activation | Real PostgreSQL integration service and credentials for migration/cache concurrency testing | Current focused tests exercise SQLite, not native PostgreSQL | PostgreSQL migration and cache adapter are implemented but not live-validated |
| Additional SAML protocols | Owner decision whether Single Logout, encrypted assertions, metadata auto-import and certificate rotation orchestration are in CO-004 scope | These expand protocol and key lifecycle behavior; exact Part 01 criteria are unavailable | Not claimed as implemented |

These are customer activation and owner-policy dependencies. They do not block provider-neutral SAML backend implementation or other independent CO features.


## CO-005 TOTP persistence and MFA policy update (2026-11-06)

| Item | Owner input / validation required | Why | Current implementation |
| --- | --- | --- | --- |
| MFA enforcement policy | Decide optional, mandatory, tenant-enforced, privileged-user-only or step-up-only | Login and session flows cannot safely assume every account must enroll | TOTP enrollment and verification service exists but no login route or global enforcement is enabled |
| TOTP parameters | Approve algorithm, digit count, period, accepted clock-drift window and enrollment confirmation policy | These affect security, compatibility and recovery | All parameters are explicit constructor inputs; no product-wide defaults are silently enabled |
| Encryption key custody | Approved 32-byte key source (KMS or owner-managed secret), access policy, rotation and backup/recovery procedure | The AES-GCM key must remain outside the database and source repository | AES-256-GCM encryption is implemented with user-bound AAD; key is injected at service construction and not wired to production config |
| Recovery and backup codes | Count/format, hashing, one-time consumption, lost-device flow and assisted reset authority | Recovery can bypass MFA and needs explicit security ownership | No recovery codes or support reset path is implemented |
| Notifications | Email/SMS provider and credentials only if the accepted recovery/notification design requires them | Provider accounts are deployment inputs, not backend logic | No provider credentials or delivery service assumed |
| PostgreSQL verification | Real PostgreSQL integration service, credentials and concurrency test | SQLite tests do not prove Postgres transaction semantics | Postgres store and migration are implemented but not live-tested |

These decisions do not block independent CO backend work. The user has stated that provider credentials and production deployment values will be supplied after the application/backend is built.
