import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateBuildCiSqlite } from '../src/modules/build-ci/migrations.ts';
import { SqliteProviderConnectionStore, StoredWebhookConnectionResolver } from '../src/modules/build-ci/provider-connections.ts';

test('provider metadata uses an opaque vault reference and revocation disables both resolver paths', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateBuildCiSqlite(db);
    const store = new SqliteProviderConnectionStore(db);
    const created = await store.create({ connectionId: 'github-installation-1', provider: 'github',
      workspaceId: 'workspace-alpha', actorId: 'workspace-service-1', repository: 'team/private-api',
      secretRef: 'vault://forge/workspaces/alpha/github/webhook', createdAt: '2026-11-04T12:00:00.000Z' });
    assert.equal(created.active, true);
    assert.equal(created.secretRef, 'vault://forge/workspaces/alpha/github/webhook');
    assert.equal(await store.rotateSecretReference('github', 'github-installation-1',
      'vault://forge/workspaces/alpha/github/webhook', 'vault://forge/workspaces/alpha/github/webhook-v2',
      '2026-11-04T12:01:00.000Z', 'workspace-service-1'), true);
    assert.equal(await store.rotateSecretReference('github', 'github-installation-1',
      'vault://forge/workspaces/alpha/github/webhook', 'vault://forge/workspaces/alpha/github/webhook-v3',
      '2026-11-04T12:02:00.000Z', 'workspace-service-1'), false, 'stale rotation must not overwrite a newer secret reference');
    const columns = db.prepare('PRAGMA table_info(build_ci_provider_connections)').all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => /secret_value|signing_secret|token_value/i.test(column.name)), false);
    let vaultCalls = 0;
    const resolver = new StoredWebhookConnectionResolver(store, { resolve: async (reference) => {
      vaultCalls += 1; assert.equal(reference, 'vault://forge/workspaces/alpha/github/webhook-v2'); return 'actual-signing-secret';
    } });
    assert.equal((await resolver.resolveForIngress('github', 'github-installation-1'))?.signingSecret, 'actual-signing-secret');
    const delivery = await resolver.resolveForDelivery('github', 'github-installation-1');
    assert.equal(delivery?.actorId, 'workspace-service-1');
    assert.equal('signingSecret' in (delivery ?? {}), false);
    assert.equal(vaultCalls, 1, 'delivery lookup must not call the vault');
    assert.equal((await store.find('github', 'github-installation-1'))?.secretRef,
      'vault://forge/workspaces/alpha/github/webhook-v2');
    assert.equal(await store.revoke('github', 'github-installation-1', '2026-11-04T12:05:00.000Z', 'workspace-service-1'), true);
    assert.equal(await store.revoke('github', 'github-installation-1', '2026-11-04T12:06:00.000Z', 'workspace-service-1'), false);
    assert.equal(await resolver.resolveForIngress('github', 'github-installation-1'), null);
    assert.equal(await resolver.resolveForDelivery('github', 'github-installation-1'), null);
    assert.equal(vaultCalls, 1);
    assert.equal((await store.find('github', 'github-installation-1'))?.active, false);
  } finally { db.close(); }
});

test('provider metadata rejects inline credential values and malformed secret references', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateBuildCiSqlite(db);
    const store = new SqliteProviderConnectionStore(db);
    const base = { connectionId: 'connection-invalid', provider: 'github' as const,
      workspaceId: 'workspace-alpha', actorId: 'workspace-service-1', repository: 'team/private-api' };
    await assert.rejects(() => store.create({ ...base, secretRef: 'ghp_this-is-not-a-vault-reference' }), /workspace-scoped/);
    await assert.rejects(() => store.create({ ...base, secretRef: 'vault://forge/path?token=inline' }), /workspace-scoped/);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM build_ci_provider_connections').get() as { count: number }).count, 0);
  } finally { db.close(); }
});


test('ingress rejects a secret lookup raced by revocation or secret-reference rotation', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateBuildCiSqlite(db);
    const store = new SqliteProviderConnectionStore(db);
    const originalRef = 'vault://forge/workspaces/race/github/webhook';
    const rotatedRef = 'vault://forge/workspaces/race/github/webhook-v2';
    await store.create({ connectionId: 'race-revocation', provider: 'github', workspaceId: 'workspace-race',
      actorId: 'workspace-service-race', repository: 'team/race', secretRef: originalRef });
    const revokedResolver = new StoredWebhookConnectionResolver(store, {
      resolve: async () => {
        await store.revoke('github', 'race-revocation', '2026-11-04T12:10:00.000Z', 'workspace-service-race');
        return 'secret-read-before-revocation';
      },
    });
    assert.equal(await revokedResolver.resolveForIngress('github', 'race-revocation'), null,
      'a connection revoked while the vault is resolving must not be accepted');

    await store.create({ connectionId: 'race-rotation', provider: 'github', workspaceId: 'workspace-race',
      actorId: 'workspace-service-race', repository: 'team/race', secretRef: originalRef });
    const rotatedResolver = new StoredWebhookConnectionResolver(store, {
      resolve: async (reference) => {
        assert.equal(reference, originalRef);
        await store.rotateSecretReference('github', 'race-rotation', originalRef, rotatedRef, '2026-11-04T12:11:00.000Z', 'workspace-service-race');
        return 'secret-for-stale-reference';
      },
    });
    assert.equal(await rotatedResolver.resolveForIngress('github', 'race-rotation'), null,
      'a secret resolved for a superseded reference must not be accepted');
    assert.equal((await store.find('github', 'race-rotation'))?.secretRef, rotatedRef);
  } finally { db.close(); }
});

test('ingress rejects a persisted secret reference outside the connection workspace before vault access', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateBuildCiSqlite(db);
    const store = new SqliteProviderConnectionStore(db);
    await store.create({
      connectionId: 'scope-check',
      provider: 'github',
      workspaceId: 'workspace-alpha',
      actorId: 'workspace-service-1',
      repository: 'team/private-api',
      secretRef: 'vault://forge/workspace-alpha/github/webhook',
    });
    db.prepare(`UPDATE build_ci_provider_connections SET secret_ref = ? WHERE provider = ? AND connection_id = ?`)
      .run('vault://forge/workspace-other/github/webhook', 'github', 'scope-check');
    let vaultCalls = 0;
    const resolver = new StoredWebhookConnectionResolver(store, {
      resolve: async () => { vaultCalls += 1; return 'must-not-be-read'; },
    });
    assert.equal(await resolver.resolveForIngress('github', 'scope-check'), null);
    assert.equal(vaultCalls, 0);
  } finally {
    db.close();
  }
});
