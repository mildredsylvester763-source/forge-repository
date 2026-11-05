# Build & CI external dependencies and owner approvals register

Last reviewed: 2026-11-05
Repository: `mildredsylvester763-source/forge-repository`
Working branch: `gpt-part2-build-ci`

## Register rules

1. This is the durable register for outside staff, external accounts, credentials, owner decisions and approvals required by the approved Build & CI batch: BD-001, BD-016, BD-017, BD-029 and BD-030.
2. A dependency remains attached to the feature whose acceptance requires it. It is not marked complete merely because an interface, mock, test double or placeholder exists.
3. Do not delete a pending item when a feature is completed. Preserve its original feature ID, source, decision/evidence and status in this register.
4. Transfer an item to another feature only when the source feature's implementation/acceptance boundary is actually completed and the receiving feature's catalogue requirement is verified. Record a dated transfer entry with source ID, destination ID, reason and unchanged approval evidence. Never silently relabel or move an item.
5. No external credentials, secrets, provider access tokens or personal data belong in this document or in the repository. Record only the responsible role, required action, secret destination and state.
6. Statuses are explicit: `NOT REQUESTED`, `AWAITING OWNER`, `AWAITING EXTERNAL STAFF`, `APPROVED`, `REJECTED`, `IMPLEMENTED`, `VERIFIED`. An implementation does not imply approval; approval does not imply implementation or verification.
7. Positive owner approval is required before changing a material product, security, identity, permission or cross-module contract. Continue all work that does not depend on that approval.

## BD-001 — declarative pipeline templates

| Ref | Responsible party | Required decision/action | State | Evidence / destination | Transfer rule |
|---|---|---|---|---|---|
| BD001-A | Product owner | Decide whether a global/community template catalogue is in scope; define publisher eligibility, moderation, visibility and abuse handling | AWAITING OWNER | No approval recorded. Keep global catalogue disabled. | Remains BD-001 until this capability is explicitly accepted or rejected. |
| BD001-B | Product owner + Mistral Task Runtime maintainer | Approve the runtime task-registry adapter contract: registered task identity, version/capability compatibility, workspace scope, execution principal and failure contract | AWAITING OWNER | Mistral runtime is a separate owner area. No free-text-goal adapter and no duplicate runtime. | If execution integration is later assigned a distinct catalogue ID, transfer only after BD-001 is accepted and record both IDs. |
| BD001-C | Product owner | Choose template-upgrade conflict policy: strict replace with warning, user/AI-supplied merged candidate, or three-way merge against pinned base/local edits/new release | AWAITING OWNER | No automatic overwrite or merge. | Remains BD-001. |

## BD-016 — triggers and delivery

| Ref | Responsible party | Required decision/action | State | Evidence / destination | Transfer rule |
|---|---|---|---|---|---|
| BD016-A | Product/security owner | Decide whether delivery actors may be workspace members or must be first-class non-human service principals; specify creation, rotation, suspension, revocation and audit lifecycle | AWAITING OWNER | Current code requires an explicitly selected active member with trigger permission. No service-principal lifecycle is invented. | Keep on BD-016 until accepted; transfer only if catalogue assigns lifecycle to a separate feature. |
| BD016-B | Platform/security owner | Select concrete vault/KMS and approve secret provisioning, rotation, revocation, retirement, access logging and recovery procedure | AWAITING EXTERNAL STAFF | Build & CI stores workspace-scoped opaque references only. Secret adapter is injected; no raw secret is stored here. | Secret-management capability stays with its owning security/integration feature; record a formal transfer only after BD-016 is accepted. |
| BD016-C | GitHub organization/repository administrator | Supply approved GitHub App or fine-grained integration setup and minimum permissions for changed-file retrieval/webhook delivery | AWAITING EXTERNAL STAFF | No credentials recorded. Credentials belong in the approved secret manager and integration configuration, not source code. | Keep external setup attached to BD-016; provider file retrieval is also consumed by BD-017. |
| BD016-D | GitLab group/project administrator | Supply approved GitLab webhook/API setup and minimum read scopes for changed-file retrieval | AWAITING EXTERNAL STAFF | No credentials recorded. Credentials belong in the approved secret manager and integration configuration, not source code. | Keep external setup attached to BD-016; provider file retrieval is also consumed by BD-017. |
| BD016-E | Product/security owner | Approve transactional event/outbox publication and downstream event-bus ownership/contract | AWAITING OWNER | No external bus or fake publication is wired. Current webhook processing creates authorized, idempotent queued run records only. | Keep on BD-016 until event publication is part of accepted scope or explicitly assigned elsewhere. |
| BD016-F | Product/security owner | Decide dead-letter replay authority: owner/admin only, or owner/admin/maintainer | AWAITING OWNER | Current implementation allows owner/admin/maintainer; read access is workspace scoped. This remains a provisional policy, not owner-approved. | Remains BD-016. |
| BD016-G | Operations/security staff | Define delivery SLOs, alert routing, retention, on-call owner and incident response for failed/replayed provider deliveries | AWAITING OWNER | No fake alert integration or operational owner is claimed. | Transfer only if a distinct observability/operations feature is verified in the catalogue. |

## BD-017 — conditional and path-based pipelines

| Ref | Responsible party | Required decision/action | State | Evidence / destination | Transfer rule |
|---|---|---|---|---|---|
| BD017-A | GitHub organization/repository administrator | Approve least-privilege provider API permission and integration configuration for pull-request changed-file retrieval | AWAITING EXTERNAL STAFF | Provider adapter is behind a trusted transport port; no token is embedded in Build & CI. | Provider credentials/config remain attached to BD-016 integration; BD-017 records its dependency until validated. |
| BD017-B | GitLab group/project administrator | Approve least-privilege API scope and integration configuration for merge-request changed-file retrieval | AWAITING EXTERNAL STAFF | Adapter explicitly handles pagination, caps and incomplete results; no token is embedded in Build & CI. | Same as BD017-A. |
| BD017-C | Product/security owner | Approve supported glob semantics and compatibility matrix before broadening beyond the currently tested bounded syntax | AWAITING OWNER | Do not silently copy all GitHub/GitLab expression semantics or add arbitrary evaluation. | Remains BD-017. |

## BD-029 — dry-run and scenario simulation

| Ref | Responsible party | Required decision/action | State | Evidence / destination | Transfer rule |
|---|---|---|---|---|---|
| BD029-A | Product owner | Confirm the user-facing dry-run report fields and degraded-state language against the accepted catalogue text | AWAITING OWNER | Current response is value-free and side-effect-free; no secret resolution or task execution occurs. | Remains BD-029. |

## BD-030 — immutable versioning and rollback

| Ref | Responsible party | Required decision/action | State | Evidence / destination | Transfer rule |
|---|---|---|---|---|---|
| BD030-A | Product/security owner | Decide whether production/protected environments require additional approval or protected-release policy for rollback | AWAITING OWNER | Current rollback is append-only and permission-checked; no extra approval gate is invented. | Keep on BD-030 unless the catalogue explicitly assigns protected releases elsewhere. |
| BD030-B | Product owner | Confirm required version metadata/change-note fields and retention expectations against the exact catalogue wording | AWAITING OWNER | Current versions preserve immutable definitions/hashes and audit metadata. | Remains BD-030. |

## Transfer history

No dependency has been transferred between feature IDs in this register as of 2026-11-05. No transfer is permitted on the basis of implementation progress alone.

## Approval ledger

No positive owner approval is recorded for the pending items above. A future approval entry must include the exact decision, approver role, date, scope/limits and evidence reference. Verbal ambiguity or a green CI run is not approval.
