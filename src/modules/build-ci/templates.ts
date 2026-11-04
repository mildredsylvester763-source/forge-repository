import { createPipelineVersion, type PipelineDefinition, type PipelineVersion } from './pipeline.ts';
import { transaction, type Database } from '../../kernel/sqlite.ts';
import { withTransaction, type SqlPool } from '../../kernel/sql.ts';

export type PipelineTemplateVisibility = 'workspace' | 'shared';
export type PipelineTemplateStatus = 'active' | 'deprecated' | 'revoked';

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
  revoke(templateId: string, publisherWorkspaceId: string, targetWorkspaceId: string, revokedAt: string): Promise<void>;
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

function validateInput(input: { templateId: string; publisherWorkspaceId: string; name?: string; changelog?: string; createdBy: string; createdAt: string }): void {
  for (const [field, value] of Object.entries(input)) {
    const max = field === 'changelog' ? 2000 : field === 'description' ? 1000 : field === 'name' ? 100 : 128;
    if (typeof value === 'string' && (value.trim().length === 0 || value.length > max)) throw new TypeError(`${field} is invalid`);
  }
}

export class SqlitePipelineTemplateStore implements PipelineTemplateStore {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }

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
      if (!row) throw new Error('Pipeline template not found or not owned by this workspace.');
      const version = Number(row.current_version) + 1;
      const source = input.source;
      this.db.prepare(`INSERT INTO build_pipeline_template_versions
        (template_id, version, source_pipeline_version, definition_json, definition_hash, changelog, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.templateId, version, source.version, JSON.stringify(source.definition), source.definitionHash,
        input.changelog, input.createdBy, input.createdAt,
      );
      this.db.prepare('UPDATE build_pipeline_templates SET current_version = ? WHERE template_id = ?').run(version, input.templateId);
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
      WHERE t.status = 'active' AND (t.publisher_workspace_id = ? OR (t.visibility = 'shared' AND g.template_id IS NOT NULL))
      ORDER BY t.created_at DESC`).all(workspaceId, workspaceId) as unknown as TemplateRow[];
    return Object.freeze(rows.map(templateFromRow));
  }

  async canAccess(templateId: string, workspaceId: string): Promise<boolean> {
    const row = this.db.prepare(`SELECT t.template_id FROM build_pipeline_templates t
      LEFT JOIN build_pipeline_template_grants g ON g.template_id = t.template_id AND g.target_workspace_id = ? AND g.revoked_at IS NULL
      WHERE t.template_id = ? AND t.status = 'active'
        AND (t.publisher_workspace_id = ? OR (t.visibility = 'shared' AND g.template_id IS NOT NULL))`).get(workspaceId, templateId, workspaceId);
    return row !== undefined;
  }

  async grant(templateId: string, publisherWorkspaceId: string, targetWorkspaceId: string, actorId: string, createdAt: string): Promise<void> {
    transaction(this.db, () => {
      const owner = this.db.prepare(`UPDATE build_pipeline_templates SET visibility = 'shared'
        WHERE template_id = ? AND publisher_workspace_id = ? AND status = 'active'`).run(templateId, publisherWorkspaceId);
      if (Number(owner.changes) !== 1) throw new Error('Pipeline template not found or not owned by this workspace.');
      this.db.prepare(`INSERT INTO build_pipeline_template_grants (template_id, target_workspace_id, granted_by, created_at, revoked_at)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT (template_id, target_workspace_id) DO UPDATE SET granted_by = excluded.granted_by, created_at = excluded.created_at, revoked_at = NULL`)
        .run(templateId, targetWorkspaceId, actorId, createdAt);
    });
  }

  async revoke(templateId: string, publisherWorkspaceId: string, targetWorkspaceId: string, revokedAt: string): Promise<void> {
    transaction(this.db, () => {
      const owner = this.db.prepare('SELECT template_id FROM build_pipeline_templates WHERE template_id = ? AND publisher_workspace_id = ?').get(templateId, publisherWorkspaceId);
      if (!owner) throw new Error('Pipeline template not found or not owned by this workspace.');
      this.db.prepare('UPDATE build_pipeline_template_grants SET revoked_at = ? WHERE template_id = ? AND target_workspace_id = ? AND revoked_at IS NULL')
        .run(revokedAt, templateId, targetWorkspaceId);
    });
  }
}

export class PostgresPipelineTemplateStore implements PipelineTemplateStore {
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }

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
      if (!row) throw new Error('Pipeline template not found or not owned by this workspace.');
      const version = Number(row.current_version) + 1;
      const source = input.source;
      await conn.query(`INSERT INTO build_pipeline_template_versions
        (template_id, version, source_pipeline_version, definition_json, definition_hash, changelog, created_by, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        input.templateId, version, source.version, JSON.stringify(source.definition), source.definitionHash, input.changelog, input.createdBy, input.createdAt,
      ]);
      await conn.query('UPDATE build_pipeline_templates SET current_version = $1 WHERE template_id = $2', [version, input.templateId]);
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
      WHERE t.status = 'active' AND (t.publisher_workspace_id = $1 OR (t.visibility = 'shared' AND g.template_id IS NOT NULL))
      ORDER BY t.created_at DESC`, [workspaceId]);
    return Object.freeze(result.rows.map(templateFromRow));
  }

  async canAccess(templateId: string, workspaceId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT t.template_id FROM build_pipeline_templates t
      LEFT JOIN build_pipeline_template_grants g ON g.template_id = t.template_id AND g.target_workspace_id = $1 AND g.revoked_at IS NULL
      WHERE t.template_id = $2 AND t.status = 'active'
        AND (t.publisher_workspace_id = $1 OR (t.visibility = 'shared' AND g.template_id IS NOT NULL))`, [workspaceId, templateId]);
    return result.rowCount === 1;
  }

  async grant(templateId: string, publisherWorkspaceId: string, targetWorkspaceId: string, actorId: string, createdAt: string): Promise<void> {
    await withTransaction(this.pool, async (conn) => {
      const owner = await conn.query(`UPDATE build_pipeline_templates SET visibility = 'shared'
        WHERE template_id = $1 AND publisher_workspace_id = $2 AND status = 'active' RETURNING template_id`, [templateId, publisherWorkspaceId]);
      if (owner.rowCount !== 1) throw new Error('Pipeline template not found or not owned by this workspace.');
      await conn.query(`INSERT INTO build_pipeline_template_grants (template_id, target_workspace_id, granted_by, created_at, revoked_at)
        VALUES ($1, $2, $3, $4, NULL)
        ON CONFLICT (template_id, target_workspace_id) DO UPDATE SET granted_by = EXCLUDED.granted_by, created_at = EXCLUDED.created_at, revoked_at = NULL`,
      [templateId, targetWorkspaceId, actorId, createdAt]);
    });
  }

  async revoke(templateId: string, publisherWorkspaceId: string, targetWorkspaceId: string, revokedAt: string): Promise<void> {
    await withTransaction(this.pool, async (conn) => {
      const owner = await conn.query('SELECT template_id FROM build_pipeline_templates WHERE template_id = $1 AND publisher_workspace_id = $2', [templateId, publisherWorkspaceId]);
      if (owner.rowCount !== 1) throw new Error('Pipeline template not found or not owned by this workspace.');
      await conn.query('UPDATE build_pipeline_template_grants SET revoked_at = $1 WHERE template_id = $2 AND target_workspace_id = $3 AND revoked_at IS NULL', [revokedAt, templateId, targetWorkspaceId]);
    });
  }
}
