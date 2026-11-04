import { randomUUID } from 'node:crypto';
import { createPipelineVersion, validatePipelineDefinition, type PipelineVersion, type PipelineTemplateSource } from './pipeline.ts';
import { PipelineTemplateUnavailableError } from './templates.ts';
import {
  type CreatePipelineRunInput,
  type CreatePipelineRunResult,
  type PipelineRun,
  type PipelineStore,
  type SavePipelineVersionInput,
} from './store.ts';
import { withTransaction, type SqlPool, type SqlConn } from '../../kernel/sql.ts';

interface VersionRow {
  workspace_id: string;
  pipeline_id: string;
  version: number | string;
  definition_json: string;
  definition_hash: string;
  created_at: string;
  created_by: string;
  rollback_of_version: number | string | null;
  template_id: string | null;
  template_version: number | string | null;
  template_hash: string | null;
  template_publisher_workspace_id: string | null;
}

interface RunRow {
  run_id: string;
  workspace_id: string;
  pipeline_id: string;
  pipeline_version: number | string;
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
  const templateColumns = [row.template_id, row.template_version, row.template_hash, row.template_publisher_workspace_id];
  if (templateColumns.some((value) => value !== null) && templateColumns.some((value) => value === null)) {
    throw new Error(`Stored pipeline version ${row.pipeline_id}@${row.version} has incomplete template provenance.`);
  }
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

export class PostgresBuildCiStore implements PipelineStore {
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }

  private async saveVersionInTransaction(conn: SqlConn, input: SavePipelineVersionInput): Promise<PipelineVersion> {
    const now = input.createdAt ?? new Date().toISOString();
    await conn.query(`INSERT INTO build_pipelines (workspace_id, pipeline_id, current_version, created_at, updated_at)
      VALUES ($1, $2, 0, $3, $3) ON CONFLICT (workspace_id, pipeline_id) DO NOTHING`, [input.workspaceId, input.definition.id, now]);
    const head = await conn.query<{ current_version: number | string }>(`SELECT current_version FROM build_pipelines
      WHERE workspace_id = $1 AND pipeline_id = $2 FOR UPDATE`, [input.workspaceId, input.definition.id]);
    const current = head.rows[0];
    if (!current) throw new Error('Pipeline head row was not created.');
    const nextVersion = Number(current.current_version) + 1;
    const snapshot = createPipelineVersion(input.definition, nextVersion, input.createdBy, now, input.rollbackOfVersion, input.templateSource);
    await conn.query(`INSERT INTO build_pipeline_versions
      (workspace_id, pipeline_id, version, definition_json, definition_hash, created_at, created_by, rollback_of_version, template_id, template_version, template_hash, template_publisher_workspace_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [
      input.workspaceId, snapshot.pipelineId, snapshot.version, JSON.stringify(snapshot.definition), snapshot.definitionHash,
      snapshot.createdAt, snapshot.createdBy, snapshot.rollbackOfVersion ?? null, snapshot.templateSource?.templateId ?? null,
      snapshot.templateSource?.templateVersion ?? null, snapshot.templateSource?.templateHash ?? null,
      snapshot.templateSource?.publisherWorkspaceId ?? null,
    ]);
    if (snapshot.templateSource) {
      await conn.query(`INSERT INTO build_pipeline_template_events
        (event_id, template_id, event_type, workspace_id, actor_id, target_workspace_id, template_version, template_hash, occurred_at, metadata_json)
        VALUES ($1, $2, 'imported', $3, $4, NULL, $5, $6, $7, $8)`, [
        randomUUID(), snapshot.templateSource.templateId, input.workspaceId, input.createdBy,
        snapshot.templateSource.templateVersion, snapshot.templateSource.templateHash, now,
        JSON.stringify({ pipelineId: snapshot.pipelineId }),
      ]);
    }
    await conn.query(`UPDATE build_pipelines SET current_version = $1, updated_at = $2
      WHERE workspace_id = $3 AND pipeline_id = $4`, [snapshot.version, now, input.workspaceId, snapshot.pipelineId]);
    return snapshot;
  }

  async saveVersion(input: SavePipelineVersionInput): Promise<PipelineVersion> {
    ensureScope(input.workspaceId, input.definition.id);
    return withTransaction(this.pool, (conn) => this.saveVersionInTransaction(conn, input));
  }

  async importTemplate(input: {
    workspaceId: string; templateId: string; templateVersion: number; pipelineId: string; name?: string;
    createdBy: string; createdAt?: string;
  }): Promise<PipelineVersion> {
    ensureScope(input.workspaceId, input.pipelineId);
    if (!Number.isSafeInteger(input.templateVersion) || input.templateVersion < 1) throw new TypeError('templateVersion must be a positive integer');
    return withTransaction(this.pool, async (conn) => {
      const templateResult = await conn.query<{ publisher_workspace_id: string; visibility: string; status: string }>(
        'SELECT publisher_workspace_id, visibility, status FROM build_pipeline_templates WHERE template_id = $1 FOR SHARE',
        [input.templateId],
      );
      const template = templateResult.rows[0];
      if (!template || (template.status !== 'active' && template.status !== 'deprecated')) throw new PipelineTemplateUnavailableError();
      if (template.publisher_workspace_id !== input.workspaceId) {
        if (template.visibility !== 'shared') throw new PipelineTemplateUnavailableError();
        const grant = await conn.query(
          'SELECT template_id FROM build_pipeline_template_grants WHERE template_id = $1 AND target_workspace_id = $2 AND revoked_at IS NULL FOR SHARE',
          [input.templateId, input.workspaceId],
        );
        if (grant.rowCount !== 1) throw new PipelineTemplateUnavailableError();
      }
      const versionResult = await conn.query<{ source_pipeline_version: number | string; definition_json: string; definition_hash: string }>(
        'SELECT source_pipeline_version, definition_json, definition_hash FROM build_pipeline_template_versions WHERE template_id = $1 AND version = $2',
        [input.templateId, input.templateVersion],
      );
      const row = versionResult.rows[0];
      if (!row) throw new PipelineTemplateUnavailableError();
      const source = createPipelineVersion(JSON.parse(row.definition_json) as unknown, Number(row.source_pipeline_version), input.createdBy);
      if (source.definitionHash !== row.definition_hash) throw new Error('Pipeline template release failed integrity verification.');
      const definition = validatePipelineDefinition({
        ...source.definition,
        id: input.pipelineId,
        ...(input.name ? { name: input.name } : {}),
      });
      const templateSource: PipelineTemplateSource = {
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        templateHash: row.definition_hash,
        publisherWorkspaceId: template.publisher_workspace_id,
      };
      return this.saveVersionInTransaction(conn, {
        workspaceId: input.workspaceId,
        definition,
        createdBy: input.createdBy,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        templateSource,
      });
    });
  }

  async getVersion(workspaceId: string, pipelineId: string, version: number): Promise<PipelineVersion | null> {
    ensureScope(workspaceId, pipelineId);
    const result = await this.pool.query<VersionRow>(`SELECT * FROM build_pipeline_versions
      WHERE workspace_id = $1 AND pipeline_id = $2 AND version = $3`, [workspaceId, pipelineId, version]);
    return result.rows[0] ? versionFromRow(result.rows[0]) : null;
  }

  async getLatestVersion(workspaceId: string, pipelineId: string): Promise<PipelineVersion | null> {
    ensureScope(workspaceId, pipelineId);
    const result = await this.pool.query<VersionRow>(`SELECT v.* FROM build_pipelines p
      JOIN build_pipeline_versions v ON v.workspace_id = p.workspace_id AND v.pipeline_id = p.pipeline_id AND v.version = p.current_version
      WHERE p.workspace_id = $1 AND p.pipeline_id = $2`, [workspaceId, pipelineId]);
    return result.rows[0] ? versionFromRow(result.rows[0]) : null;
  }

  async listVersions(workspaceId: string, pipelineId: string): Promise<readonly PipelineVersion[]> {
    ensureScope(workspaceId, pipelineId);
    const result = await this.pool.query<VersionRow>(`SELECT * FROM build_pipeline_versions
      WHERE workspace_id = $1 AND pipeline_id = $2 ORDER BY version`, [workspaceId, pipelineId]);
    return Object.freeze(result.rows.map(versionFromRow));
  }

  async createRun(input: CreatePipelineRunInput): Promise<CreatePipelineRunResult> {
    ensureScope(input.workspaceId, input.pipelineId);
    return withTransaction(this.pool, async (conn) => {
      const runId = input.runId ?? randomUUID();
      const inserted = await conn.query(`INSERT INTO build_pipeline_runs
        (run_id, workspace_id, pipeline_id, pipeline_version, idempotency_key, trigger_kind, trigger_ids_json,
         event_source, event_id, status, created_at, context_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11)
        ON CONFLICT (workspace_id, pipeline_id, idempotency_key) DO NOTHING`, [
        runId, input.workspaceId, input.pipelineId, input.pipelineVersion, input.idempotencyKey, input.triggerKind,
        JSON.stringify(input.triggerIds), input.eventSource, input.eventId, input.createdAt, JSON.stringify(input.context),
      ]);
      const result = await conn.query<RunRow>(`SELECT * FROM build_pipeline_runs
        WHERE workspace_id = $1 AND pipeline_id = $2 AND idempotency_key = $3`, [input.workspaceId, input.pipelineId, input.idempotencyKey]);
      const row = result.rows[0];
      if (!row) throw new Error('Pipeline run insert was not visible after the transaction write.');
      return { run: runFromRow(row), created: inserted.rowCount === 1 };
    });
  }

  async getRun(workspaceId: string, pipelineId: string, runId: string): Promise<PipelineRun | null> {
    ensureScope(workspaceId, pipelineId);
    const result = await this.pool.query<RunRow>(`SELECT * FROM build_pipeline_runs
      WHERE workspace_id = $1 AND pipeline_id = $2 AND run_id = $3`, [workspaceId, pipelineId, runId]);
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }
}
