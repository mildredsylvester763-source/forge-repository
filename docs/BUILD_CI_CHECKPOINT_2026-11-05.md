# Build & CI continuation checkpoint — 2026-11-05

Branch: `gpt-part2-build-ci`
Repository: `mildredsylvester763-source/forge-repository`
Protected boundaries: `main`, `mistral` and `claude` remain untouched. No merge or deployment was performed.

## Implementation added in this continuation

### BD-016 — webhook operations and provider connection lifecycle

- Webhook failures are redacted at the SQLite/PostgreSQL delivery-storage boundary. Arbitrary processor or provider exception messages are not persisted.
- Migration v8 adds an append-only delivery replay audit table. Workspace-scoped dead-letter listing is paginated and returns only operational metadata; raw normalized webhook payloads and payload digests are excluded from the response.
- Failed deliveries can be re-queued only by workspace owners, admins and maintainers. Replay is transactional, records the actor/time/previous-attempt count, and is idempotent when concurrent requests race.
- Migration v9 adds an append-only provider-connection lifecycle audit table. Creation, secret-reference rotation and revocation are committed atomically with connection state changes in SQLite and PostgreSQL.
- Provider connection APIs are authenticated and workspace-authorized. A human maintainer is audited separately from an explicitly selected delivery actor whose trigger permission is checked. The current delivery actor is a workspace member; a production service-principal lifecycle is not invented.
- Provider references are workspace-namespaced and path-validated. Cross-workspace references, empty path segments and traversal-like segments are rejected before vault resolution. References and signing material are not returned by APIs or included in audit metadata.
- Provider repository syntax is validated by provider: GitHub `owner/repo`, GitLab `group[/subgroup]/project`.
- Provider management routes are only composed when an external `providerSecrets` resolver is injected. The default application remains fail-closed. Supplying both a custom `webhookConnections` resolver and `providerSecrets` is rejected to avoid split trust state.
- PostgreSQL integration coverage now includes provider connection management, audit immutability, workspace scoping, duplicate ID conflicts, secret-reference rotation/revocation races, and concurrent replay of one dead letter.
- Relevant implementation commits include `7705a557b5eaf9da3348d807ff4dac9698b551d1`, `2aa7145f639b1aaf4893f7d4598f6e0b9e17a06b`, `82210f2168c044cec0b415841f4da8194bfe42d2`, `accd208bee6e8290bb5b9da31ed5a1d89fad92b3`, `115f5ff45b3c33f08c580c2a9a55cf762ce6c9a5`, `d7d1e5f8ce2367b9c3784456cc965b913a5077b7` and `e6f2e403dcfb154ab6d2f92c4465974f94fdd1b2`.

### BD-029 — pipeline diff and scenario simulation

- Added pure value-free pipeline definition comparison: root fields, added/removed/changed triggers and steps, changed field names and relative ordering. Parameter values and secret references are not returned.
- Added authenticated `GET /v1/build-ci/pipelines/versions/diff`.
- Candidate dry-run responses now include baseline version/hash, candidate hash and a structural diff when a saved baseline exists. The operation does not persist a candidate or run.
- Added a separate `POST /v1/build-ci/pipelines/dry-run/scenarios` endpoint for 1–20 uniquely identified event fixtures. It supports saved and unsaved candidate definitions and returns a plan per scenario.
- Unit/service/route tests cover added/removed/changed elements, ordering, workspace authorization, duplicate scenario IDs, the scenario limit and no-write behavior.
- Relevant commits: `92c76a75a88f1b057c8b44752449f2223c8a63a6`, `bdb6a1496d45f228a1196489ffe82707013c50a2`, `db68451c4f325a8f91960ec978cf00c34ccac325`, `f27dfa0d471067b52d603473cd92aa1a3e5c5ebe`, `a422470ee2b2670fdd61865daa400253640cd735`, `f7df217b16ae4cc6007d2cd4a7a413cee392f41d`, `16291e6e9f216d3916b94c607c1794a15bd9e35e`, `2a2191dd62a591d313dd299af2edb3d6cc6d018b`, `493ecbe2fc401bd20633202c83e1cca7506959ee`, `23359a0424d8d78f669c60d63767dca4da5501d7`, `aa7c200f9234594801435b65b194e45fe98c718b` and `76dbb51cd973b446dce39704ae24cfa41e457423`.

### BD-001 — template release comparison

- Added workspace-authorized `diffTemplateVersions` service and `GET /v1/build-ci/templates/versions/diff`.
- Both publisher and explicitly shared workspaces can compare pinned immutable releases, subject to current access checks.
- The diff returns release hashes and value-free structural differences. It does not change an imported pipeline or apply an upgrade.
- Relevant commits: `8b615f445dd1af424581aff2c44104d4a359979d`, `ac027b0c4ffaee942fafb51b194e45fe98c718b`, `3287a1fae40874987a66408f2f2de83aac343589` and `3ad94322e62141261d77e7f132f7ae8cddfb6202`.

### BD-030 — version integrity and concurrency evidence

- Both adapters already recompute and verify the stored content hash when reading pipeline versions. New SQLite and PostgreSQL regression tests deliberately tamper with stored definition JSON in isolated test databases and verify that reads reject the mismatched hash.
- Added PostgreSQL integration tests for concurrent version creation and concurrent rollback allocation, asserting a monotonic, contiguous version history.
- Relevant commits: `ef6708ba6bcc6ae6917a272c8a5615084adcfee4`, `aec0444281554108c06c96121c35af70edce2514`, `bdff1fc28ac99207bc470a287624f7b08354c0a6` and `65a58a47bf089f04a2a64aea179806647e39b5c6`.

## Source repair made during review

- Review found that `src/modules/build-ci/routes.ts` contained a duplicated route function plus a malformed trailing fragment from an earlier automated edit. The first complete route table was retained, the duplicated tail removed, and the current file checked to contain one `buildCiRoutes` declaration and one copy of each helper.
- This repair and all continuation changes require the same full typecheck/build/test run as the other new code.

## Verification state

**NOT VERIFIED.** No current typecheck, production build or real-PostgreSQL test result is claimed for this checkpoint.

The last independently known green Actions baseline remains commit `d3a602ce22b296194ad16bc5d0fbdbc69a7b99eb`, run `41826209940`, which passed typecheck, production build and 195 PostgreSQL-backed tests. That run predates this continuation.

The GitHub connector available in this session exposes pull-request workflow runs only; commit statuses were empty and did not reveal the newer push-triggered run. The public GitHub Actions API page was also inaccessible through the available browser. The workflow file does trigger on pushes to `gpt-part2-build-ci`, but that configuration is not proof of a completed run. Do not mark these changes CI-passing until the actual run and job results are inspected.

## Decisions awaiting the owner

1. Production delivery identity: replace the current selected workspace-member actor with a first-class non-human service principal, including its lifecycle and audit rules.
2. Concrete vault/KMS provider and secret provisioning/rotation/retirement workflow.
3. GitHub App installation permissions and GitLab API scopes permitted for retrieving pull-request/merge-request changed-file lists.
4. The adapter boundary between Build & CI and the Mistral-owned Task Runtime. Current Task Runtime creates user-owned runs from free-text goals and has no workspace/pipeline/version-scoped registered task executor. Do not encode CI jobs as goals or duplicate the Mistral engines.
5. Whether maintainers retain webhook dead-letter replay permission, or replay is limited to owner/admin.
6. Whether a future global/community template catalogue is in scope.
7. Template upgrade conflict policy: strict replace with an explicit warning, user/AI-supplied merged candidate, or a three-way merge of pinned base, local edits and the newer release. No automatic overwrite or merge has been added.

The master general FORGE feature catalogue is still not available in the current Library context. The accessible Sentinel Loop catalogue is a separate security module and is not being treated as the general first-50 feature list.
