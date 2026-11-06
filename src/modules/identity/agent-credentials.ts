import { createHash, randomBytes } from 'node:crypto';
import { withTransaction, type SqlPool } from '../../kernel/sql.ts';
import { transaction, type Database } from '../../kernel/sqlite.ts';

export interface AgentCredentialRecord {
  readonly credentialId: string;
  readonly agentId: string;
  readonly tenantId: string;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
}

export interface AgentCredentialStore {
  create(record: AgentCredentialRecord): Promise<void>;
  findByHash(tokenHash: string): Promise<AgentCredentialRecord | null>;
  touchLastUsed(credentialId: string, now: number): Promise<boolean>;
  revoke(agentId: string, tenantId: string, credentialId: string, now: number): Promise<boolean>;
  revokeAll(agentId: string, tenantId: string, now: number): Promise<number>;
  rotate(agentId: string, tenantId: string, oldCredentialId: string, record: AgentCredentialRecord, now: number): Promise<boolean>;
}

export interface AgentCredentialConfig {
  readonly allowedScopes: readonly string[];
  readonly minimumTtlMs: number;
  readonly maximumTtlMs: number;
}

interface AgentCredentialRow {
  credential_id: string;
  agent_id: string;
  tenant_id: string;
  token_hash: string;
  token_prefix: string;
  scopes_json: string;
  created_at: number | string;
  expires_at: number | string;
  revoked_at: number | string | null;
  last_used_at: number | string | null;
}

const TOKEN_PREFIX = 'fg_agent_';
const TOKEN_PATTERN = /^fg_agent_[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_SCOPES = 64;

function validateIdentity(agentId: string, tenantId: string): void {
  if (!ID_PATTERN.test(agentId) || !ID_PATTERN.test(tenantId)) throw new TypeError('Agent or tenant identifier is invalid');
}

function validateRecord(record: AgentCredentialRecord): void {
  validateIdentity(record.agentId, record.tenantId);
  if (!/^[a-f0-9]{32}$/.test(record.credentialId) || !HASH_PATTERN.test(record.tokenHash) ||
      typeof record.tokenPrefix !== 'string' || record.tokenPrefix.length < 8 || record.tokenPrefix.length > 32) {
    throw new TypeError('Agent credential metadata is invalid');
  }
  if (!Array.isArray(record.scopes) || record.scopes.length < 1 || record.scopes.length > MAX_SCOPES ||
      record.scopes.some((scope) => typeof scope !== 'string' || !/^[a-z][a-z0-9:._-]{0,95}$/.test(scope)) ||
      new Set(record.scopes).size !== record.scopes.length) {
    throw new TypeError('Agent credential scopes are invalid');
  }
  if (!Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.createdAt) {
    throw new TypeError('Agent credential expiry is invalid');
  }
}

function fromRow(row: AgentCredentialRow): AgentCredentialRecord {
  let scopes: unknown;
  try { scopes = JSON.parse(row.scopes_json); } catch { throw new Error('Stored agent credential scopes are invalid'); }
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) throw new Error('Stored agent credential scopes are invalid');
  return {
    credentialId: row.credential_id,
    agentId: row.agent_id,
    tenantId: row.tenant_id,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    scopes,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
  };
}

export class SqliteAgentCredentialStore implements AgentCredentialStore {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }

  async create(record: AgentCredentialRecord): Promise<void> {
    validateRecord(record);
    this.db.prepare(
      'INSERT INTO agent_credentials (credential_id, agent_id, tenant_id, token_hash, token_prefix, scopes_json, created_at, expires_at, revoked_at, last_used_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
    ).run(record.credentialId, record.agentId, record.tenantId, record.tokenHash, record.tokenPrefix,
      JSON.stringify(record.scopes), record.createdAt, record.expiresAt);
  }

  async findByHash(tokenHash: string): Promise<AgentCredentialRecord | null> {
    if (!HASH_PATTERN.test(tokenHash)) return null;
    const row = this.db.prepare('SELECT * FROM agent_credentials WHERE token_hash = ?').get(tokenHash) as AgentCredentialRow | undefined;
    return row ? fromRow(row) : null;
  }

  async touchLastUsed(credentialId: string, now: number): Promise<boolean> {
    return Number(this.db.prepare(
      'UPDATE agent_credentials SET last_used_at = ? WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?',
    ).run(now, credentialId, now).changes) === 1;
  }

  async revoke(agentId: string, tenantId: string, credentialId: string, now: number): Promise<boolean> {
    validateIdentity(agentId, tenantId);
    return transaction(this.db, () => Number(this.db.prepare(
      'UPDATE agent_credentials SET revoked_at = ? WHERE credential_id = ? AND agent_id = ? AND tenant_id = ? AND revoked_at IS NULL',
    ).run(now, credentialId, agentId, tenantId).changes) === 1);
  }

  async revokeAll(agentId: string, tenantId: string, now: number): Promise<number> {
    validateIdentity(agentId, tenantId);
    return transaction(this.db, () => Number(this.db.prepare(
      'UPDATE agent_credentials SET revoked_at = ? WHERE agent_id = ? AND tenant_id = ? AND revoked_at IS NULL',
    ).run(now, agentId, tenantId).changes));
  }

  async rotate(agentId: string, tenantId: string, oldCredentialId: string, record: AgentCredentialRecord, now: number): Promise<boolean> {
    validateIdentity(agentId, tenantId);
    validateRecord(record);
    if (record.agentId !== agentId || record.tenantId !== tenantId) return false;
    return transaction(this.db, () => {
      const revoked = this.db.prepare(
        'UPDATE agent_credentials SET revoked_at = ? WHERE credential_id = ? AND agent_id = ? AND tenant_id = ? AND revoked_at IS NULL AND expires_at > ?',
      ).run(now, oldCredentialId, agentId, tenantId, now);
      if (Number(revoked.changes) !== 1) return false;
      this.db.prepare(
        'INSERT INTO agent_credentials (credential_id, agent_id, tenant_id, token_hash, token_prefix, scopes_json, created_at, expires_at, revoked_at, last_used_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
      ).run(record.credentialId, record.agentId, record.tenantId, record.tokenHash, record.tokenPrefix,
        JSON.stringify(record.scopes), record.createdAt, record.expiresAt);
      return true;
    });
  }
}

export class PostgresAgentCredentialStore implements AgentCredentialStore {
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }

  async create(record: AgentCredentialRecord): Promise<void> {
    validateRecord(record);
    await this.pool.query(
      'INSERT INTO agent_credentials (credential_id, agent_id, tenant_id, token_hash, token_prefix, scopes_json, created_at, expires_at, revoked_at, last_used_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL)',
      [record.credentialId, record.agentId, record.tenantId, record.tokenHash, record.tokenPrefix,
        JSON.stringify(record.scopes), record.createdAt, record.expiresAt],
    );
  }

  async findByHash(tokenHash: string): Promise<AgentCredentialRecord | null> {
    if (!HASH_PATTERN.test(tokenHash)) return null;
    const result = await this.pool.query<AgentCredentialRow>('SELECT * FROM agent_credentials WHERE token_hash = $1', [tokenHash]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async touchLastUsed(credentialId: string, now: number): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE agent_credentials SET last_used_at = $1 WHERE credential_id = $2 AND revoked_at IS NULL AND expires_at > $1',
      [now, credentialId],
    );
    return result.rowCount === 1;
  }

  async revoke(agentId: string, tenantId: string, credentialId: string, now: number): Promise<boolean> {
    validateIdentity(agentId, tenantId);
    const result = await this.pool.query(
      'UPDATE agent_credentials SET revoked_at = $1 WHERE credential_id = $2 AND agent_id = $3 AND tenant_id = $4 AND revoked_at IS NULL',
      [now, credentialId, agentId, tenantId],
    );
    return result.rowCount === 1;
  }

  async revokeAll(agentId: string, tenantId: string, now: number): Promise<number> {
    validateIdentity(agentId, tenantId);
    const result = await this.pool.query(
      'UPDATE agent_credentials SET revoked_at = $1 WHERE agent_id = $2 AND tenant_id = $3 AND revoked_at IS NULL',
      [now, agentId, tenantId],
    );
    return result.rowCount ?? 0;
  }

  async rotate(agentId: string, tenantId: string, oldCredentialId: string, record: AgentCredentialRecord, now: number): Promise<boolean> {
    validateIdentity(agentId, tenantId);
    validateRecord(record);
    if (record.agentId !== agentId || record.tenantId !== tenantId) return false;
    return withTransaction(this.pool, async (conn) => {
      const revoked = await conn.query(
        'UPDATE agent_credentials SET revoked_at = $1 WHERE credential_id = $2 AND agent_id = $3 AND tenant_id = $4 AND revoked_at IS NULL AND expires_at > $1 RETURNING credential_id',
        [now, oldCredentialId, agentId, tenantId],
      );
      if (revoked.rowCount !== 1) return false;
      await conn.query(
        'INSERT INTO agent_credentials (credential_id, agent_id, tenant_id, token_hash, token_prefix, scopes_json, created_at, expires_at, revoked_at, last_used_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL)',
        [record.credentialId, record.agentId, record.tenantId, record.tokenHash, record.tokenPrefix,
          JSON.stringify(record.scopes), record.createdAt, record.expiresAt],
      );
      return true;
    });
  }
}

export interface AgentPrincipal {
  readonly agentId: string;
  readonly tenantId: string;
  readonly credentialId: string;
  readonly scopes: readonly string[];
}

export class AgentCredentialService {
  private readonly store: AgentCredentialStore;
  private readonly clock: () => number;
  private readonly config: AgentCredentialConfig;

  constructor(options: { store: AgentCredentialStore; clock: () => number; config: AgentCredentialConfig }) {
    if (!Array.isArray(options.config.allowedScopes) || options.config.allowedScopes.length > MAX_SCOPES ||
        options.config.allowedScopes.some((scope) => !/^[a-z][a-z0-9:._-]{0,95}$/.test(scope)) ||
        new Set(options.config.allowedScopes).size !== options.config.allowedScopes.length) {
      throw new TypeError('Agent credential allowed scopes are invalid');
    }
    if (!Number.isSafeInteger(options.config.minimumTtlMs) || !Number.isSafeInteger(options.config.maximumTtlMs) ||
        options.config.minimumTtlMs < 60_000 || options.config.maximumTtlMs < options.config.minimumTtlMs ||
        options.config.maximumTtlMs > 31_536_000_000) {
      throw new TypeError('Agent credential TTL policy is invalid');
    }
    this.store = options.store;
    this.clock = options.clock;
    this.config = options.config;
  }

  private createRecord(agentId: string, tenantId: string, scopes: readonly string[], ttlMs: number): { token: string; record: AgentCredentialRecord } {
    validateIdentity(agentId, tenantId);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < this.config.minimumTtlMs || ttlMs > this.config.maximumTtlMs) {
      throw new TypeError('Agent credential lifetime is outside the configured policy');
    }
    if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > MAX_SCOPES ||
        new Set(scopes).size !== scopes.length ||
        scopes.some((scope) => !this.config.allowedScopes.includes(scope))) {
      throw new TypeError('Agent credential scopes are missing or not allowed');
    }
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const now = this.clock();
    const record: AgentCredentialRecord = {
      credentialId: randomBytes(16).toString('hex'),
      agentId,
      tenantId,
      tokenHash: createHash('sha256').update(token, 'ascii').digest('hex'),
      tokenPrefix: token.slice(0, 20),
      scopes: [...scopes].sort(),
      createdAt: now,
      expiresAt: now + ttlMs,
      revokedAt: null,
      lastUsedAt: null,
    };
    return { token, record };
  }

  async issue(agentId: string, tenantId: string, scopes: readonly string[], ttlMs: number): Promise<{ credentialId: string; token: string; expiresAt: number }> {
    const created = this.createRecord(agentId, tenantId, scopes, ttlMs);
    await this.store.create(created.record);
    return { credentialId: created.record.credentialId, token: created.token, expiresAt: created.record.expiresAt };
  }

  async rotate(agentId: string, tenantId: string, oldCredentialId: string, scopes: readonly string[], ttlMs: number): Promise<{ credentialId: string; token: string; expiresAt: number } | null> {
    const created = this.createRecord(agentId, tenantId, scopes, ttlMs);
    if (!await this.store.rotate(agentId, tenantId, oldCredentialId, created.record, this.clock())) return null;
    return { credentialId: created.record.credentialId, token: created.token, expiresAt: created.record.expiresAt };
  }

  async authenticate(token: string, expectedTenantId: string): Promise<AgentPrincipal | null> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    try { validateIdentity('agent-check', expectedTenantId); } catch { return null; }
    const hash = createHash('sha256').update(token, 'ascii').digest('hex');
    const record = await this.store.findByHash(hash);
    const now = this.clock();
    if (!record || record.revokedAt !== null || record.expiresAt <= now ||
        record.tenantId !== expectedTenantId || record.scopes.length < 1 ||
        record.scopes.some((scope) => !this.config.allowedScopes.includes(scope))) return null;
    if (!await this.store.touchLastUsed(record.credentialId, now)) return null;
    return {
      agentId: record.agentId,
      tenantId: record.tenantId,
      credentialId: record.credentialId,
      scopes: record.scopes,
    };
  }

  revoke(agentId: string, tenantId: string, credentialId: string): Promise<boolean> {
    return this.store.revoke(agentId, tenantId, credentialId, this.clock());
  }

  revokeAll(agentId: string, tenantId: string): Promise<number> {
    return this.store.revokeAll(agentId, tenantId, this.clock());
  }
}
