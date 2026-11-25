import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import { identityMigrations } from '../src/modules/identity/migrations.ts';
import { AgentCredentialService, SqliteAgentCredentialStore } from '../src/modules/identity/agent-credentials.ts';

const config = {
  allowedScopes: ['identity:read', 'identity:session:revoke'],
  minimumTtlMs: 60_000,
  maximumTtlMs: 86_400_000,
};

describe('CO-011 scoped agent credential lifecycle', () => {
  it('issues opaque hashed credentials bound to an agent, tenant and explicit scopes', async () => {
    const db = openDatabase(':memory:');
    const now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      const service = new AgentCredentialService({
        store: new SqliteAgentCredentialStore(db),
        clock: () => now,
        config,
      });
      const issued = await service.issue('agent-1', 'tenant-1', ['identity:read'], 3_600_000);
      assert.match(issued.token, /^fg_agent_[A-Za-z0-9_-]{43}$/);
      const row = db.prepare('SELECT token_hash, token_prefix, scopes_json FROM agent_credentials WHERE credential_id = ?')
        .get(issued.credentialId) as { token_hash: string; token_prefix: string; scopes_json: string };
      assert.equal(row.token_hash.length, 64);
      assert.equal(row.token_hash.includes(issued.token), false);
      assert.equal(row.token_prefix, issued.token.slice(0, 20));
      assert.deepEqual(JSON.parse(row.scopes_json), ['identity:read']);
      assert.deepEqual(await service.authenticate(issued.token, 'tenant-1'), {
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        credentialId: issued.credentialId,
        scopes: ['identity:read'],
      });
      assert.equal(await service.authenticate(issued.token, 'tenant-2'), null);
      assert.equal(await service.authenticate('malformed', 'tenant-1'), null);
    } finally {
      db.close();
    }
  });

  it('rotates credentials atomically and invalidates the previous token', async () => {
    const db = openDatabase(':memory:');
    const now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      const service = new AgentCredentialService({
        store: new SqliteAgentCredentialStore(db),
        clock: () => now,
        config,
      });
      const old = await service.issue('agent-2', 'tenant-1', ['identity:read'], 3_600_000);
      const rotated = await service.rotate('agent-2', 'tenant-1', old.credentialId, ['identity:read', 'identity:session:revoke'], 3_600_000);
      assert.ok(rotated);
      assert.equal(await service.authenticate(old.token, 'tenant-1'), null);
      assert.deepEqual((await service.authenticate(rotated!.token, 'tenant-1'))?.scopes, [
        'identity:read', 'identity:session:revoke',
      ]);
      assert.equal(await service.rotate('agent-2', 'tenant-1', old.credentialId, ['identity:read'], 3_600_000), null);
    } finally {
      db.close();
    }
  });

  it('revokes one credential or all credentials for an agent within the tenant boundary', async () => {
    const db = openDatabase(':memory:');
    const now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      const service = new AgentCredentialService({
        store: new SqliteAgentCredentialStore(db),
        clock: () => now,
        config,
      });
      const one = await service.issue('agent-3', 'tenant-1', ['identity:read'], 3_600_000);
      const two = await service.issue('agent-3', 'tenant-1', ['identity:read'], 3_600_000);
      assert.equal(await service.revoke('agent-3', 'tenant-2', one.credentialId), false);
      assert.equal(await service.revoke('agent-3', 'tenant-1', one.credentialId), true);
      assert.equal(await service.authenticate(one.token, 'tenant-1'), null);
      assert.equal(await service.revokeAll('agent-3', 'tenant-1'), 1);
      assert.equal(await service.authenticate(two.token, 'tenant-1'), null);
    } finally {
      db.close();
    }
  });

  it('rejects expired credentials and unapproved scopes or lifetimes', async () => {
    const db = openDatabase(':memory:');
    let now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      const service = new AgentCredentialService({
        store: new SqliteAgentCredentialStore(db),
        clock: () => now,
        config,
      });
      const issued = await service.issue('agent-4', 'tenant-1', ['identity:read'], 60_000);
      now += 60_000;
      assert.equal(await service.authenticate(issued.token, 'tenant-1'), null);
      await assert.rejects(() => service.issue('agent-4', 'tenant-1', ['identity:admin'], 60_000), /not allowed/);
      await assert.rejects(() => service.issue('agent-4', 'tenant-1', ['identity:read'], 30_000), /outside the configured policy/);
      await assert.rejects(() => service.issue('agent-4', 'tenant-1', [], 60_000), /scopes are missing/);
    } finally {
      db.close();
    }
  });
});
