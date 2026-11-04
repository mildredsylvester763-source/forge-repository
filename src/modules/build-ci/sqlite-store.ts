import { randomUUID } from 'node:crypto';
import { createPipelineVersion, type PipelineVersion } from './pipeline.ts';
import {
  type CreatePipelineRunInput,
  type CreatePipelineRunResult,
  type PipelineRun,
  type PipelineStore,
  type SavePipelineVersionInput,
} from './store.ts';
import { transaction, type Database } from '../../kernel/sqlite.ts';

interface VersionRow {
  workspace_id: string;
  pipeline_id: string;
  version: number;
  definition_json: string;
  definition_hash: string;
  created_at: string;
  created_by: string;
  rollback_of_version: number | null;
  template_id: string | null;
  template_version: number | null;
  template_hash: string | null;
  template_publisher_workspace_id: string | null;
}

interface RunRow {
  run_id: string;
  workspace_id: string;
  pipeline_id: string;
  pipeline_version: number;
  idempotency_key: string;
  trigger_kind: PipelineRun['triggerKind'];
  trigger_ids_json: string;
  event_source: string;
  event_id: string;
  status: PipelineRun['status'];
  created_at: string;
  context_json: string;
}

function versionFromRow(row: VersionRow): PipelineVersion {
  const definition = JSON.parse(row.definition_json) as unknown;
  const version = createPipelineVersion(
    definition,
    Number(row.version),
    row.created_by,
    row.created_at,
    row.rollback_of_version === null ? undefined : Number(row.rollback_of_version),
    row.template_id && row.template_version !== null && row.template_hash && row.template_publisher_workspace_id ? { templateId: row.template_id, templateVersion: Number(row.template_version), templateHash: row.template_hash, publisherWorkspaceId: row.template_publisher_workspace_id } : undefined,
  );
  if (version.pipelineId !== row.pipeline_id || version.definitionHash !== row.definition_hash) {
    throw new Error(`Stored pipeline version ${row.pipeline_id}@${row.version} failed integrity verification.`);
  }
  return version;
}

function runFromRow(row: RunRow): PipelineRun {
  return Object.freeze({
    runId: row.run_id,
    workspaceId: row.workspace_id,
    pipelineId: row.pipeline_id,
    pipelineVersion: Number(row.pipeline_version),
    idempotencyKey: row.idempotency_key,
    triggerKind: row.trigger_kind,
    triggerIds: Object.freeze(JSON.parse(row.trigger_ids_json) as string[]),
    eventSource: row.event_source,
    eventId: row.event_id,
    status: row.status,
    createdAt: row.created_at,
    context: Object.freeze(JSON.parse(row.context_json) as PipelineRun['context']),
  });
}

function ensureScope(workspaceId: string, pipelineId: string): void {
  if (!workspaceId.trim() || workspaceId.length > 128) throw new TypeError('workspaceId is required');
  if (!pipelineId.trim() || pipelineId.length > 64) throw new TypeError('pipelineId is required');
}

export class SqliteBuildCiStore implements PipelineStore {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }

  async saveVersion(input: SavePipelineVersionInput): Promise<PipelineVersion> {
    ensureScope(input.workspaceId, input.definition.id);
    return transaction(this.db, () => {
      const now = input.createdAt ?? new Date().toISOString();
      this.db.prepare(`INSERT INTO build_pipelines (workspace_id, pipeline_id, current_version, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?) ON CONFLICT (workspace_id, pipeline_id) DO NOTHING`).run(input.workspaceId, input.definition.id, now, now);
      const current = this.db.prepare('SELECT current_version FROM build_pipelines WHERE workspace_id = ? AND pipeline_id = ?')
        .get(input.workspaceId, input.definition.id) as { current_version: number } | undefined;
      if (!current) throw new Error('Pipeline head row was not created.');
      const nextVersion = Number(current.current_version) + 1;
      const snapshot = createPipelineVersion(input.definition, nextVersion, input.createdBy, now, input.rollbackOfVersion);
      this.db.prepare(`INSERT INTO build_pipeline_versions
        (workspace_id, pipeline_id, version, definition_json, definition_hash, created_at, created_by, rollback_of_version, template_id, template_version, template_hash, template_publisher_workspace_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.workspaceId, snapshot.pipelineId, snapshot.version, JSON.stringify(snapshot.definition), snapshot.definitionHash,
          snapshot.createdAt, snapshot.createdBy, snapshot.rollbackOfVersion ?? null, snapshot.templateSource?.templateId ?? null, snapshot.templateSource?.templateVersion ?? null, snapshot.templateSource?.templateHash ?? null, snapshot.templateSource?.publisherWorkspaceId ?? null);
      this.db.prepare('UPDATE build_pipelines SET current_version = ?, updated_at = ? WHERE workspace_id = ? AND pipeline_id = ?')
        .run(snapshot.version, now, input.workspaceId, snapshot.pipelineId);
      return snapshot;
    });
  }

  async getVersion(workspaceId: string, pipelineId: string, version: number): Promise<PipelineVersion | null> {
    ensureScope(workspaceId, pipelineId);
    const row = this.db.prepare(`SELECT * FROM build_pipeline_versions
      WHERE workspace_id = ? AND pipeline_id = ? AND version = ?`).get(workspaceId, pipelineId, version) as VersionRow | undefined;
    return row ? versionFromRow(row) : null;
  }

  async getLatestVersion(workspaceId: string, pipelineId: string): Promise<PipelineVersion | null> {
    ensureScope(workspaceId, pipelineId);
    const row = this.db.prepare(`SELECT v.* FROM build_pipelines p
      JOIN build_pipeline_versions v ON v.workspace_id = p.workspace_id AND v.pipeline_id = p.pipeline_id AND v.version = p.current_version
      WHERE p.workspace_id = ? AND p.pipeline_id = ?`).get(workspaceId, pipelineId) as VersionRow | undefined;
    return row ? versionFromRow(row) : null;
  }

  async listVersions(workspaceId: string, pipelineId: string): Promise<readonly PipelineVersion[]> {
    ensureScope(workspaceId, pipelineId);
    const rows = this.db.prepare(`SELECT * FROM build_pipeline_versions
      WHERE workspace_id = ? AND pipeline_id = ? ORDER BY version`).all(workspaceId, pipelineId) as unknown as VersionRow[];
    return Object.freeze(rows.map(versionFromRow));
  }

  async createRun(input: CreatePipelineRunInput): Promise<CreatePipelineRunResult> {
    ensureScope(input.workspaceId, input.pipelineId);
    return transaction(this.db, () => {
      const runId = input.runId ?? randomUUID();
      const inserted = this.db.prepare(`INSERT INTO build_pipeline_runs
        (run_id, workspace_id, pipeline_id, pipeline_version, idempotency_key, trigger_kind, trigger_ids_json,
         event_source, event_id, status, created_at, context_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
        ON CONFLICT (workspace_id, pipeline_id, idempotency_key) DO NOTHING`)
        .run(runId, input.workspaceId, input.pipelineId, input.pipelineVersion, input.idempotencyKey, input.triggerKind,
          JSON.stringify(input.triggerIds), input.eventSource, input.eventId, input.createdAt, JSON.stringify(input.context));
      const row = this.db.prepare(`SELECT * FROM build_pipeline_runs
        WHERE workspace_id = ? AND pipeline_id = ? AND idempotency_key = ?`)
        .get(input.workspaceId, input.pipelineId, input.idempotencyKey) as RunRow | undefined;
      if (!row) throw new Error('Pipeline run insert was not visible after the transaction write.');
      return { run: runFromRow(row), created: Number(inserted.changes) === 1 };
    });
  }

  async getRun(workspaceId: string, pipelineId: string, runId: string): Promise<PipelineRun | null> {
    ensureScope(workspaceId, pipelineId);
    const row = this.db.prepare(`SELECT * FROM build_pipeline_runs
      WHERE workspace_id = ? AND pipeline_id = ? AND run_id = ?`).get(workspaceId, pipelineId, runId) as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }
}
