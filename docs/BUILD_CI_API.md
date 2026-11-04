# Build & CI HTTP API

All endpoints require a valid FORGE session cookie. The actor is derived from that session; clients must not send an `actorId`. State-changing requests remain subject to the kernel's same-origin/CSRF checks.

Workspace membership and pipeline action permissions are checked in the Build & CI service. An absent, suspended or insufficiently privileged membership is denied.

## Pipelines

### Create a pipeline

`POST /v1/build-ci/pipelines`

Body:
```json
{
  "workspaceId": "workspace-a",
  "definition": {
    "id": "quality-gate",
    "name": "Quality gate",
    "inputs": [
      { "name": "environment", "type": "string", "required": true, "options": ["staging", "production"] },
      { "name": "deploy_credential", "type": "secret_ref", "required": true }
    ],
    "triggers": [{ "id": "manual", "kind": "manual" }],
    "steps": [{ "id": "verify", "task": "quality.verify" }]
  }
}
```

Returns 201 with the first immutable pipeline version. The definition is validated against the strict declarative schema before persistence.

### Read the latest version

`GET /v1/build-ci/pipelines?workspaceId=workspace-a&pipelineId=quality-gate`

Returns the latest immutable version.

### List version history

`GET /v1/build-ci/pipelines/versions?workspaceId=workspace-a&pipelineId=quality-gate`

Returns the pipeline's ordered version history.

### Read one version

`GET /v1/build-ci/pipelines/version?workspaceId=workspace-a&pipelineId=quality-gate&version=1`

Returns one immutable version or 404.

### Roll back

`POST /v1/build-ci/pipelines/rollback`

Body:
```json
{
  "workspaceId": "workspace-a",
  "pipelineId": "quality-gate",
  "targetVersion": 1
}
```

Rollback appends a new version copied from the target. It never rewrites or deletes prior history.

## Dry-run

`POST /v1/build-ci/pipelines/dry-run`

Provide exactly one of `pipelineId` or `definition`:

- `pipelineId`: simulate the latest saved version.
- `definition`: simulate an unsaved candidate definition without persisting it.

A dry-run may include an event fixture and an `inputs` object. For simulation, event fixtures can represent push, pull request, schedule, generic event, manual or API triggers. The fixture must include `kind`, `source` and `eventId`. Candidate definitions and their inputs are validated without saving them.

Dry-run is side-effect-free: it does not create a run, save a version, execute tasks, resolve secrets or deploy.

## Manual/API trigger

`POST /v1/build-ci/pipelines/trigger`

Body:
```json
{
  "workspaceId": "workspace-a",
  "pipelineId": "quality-gate",
  "event": {
    "kind": "manual",
    "branch": "main"
  },
  "inputs": {
    "environment": "staging",
    "deploy_credential": "workspace.ci_deploy_key"
  }
}
```

The server assigns the event source (`forge.manual` or `forge.api`) and event ID. It does not trust a caller-supplied provider source. Supply an `Idempotency-Key` header to make client retries return the same queued run. Without that header, the server generates a fresh event ID.

Returns 202 when a run is durably queued, or 200 when no trigger matched. A queued record is not proof that a worker has executed the pipeline; task execution is not yet integrated.

## Reusable pipeline templates — BD-001

### Publish a template

`POST /v1/build-ci/templates`

Body:
```json
{
  "workspaceId": "publisher-workspace",
  "pipelineId": "quality-gate",
  "name": "Quality gate",
  "description": "Standard validation pipeline",
  "visibility": "workspace",
  "changelog": "Initial release"
}
```

Optional `sourceVersion` pins a historical pipeline version; otherwise the latest version is used. Visibility is either:

- `workspace`: only the publisher workspace can discover/import it.
- `shared`: it can be discovered only by the publisher and explicitly granted workspaces.

There is no global public catalogue endpoint.

### Publish a new immutable template release

`POST /v1/build-ci/templates/publish-version`

Body: `workspaceId`, `templateId`, `changelog`, and optional `sourceVersion`. A new release is appended; previous releases cannot be edited or deleted.

### List templates visible to a workspace

`GET /v1/build-ci/templates?workspaceId=consumer-workspace`

Returns templates owned by that workspace and active templates explicitly shared with it.

### Read a pinned template release

`GET /v1/build-ci/templates/version?workspaceId=consumer-workspace&templateId=<template-id>&version=1`

Returns the exact immutable release after access verification.

### Grant and revoke workspace access

`POST /v1/build-ci/templates/share`

Body: `workspaceId`, `templateId`, `targetWorkspaceId`.

`POST /v1/build-ci/templates/revoke-share`

Body: same fields. Revocation blocks future discovery and import; it does not delete prior imported pipelines or rewrite release history.

### Deprecate or revoke a template

`POST /v1/build-ci/templates/status`

Body: `workspaceId`, `templateId`, and `status` (`deprecated` or `revoked`). Only the publisher workspace's owner, admin or maintainer can change template lifecycle.

- Deprecated templates remain discoverable and importable, but no new template release can be published.
- Revoked templates are no longer discoverable or importable. Previously imported pipelines remain intact.

### Read template audit events

`GET /v1/build-ci/templates/events?workspaceId=publisher-workspace&templateId=<template-id>`

Returns append-only lifecycle events. The publisher can inspect the full template history. A previously granted target workspace can inspect events scoped to its own workspace even after the grant is revoked. Other workspaces cannot read that history.

Events include creation, release publication, share grant/revocation, import, deprecation and revocation. The imported event is committed in the same database transaction as the imported pipeline version. The import operation also re-checks access while holding the relevant database locks, so a concurrent share revocation cannot slip between authorization and import.

### Import an exact release

`POST /v1/build-ci/templates/import`

Body:
```json
{
  "workspaceId": "consumer-workspace",
  "templateId": "template-123",
  "templateVersion": 1,
  "pipelineId": "consumer-quality-gate",
  "name": "Consumer quality gate"
}
```

Import creates a new pipeline version with the requested pipeline ID. Its version metadata records the source template ID, release, content hash and publisher workspace. Later template releases do not alter this imported pipeline.

A user must have permission to create pipelines in the target workspace and the template must be accessible there. Publishing/sharing requires owner, admin or maintainer rights. Listing/reading visible templates is allowed to active members and viewers.

## Role matrix

| Role | Read | Create | Rollback | Dry-run | Manual/API trigger | List/read templates | Publish/share templates | Import templates | Deprecate/revoke template |
|---|---:|---:|---:|---:|---:|
| Owner | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Admin | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Maintainer | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Member | Yes | No | No | Yes | Yes | Yes | No | No | No |
| Viewer | Yes | No | No | Yes | No | Yes | No | No | No |
| Suspended / no membership | No | No | No | No | No | No | No | No | No |

The matrix is a conservative initial Build & CI policy. Workspace membership creation, invitation, role changes and revocation are owned by the workspace/permissions catalogue area, not these endpoints.

## Not exposed yet

- Global/public template catalogue, organisation-wide discovery and template moderation are not enabled.
- Provider webhook ingress: GitHub/GitLab signature verification and event normalization primitives exist, but no public webhook route is exposed yet. Encrypted provider-secret storage, repository/workspace binding and durable delivery deduplication must be completed first.
- Schedule dispatcher: stored schedule metadata is not yet a running scheduler.
- Worker execution: 202 means queued persistence only, not a completed or running task.
- Logs, artifacts, cancellation, retry and deployment endpoints.
