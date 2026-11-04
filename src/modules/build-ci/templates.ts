import { randomUUID } from 'node:crypto';
import { createPipelineVersion, type PipelineDefinition, type PipelineVersion } from './pipeline.ts';
import { transaction, type Database } from '../../kernel/sqlite.ts';
import { withTransaction, type SqlPool } from '../../kernel/sql.ts';

export type PipelineTemplateVisibility = 'workspace' | 'shared';
export type PipelineTemplateStatus = 'active' | 'deprecated' | 'revoked';
export type PipelineTemplateEventType = 'created' | 'version_published' | 'share_granted' | 'share_revoked' | 'imported' | 'deprecated' | 'revoked';

export interface PipelineTemplate {
  readonly templateId: string;
  readonly publisherWorkspaceId: string;
  readonly sourcePipelineId: string;
  readonly name: string;
  readonly description?: string;
  readonly visibility: PipelineTemplateVisibility;
  readonly status: PipelineTemplateStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly currentVersion: number;
}

export interface PipelineTemplateVersion {
  readonly templateId: string;
  readonly version: number;
  readonly sourcePipelineVersion: number;
  readonly definition: PipelineDefinition;
  readonly definitionHash: string;
  readonly changelog: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface PipelineTemplateEvent {
  readonly eventId: string;
  readonly templateId: string;
  readonly eventType: PipelineTemplateEventType;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly targetWorkspaceId?: string;
  readonly templateVersion?: number;
  readonly templateHash?: string;
  readonly occurredAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface CreatePipelineTemplateInput {
  readonly templateId: string;
  readonly publisherWorkspaceId: string;
  readonly source: PipelineVersion;
  readonly name: string;
  readonly description?: string;
  readonly visibility: PipelineTemplateVisibility;
  readonly changelog: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface PublishPipelineTemplateVersionInput {
  readonly templateId: string;
  readonly publisherWorkspaceId: string;
  readonly source: PipelineVersion;
  readonly changelog: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface PipelineTemplateStore {
  create(input: CreatePipelineTemplateInput): Promise<PipelineTemplateVersion>;
  publishVersion(input: PublishPipelineTemplateVersionInput): Promise<PipelineTemplateVersion>;
  getTemplate(templateId: string): Promise<PipelineTemplate | null>;
  getVersion(templateId: string, version: number): Promise<PipelineTemplateVersion | null>;
  listAccessible(workspaceId: string): Promise<readonly PipelineTemplate[]>;
  canAccess(templateId: string, workspaceId: string): Promise<boolean>;
  grant(templateId: string, publisherWorkspaceId: string, targetWorkspaceId: string, actorId: string, createdAt: string): Promise<void>;
  revoke(templateId: string, publisherWorkspaceId: string, targetWorkspaceId: string, actorId: string, revokedAt: string): Promise<void>;
  setStatus(templateId: string, publisherWorkspaceId: string, status: 'deprecated' | 'revoked', actorId: string, occurredAt: string): Promise<void>;
  listEvents(templateId: string, workspaceId: string): Promise<readonly PipelineTemplateEvent[]>;
}

interface TemplateRow {
  template_id: string; publisher_workspace_id: string; source_pipeline_id: string; name: string;
  description: string | null; visibility: PipelineTemplateVisibility; status: PipelineTemplateStatus;
  created_by: string; created_at: string; current_version: number | string;
}
interface TemplateVersionRow {
  template_id: string; version: number | string; source_pipeline_version: number | string;
  definition_json: string; definition_hash: string; changelog: string; created_by: string; created_at: string;
}
interface TemplateEventRow {
  event_id: string; template_id: string; event_type: PipelineTemplateEventType; workspace_id: string;
  actor_id: string; target_workspace_id: string | null; template_version: number | string | null;
  template_hash: string | null; occurred_at: string; metadata_json: string;
}

const templateFromRow = (row: TemplateRow): PipelineTemplate => Object.freeze({
  templateId: row.template_id, publisherWorkspaceId: row.publisher_workspace_id,
  sourcePipelineId: row.source_pipeline_id, name: row.name,
  ...(row.description !== null ? { description: row.description } : {}),
  visibility: row.visibility, status: row.status, createdBy: row.created_by,
  createdAt: row.created_at, currentVersion: Number(row.current_version),
});

function versionFromRow(row: TemplateVersionRow): PipelineTemplateVersion {
  const definition = JSON.parse(row.definition_json) as unknown;
  const snapshot = createPipelineVersion(definition, Number(row.source_pipeline_version), row.created_by, row.created_at);
  if (snapshot.definitionHash !== row.definition_hash) throw new Error(`Stored template ${row.template_id}@${row.version} failed integrity verification.`);
  return Object.freeze({
    templateId: row.template_id, version: Number(row.version), sourcePipelineVersion: Number(row.source_pipeline_version),
    definition: snapshot.definition, definitionHash: row.definition_hash, changelog: row.changelog,
    createdBy: row.created_by, createdAt: row.created_at,
  });
}

function eventFromRow(row: TemplateEventRow): PipelineTemplateEvent {
  return Object.freeze({
    eventId: row.event_id, templateId: row.template_id, eventType: row.event_type,
    workspaceId: row.workspace_id, actorId: row.actor_id,
    ...(row.target_workspace_id !== null ? { targetWorkspaceId: row.target_workspace_id } : {}),
    ...(row.template_version !== null ? { templateVersion: Number(row.template_version) } : {}),
    ...(row.template_hash !== null ? { templateHash: row.template_hash } : {}),
    occurredAt: row.occurred_at, metadata: Object.freeze(JSON.parse(row.metadata_json) as Record<string, unknown>),
  });
}

function validateInput(input: { templateId: string; publisherWorkspaceId: string; name?: string; changelog?: string; createdBy: string; createdAt: string }): void {
  for (const [field, value] of Object.entries(input)) {
    const max = field === 'changelog' ? 2000 : field === 'description' ? 1000 : field === 'name' ? 100 : 128;
    if (typeof value === 'string' && (value.trim().length === 0 || value.length > max)) throw new TypeError(`${field} is invalid`);
  }
}

export class SqlitePipelineTemplateStore implements PipelineTemplateStore {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }

  private writeEvent(input: Omit<PipelineTemplateEvent, 'metadata'> & { metadata?: Readonly<Record<string, unknown>> }): void {
    this.db.prepare(`INSERT INTO build_pipeline_template_events
      (event_id, template_id, event_type, workspace_id, actor_id, target_workspace_id, template_version, template_hash, occurred_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.eventId, input.templateId, input.eventType, input.workspaceId, input.actorId,
      input.targetWorkspaceId ?? null, input.templateVersion ?? null, input.templateHash ?? null,
      input.occurredAt, JSON.stringify(input.metadata ?? {}),
    );
  }

  async create(input: CreatePipelineTemplateInput): Promise<PipelineTemplateVersion> {
    validateInput(input);
    return transaction(this.db, () => {
      const source = input.source;
      this.db.prepare(`INSERT INTO build_pipeline_templates
        (template_id, publisher_workspace_id, source_pipeline_id, name, description, visibility, status, created_by, created_at, current_version)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)`).run(
        input.templateId, input.publisherWorkspaceId, source.pipelineId, input.name, input.description ?? null,
        input.visibility, input.createdBy, input.createdAt,
      );
      this.db.prepare(`INSERT INTO build_pipeline_template_versions
        (template_id, version, source_pipeline_version, definition_json, definition_hash, changelog, created_by, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?)`).run(
        input.templateId, source.version, JSON.stringify(source.definition), source.definitionHash,
        input.changelog, input.createdBy, input.createdAt,
      );
      this.writeEvent({
        eventId: randomUUID(), templateId: input.templateId, eventType: 'created',
        workspaceId: input.publisherWorkspaceId, actorId: input.createdBy, templateVersion: 1,
        templateHash: source.definitionHash, occurredAt: input.createdAt,
      });
      return Object.freeze({
        templateId: input.templateId, version: 1, sourcePipelineVersion: source.version,
        definition: source.definition, definitionHash: source.definitionHash, changelog: input.changelog,
        createdBy: input.createdBy, createdAt: input.createdAt,
      });
    });
  }

  async publishVersion(input: PublishPipelineTemplateVersionInput): Promise<PipelineTemplateVersion> {
    validateInput(input);
    return transaction(this.db, () => {
      const row = this.db.prepare(`SELECT current_version FROM build_pipeline_templates
        WHERE template_id = ? AND publisher_workspace_id = ? AND status = 'active'`).get(input.templateId, input.publisherWorkspaceId) as { current_version: number } | undefined;
      if (!row) throw new Error('Pipeline template not found, inactive or not owned by this workspace.');
      const version = Number(row.current_version) + 1;
      const source = input.source;
      this.db.prepare(`INSERT INTO build_pipeline_template_versions
        (template_id, version, source_pipeline_version, definition_json, definition_hash, changelog, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.templateId, version, source.version, JSON.stringify(source.definition), source.definitionHash,
        input.changelog, input.createdBy, input.createdAt,
      );
      this.db.prepare('UPDATE build_pipeline_templates SET current_version = ? WHERE template_id = ?').run(version, input.templateId);
      this.writeEvent({
        eventId: randomUUID(), templateId: input.templateId, eventType: 'version_published',
        workspaceId: input.publisherWorkspaceId, actorId: input.createdBy, templateVersion: version,
        templateHash: source.definitionHash, occurredAt: input.createdAt,
      });
      return Object.freeze({
        templateId: input.templateId, version, sourcePipelineVersion: source.version,
        definition: source.definition, definitionHash: source.definitionHash, changelog: input.changelog,
        createdBy: input.createdBy, createdAt: input.createdAt,
      });
    });
  }

  async getTemplate(templateId: string): Promise<PipelineTemplate | null> {
    const row = this.db.prepare('SELECT * FROM build_pipeline_templates WHERE template_id = ?').get(templateId) as TemplateRow | undefined;
    return row ? templateFromRow(row) : null;
  }

  async getVersion(templateId: string, version: number): Promise<PipelineTemplateVersion | null> {
    const row = this.db.prepare('SELECT * FROM build_pipeline_template_versions WHERE template_id = ? AND version = ?').get(templateId, version) as TemplateVersionRow | undefined;
    return row ? versionFromRow(row) : null;
  }

  async listAccessible(workspaceId: string): Promise<readonly PipelineTemplate[]> {
    const rows = this.db.prepare(`SELECT DISTINCT t.* FROM build_pipeline_templates t
      LEFT JOIN build_pipeline_template_grants g ON g.template_id = t.template_id AND g.target_workspace_id = ? AND g.revoked_at IS NULL
      WHERE t.status IN ('active', 'deprecated') AND (t.publisher_workspace_id = ? OR (t.visibility = 'shared' AND g.template_id IS NOT NULL))
      ORDER BY t.created_at DESC`).all(workspaceId, workspaceId) as unknown as TemplateRow[];
    return Object.freeze(rows.map(templateFromRow));
  }

  async canAccess(templateId: string, workspaceId: string): Promise<boolean> {
    const row = this.db.prepare(`SELECT t.template_id FROM build_pipeline_templates t
      LEFT JOIN build_pipeline_template_grants g ON g.template_id = t.template_id AND g.target_workspace_id = ? AND g.revoked_at IS NULL
      WHERE t.template_id = ? AND t.status IN ('active', 'deprecated')
        AND (t.publisher_workspace_id = ? OR (t.visibility = 'shared' AND g.template_id IS NOT NULL))`).get(workspaceId, templateId, workspaceId);
    return row !== undefined;
  }

  async grant(templateId: string, publisherWorkspaceId: string, targetWorkspaceId: string, actorId: string, createdAt: string): Promise<void> {
    transaction(this.db, () => {
      const owner = this.db.prepare(`UPDATE build_pipeline_templates SET visibility = 'shared'
        WHERE template_id = ? AND publisher_workspace_id = ? AND status = 'active'`).run(templateId, publisherWorkspaceId);
      if (Number(owner.changes) !== 1) throw new Error('Pipeline template not found, inactive or not owned by this workspace.');
      this.db.prepare(`INSERT INTO build_pipeline_template_grants (template_id, target_workspace_id, granted_by, created_at, revoked_at, revoked_by)
        VALUES (?, ?, ?, ?, NULL, NULL)
        ON CONFLICT (template_id, target_workspace_id) DO UPDATE SET granted_by = excluded.granted_by, created_at = excluded.created_at, revoked_at = NULL, revoked_by = NULL`)
        .run(templateId, targetWorkspaceId, actorId, createdAt);
      this.writeEvent({
        eventId: randomUUID(), templateId, eventType: 'share_granted', workspaceId: publisherWorkspaceId,
        actorId, targetWorkspaceId, occurredAt: createdAt,
      });
    });
  }

  async revoke(templateId: string, publisherWorkspaceId: string, targetWorkspaceId: string, actorId: string, revokedAt: string): Promise<void> {
    transaction(this.db, () => {
      const owner = this.db.prepare('SELECT template_id FROM build_pipeline_templates WHERE template_id = ? AND publisher_workspace_id = ?').get(templateId, publisherWorkspaceId);
      if (!owner) throw new Error('Pipeline template not found or not owned by this workspace.');
      const result = this.db.prepare(`UPDATE build_pipeline_template_grants SET revoked_at = ?, revoked_by = ?
        WHERE template_id = ? AND target_workspace_id = ? AND revoked_at IS NULL`).run(revokedAt, actorId, templateId, targetWorkspaceId);
      if (Number(result.changes) > 0) this.writeEvent({
        eventId: randomUUID(), templateId, eventType: 'share_revoked', workspaceId: publisherWorkspaceId,
        actorId, targetWorkspaceId, occurredAt: revokedAt,
      });
    });
  }

  async setStatus(templateId: string, publisherWorkspaceId: string, status: 'deprecated' | 'revoked', actorId: string, occurredAt: string): Promise<void> {
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT status FROM build_pipeline_templates WHERE template_id = ? AND publisher_workspace_id = ?').get(templateId, publisherWorkspaceId) as { status: PipelineTemplateStatus } | undefined;
      if (!row || row.status === 'revoked') throw new Error('Pipeline template not found or already revoked.');
      if (row.status === status) return;
      this.db.prepare('UPDATE build_pipeline_templates SET status = ? WHERE template_id = ?').run(status, templateId);
      this.writeEvent({
        eventId: randomUUID(), templateId, eventType: status, workspaceId: publisherWorkspaceId,
        actorId, occurredAt,
      });
    });
  }

  async listEvents(templateId: string, workspaceId: string): Promise<readonly PipelineTemplateEvent[]> {
    const rows = this.db.prepare(`SELECT * FROM build_pipeline_template_events
      WHERE template_id = ? AND (workspace_id = ? OR target_workspace_id = ?)
      ORDER BY occurred_at, event_id`).all(templateId, workspaceId, workspaceId) as unknown as TemplateEventRow[];
    return Object.freeze(rows.map(eventFromRow));
  }
}

export class PostgresPipelineTemplateStore implements PipelineTemplateStore {
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }

  private async writeEvent(conn: { query: SqlPool['query'] extends (...args: never[]) => infer R ? (...args: never[]) => R : never }, input: Omit<PipelineTemplateEvent, 'metadata'> & { metadata?: Readonly<Record<string, unknown>> }): Promise<void> {
    await conn.query(`INSERT INTO build_pipeline_template_events
      (event_id, template_id, event_type, workspace_id, actor_id, target_workspace_id, template_version, template_hash, occurred_at, metadata_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
      input.eventId, input.templateId, input.eventType, input.workspaceId, input.actorId,
      input.targetWorkspaceId ?? null, input.templateVersion ?? null, input.templateHash ?? null,
      input.occurredAt, JSON.stringify(input.metadata ?? {}),
    ]);
  }

  async create(input: CreatePipelineTemplateInput): Promise<PipelineTemplateVersion> {
    validateInput(input);
    return withTransaction(this.pool, async (conn) => {
      const source = input.source;
      await conn.query(`INSERT INTO build_pipeline_templates
        (template_id, publisher_workspace_id, source_pipeline_id, name, description, visibility, status, created_by, created_at, current_version)
        VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, 1)`, [
        input.templateId, input.publisherWorkspaceId, source.pipelineId, input.name, input.description ?? null,
        input.visibility, input.createdBy, input.createdAt,
      ]);
      await conn.query(`INSERT INTO build_pipeline_template_versions
        (template_id, version, source_pipeline_version, definition_json, definition_hash, changelog, created_by, created_at)
        VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`, [
        input.templateId, source.version, JSON.stringify(source.definition), source.definitionHash, input.changelog, input.createdBy, input.createdAt,
      ]);
      await this.writeEvent(conn, {
        eventId: randomUUID(), templateId: input.templateId, eventType: 'created',
        workspaceId: input.publisherWorkspaceId, actorId: input.createdBy, templateVersion: 1,
        templateHash: source.definitionHash, occurredAt: input.createdAt,
      });
      return Object.freeze({
        templateId: input.templateId, version: 1, sourcePipelineVersion: source.version,
        definition: source.definition, definitionHash: source.definitionHash, changelog: input.changelog,
        createdBy: input.createdBy, createdAt: input.createdAt,
      });
    });
  }

  async publishVersion(input: PublishPipelineTemplateVersionInput): Promise<PipelineTemplateVersion> {
    validateInput(input);
    return withTransaction(this.pool, async (conn) => {
      const result = await conn.query<{ current_version: number | string }>(`SELECT current_version FROM build_pipeline_templates
        WHERE template_id = $1 AND publisher_workspace_id = $2 AND status = 'active' FOR UPDATE`, [input.templateId, input.publisherWorkspaceId]);
      const row = result.rows[0];
      if (!row) throw new Error('Pipeline template not found, inactive or not owned by this workspace.');
      const version = Number(row.current_version) + 1;
      const source = input.source;
      await conn.query(`INSERT INTO build_pipeline_template_versions
        (template_id, version, source_pipeline_version, definition_json, definition_hash, changelog, created_by, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        input.templateId, version, source.version, JSON.stringify(source.definition), source.definitionHash, input.changelog, input.createdBy, input.createdAt,
      ]);
      await conn.query('UPDATE build_pipeline_templates SET current_version = $1 WHERE template_id = $2', [version, input.templateId]);
      await this.writeEvent(conn, {
        eventId: randomUUID(), templateId: input.templateId, eventType: 'version_published',
        workspaceId: input.publisherWorkspaceId, actorId: input.createdBy, templateVersion: version,
        templateHash: source.definitionHash, occurredAt: input.createdAt,
      });
      return Object.freeze({
        templateId: input.templateId, version, sourcePipelineVersion: source.version,
        definition: source.definition, definitionHash: source.definitionHash, changelog: input.changelog,
        createdBy: input.createdBy, createdAt: input.createdAt,
      });
    });
  }

  async getTemplate(templateId: string): Promise<PipelineTemplate | null> {
    const result = await this.pool.query<TemplateRow>('SELECT * FROM build_pipeline_templates WHERE template_id = $1', [templateId]);
    return result.rows[0] ? templateFromRow(result.rows[0]) : null;
  }

  async getVersion(templateId: string, version: number): Promise<PipelineTemplateVersion | null> {
    const result = await this.pool.query<TemplateVersionRow>('SELECT * FROM build_pipeline_template_versions WHERE template_id = $1 AND version = $2', [templateId, version]);
    return result.rows[0] ? versionFromRow(result.rows[0]) : null;
  }

  async listAccessible(workspaceId: string): Promise<readonly PipelineTemplate[]> {
    const result = await this.pool.query<TemplateRow>(`SELECT DISTINCT t.* FROM build_pipeline_templates t
      LEFT JOIN build_pipeline_template_grants g ON g.template_id = t.template_id AND g.target_workspace_id = $1 AND g.revoked_at IS NULL
      WHERE t.status IN ('active', 'deprecated') AND (t.publisher_workspace_id = $1 OR (t.visibility = 'shared' AND g.template_id IS NOT NULL))
      ORDER BY t.created_at DESC`, [workspaceId]);
    return Object.freeze(result.rows.map(templateFromRow));
  }

  async canAccess(templateId: string, workspaceId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT t.template_id FROM build_pipeline_templates t
      LEFT JOIN build_pipeline_template_grants g ON g.template_id = t.template_id AND g.target_workspace_id = $1 AND g.revoked_at IS NULL
      WHERE t.template_id = $2 AND t.status IN ('active', 'deprecated')
        AND (t.publisher_workspace_id = $1 OR (t.visibility = 'shared' AND g.template_id IS NOT NULL))`, [workspaceId, templateId]);
    return result.rowCount === 1;
  }

  async grant(templateId: string, publisherWorkspaceId: string, targetWorkspaceId: string, actorId: string, createdAt: string): Promise<void> {
    await withTransaction(this.pool, async (conn) => {
      const owner = await conn.query(`UPDATE build_pipeline_templates SET visibility = 'shared'
        WHERE template_id = $1 AND publisher_workspace_id = $2 AND status = 'active' RETURNING template_id`, [templateId, publisherWorkspaceId]);
      if (owner.rowCount !== 1) throw new Error('Pipeline template not found, inactive or not owned by this workspace.');
      await conn.query(`INSERT INTO build_pipeline_template_grants (template_id, target_workspace_id, granted_by, created_at, revoked_at, revoked_by)
        VALUES ($1, $2, $3, $4, NULL, NULL)
        ON CONFLICT (template_id, target_workspace_id) DO UPDATE SET granted_by = EXCLUDED.granted_by, created_at = EXCLUDED.created_at, revoked_at = NULL, revoked_by = NULL`,
      [templateId, targetWorkspaceId, actorId, createdAt]);
      await this.writeEvent(conn, {
        eventId: randomUUID(), templateId, eventType: 'share_granted', workspaceId: publisherWorkspaceId,
        actorId, targetWorkspaceId, occurredAt: createdAt,
      });
    });
  }

  async revoke(templateId: string, publisherWorkspaceId: string, targetWorkspaceId: string, actorId: string, revokedAt: string): Promise<void> {
    await withTransaction(this.pool, async (conn) => {
      const owner = await conn.query('SELECT template_id FROM build_pipeline_templates WHERE template_id = $1 AND publisher_workspace_id = $2', [templateId, publisherWorkspaceId]);
      if (owner.rowCount !== 1) throw new Error('Pipeline template not found or not owned by this workspace.');
      const updated = await conn.query('UPDATE build_pipeline_template_grants SET revoked_at = $1, revoked_by = $2 WHERE template_id = $3 AND target_workspace_id = $4 AND revoked_at IS NULL RETURNING template_id', [revokedAt, actorId, templateId, targetWorkspaceId]);
      if (updated.rowCount === 1) await this.writeEvent(conn, {
        eventId: randomUUID(), templateId, eventType: 'share_revoked', workspaceId: publisherWorkspaceId,
        actorId, targetWorkspaceId, occurredAt: revokedAt,
      });
    });
  }

  async setStatus(templateId: string, publisherWorkspaceId: string, status: 'deprecated' | 'revoked', actorId: string, occurredAt: string): Promise<void> {
    await withTransaction(this.pool, async (conn) => {
      const result = await conn.query<{ status: PipelineTemplateStatus }>('SELECT status FROM build_pipeline_templates WHERE template_id = $1 AND publisher_workspace_id = $2 FOR UPDATE', [templateId, publisherWorkspaceId]);
      const row = result.rows[0];
      if (!row || row.status === 'revoked') throw new Error('Pipeline template not found or already revoked.');
      if (row.status === status) return;
      await conn.query('UPDATE build_pipeline_templates SET status = $1 WHERE template_id = $2', [status, templateId]);
      await this.writeEvent(conn, {
        eventId: randomUUID(), templateId, eventType: status, workspaceId: publisherWorkspaceId,
        actorId, occurredAt,
      });
    });
  }

  async listEvents(templateId: string, workspaceId: string): Promise<readonly PipelineTemplateEvent[]> {
    const result = await this.pool.query<TemplateEventRow>(`SELECT * FROM build_pipeline_template_events
      WHERE template_id = $1 AND (workspace_id = $2 OR target_workspace_id = $2)
      ORDER BY occurred_at, event_id`, [templateId, workspaceId]);
    return Object.freeze(result.rows.map(eventFromRow));
  }
}
