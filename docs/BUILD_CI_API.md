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

## Provider webhook ingress — BD-016

These routes are registered only when the application is composed with a trusted \`WebhookConnectionResolver\` from the secret/integration subsystem. The default app does not register them.

- \`POST /v1/webhooks/github?connectionId=<opaque-connection-id>\`
- \`POST /v1/webhooks/gitlab?connectionId=<opaque-connection-id>\`

Both require \`Content-Type: application/json\` and the provider's signature headers. The server verifies the exact raw request bytes before parsing or acting on the event. GitHub requires \`X-Hub-Signature-256\`, \`X-GitHub-Event\` and \`X-GitHub-Delivery\`. GitLab requires Standard Webhooks \`webhook-id\`, \`webhook-timestamp\`, \`webhook-signature\` and \`X-Gitlab-Event\`.

The connection resolver must return an active provider connection with a workspace, exact repository binding and signing secret. The normalized repository must exactly match the configured repository. The signing secret is resolved in memory and is never persisted by Build & CI.

A successful first delivery returns HTTP 202 with `accepted: true`, `duplicate: false`, delivery ID and workspace ID. A repeated delivery ID for the same connection returns HTTP 202 with `duplicate: true`. Only normalized event data and a SHA-256 body digest are stored; raw request bytes and signing secrets are not stored in the delivery queue.

The durable worker processor claims deliveries with database-backed leases, retries transient failures with bounded exponential backoff, recovers expired leases and moves exhausted deliveries to terminal `failed` status. The optional worker host must be explicitly configured; the default app does not start a background worker. A successful webhook response still means “signature verified and delivery durably queued,” not “pipeline executed.” The processor re-resolves trusted workspace/repository binding and calls Build & CI to create authorized, idempotent queued pipeline runs. It does not execute pipeline tasks or dispatch to Task Runtime.

### Inspect and replay terminal webhook failures

These authenticated workspace routes are registered independently of the optional provider ingress routes:

- `GET /v1/build-ci/webhooks/dead-letters?workspaceId=<workspace-id>&limit=50`
- `GET /v1/build-ci/webhooks/dead-letters?workspaceId=<workspace-id>&limit=50&beforeReceivedAt=<timestamp>&beforeDeliveryRowId=<row-id>`
- `GET /v1/build-ci/webhooks/dead-letters/events?workspaceId=<workspace-id>&deliveryRowId=<row-id>`
- `POST /v1/build-ci/webhooks/dead-letters/replay`

Replay body:
```json
{
  "workspaceId": "workspace-alpha",
  "deliveryRowId": "delivery-row-id"
}
```

Listing is workspace-scoped and paginated (1–100 entries per page). The response intentionally excludes the stored webhook event payload and body digest. Active workspace members/viewers may read dead-letter metadata and replay history. Only owner, admin and maintainer roles may replay a failed delivery. A replay atomically resets the delivery to queued state and resets the retry counter; it does not bypass signature verification already performed at ingress or grant access to another workspace. A replay of a row that is no longer terminal returns 404.

Every replay writes an append-only audit event containing the actor, timestamp and prior attempt count. SQLite and PostgreSQL both enforce append-only updates/deletes on the replay event table. Failure details are redacted at the persistence boundary, not only in the worker processor, so provider exceptions cannot persist arbitrary credential-bearing text in the delivery error field.

A 202 replay response means the delivery has been re-queued. The optional worker must be running for it to be processed, and any resulting pipeline run remains queued until a separate task-execution worker is implemented.

## Role matrix

| Role | Read | Create | Rollback | Dry-run | Manual/API trigger | List/read templates | Publish/share templates | Import templates | Deprecate/revoke template | Replay webhook dead letters |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Owner | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Admin | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Maintainer | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Member | Yes | No | No | Yes | Yes | Yes | No | No | No | No |
| Viewer | Yes | No | No | Yes | No | Yes | No | No | No | No |
| Suspended / no membership | No | No | No | No | No | No | No | No | No | No |

The matrix is a conservative initial Build & CI policy. Workspace membership creation, invitation, role changes and revocation are owned by the workspace/permissions catalogue area, not these endpoints.

## Not exposed yet

- Global/public template catalogue, organisation-wide discovery and template moderation are not enabled.
- Provider connection creation/update/revocation routes, provider installation OAuth, a production vault/KMS adapter, secret provisioning and retirement workflow, and trusted service-principal lifecycle remain external integration work. Build & CI stores opaque secret references only.
- The optional worker host is not started by default. A production workspace inventory source and deployment/runtime configuration are required before enabling it.
- Pipeline task execution, isolated runner provisioning, scoped runtime-secret delivery, run logs, artifacts, cancellation and deployment endpoints are not implemented. Current webhook/schedule processing only creates authorized queued pipeline runs.
