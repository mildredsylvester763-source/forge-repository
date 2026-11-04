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

A dry-run may include an event fixture. For simulation, event fixtures can represent push, pull request, schedule, generic event, manual or API triggers. The fixture must include `kind`, `source` and `eventId`.

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
  }
}
```

The server assigns the event source (`forge.manual` or `forge.api`) and event ID. It does not trust a caller-supplied provider source. Supply an `Idempotency-Key` header to make client retries return the same queued run. Without that header, the server generates a fresh event ID.

Returns 202 when a run is durably queued, or 200 when no trigger matched. A queued record is not proof that a worker has executed the pipeline; task execution is not yet integrated.

## Role matrix

| Role | Read | Create | Rollback | Dry-run | Manual/API trigger |
|---|---:|---:|---:|---:|---:|
| Owner | Yes | Yes | Yes | Yes | Yes |
| Admin | Yes | Yes | Yes | Yes | Yes |
| Maintainer | Yes | Yes | Yes | Yes | Yes |
| Member | Yes | No | No | Yes | Yes |
| Viewer | Yes | No | No | Yes | No |
| Suspended / no membership | No | No | No | No | No |

The matrix is a conservative initial Build & CI policy. Workspace membership creation, invitation, role changes and revocation are owned by the workspace/permissions catalogue area, not these endpoints.

## Not exposed yet

- Provider webhook ingress: no provider payload is trusted without signature verification and repository/workspace binding.
- Schedule dispatcher: stored schedule metadata is not yet a running scheduler.
- Worker execution: 202 means queued persistence only, not a completed or running task.
- Logs, artifacts, cancellation, retry and deployment endpoints.
