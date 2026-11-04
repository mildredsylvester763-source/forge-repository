import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateBuildCiSqlite } from '../src/modules/build-ci/migrations.ts';
import { BuildCiService } from '../src/modules/build-ci/store.ts';
import { SqliteBuildCiStore } from '../src/modules/build-ci/sqlite-store.ts';
import { SqlitePipelineTemplateStore } from '../src/modules/build-ci/templates.ts';
import { SqliteWebhookDeliveryStore } from '../src/modules/build-ci/webhook-deliveries.ts';
import { WebhookDeliveryProcessor } from '../src/modules/build-ci/webhook-processor.ts';

test('webhook processor re-resolves trusted connection and queues matching pipeline runs idempotently', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    migrateBuildCiSqlite(db);
    const buildCi = new BuildCiService({
      store: new SqliteBuildCiStore(db),
      templates: new SqlitePipelineTemplateStore(db),
      authorize: async (request) => request.actorId === 'workspace-service',
    });
    await buildCi.createPipeline({
      workspaceId: 'workspace-1', actorId: 'workspace-service',
      definition: {
        id: 'ci', name: 'CI',
        triggers: [{ id: 'push-main', kind: 'push', branches: ['main'] }],
        steps: [{ id: 'build', task: 'build' }],
      },
    });
    const deliveries = new SqliteWebhookDeliveryStore(db);
    await deliveries.enqueue({
      connectionId: 'connection-1', provider: 'github', workspaceId: 'workspace-1',
      repository: 'team/api', deliveryId: 'delivery-1',
      event: { kind: 'push', source: 'github:push', eventType: 'push', eventId: 'delivery-1', branch: 'main' },
      bodySha256: 'a'.repeat(64), receivedAt: '2026-11-04T11:00:00.000Z',
    });
    const processor = new WebhookDeliveryProcessor({
      deliveries, buildCi,
      connections: { resolve: async () => ({
        connectionId: 'connection-1', provider: 'github', workspaceId: 'workspace-1',
        actorId: 'workspace-service', repository: 'team/api', signingSecret: 'not-used-by-worker', active: true,
      }) },
      now: () => Date.parse('2026-11-04T11:01:00.000Z'),
    });
    const result = await processor.processNext('worker-1');
    assert.equal(result.claimed, true);
    assert.equal(result.processed, true);
    assert.equal(result.pipelinesConsidered, 1);
    assert.equal(result.runsQueued, 1);
    assert.equal(result.duplicateRuns, 0);
    assert.equal((await processor.processNext('worker-2')).claimed, false);
    const runs = db.prepare('SELECT pipeline_id, event_id, status FROM build_pipeline_runs').all();
    assert.deepEqual(runs, [{ pipeline_id: 'ci', event_id: 'delivery-1', status: 'queued' }]);
    assert.equal((await deliveries.find('connection-1', 'delivery-1'))?.status, 'processed');
  } finally { db.close(); }
});

test('webhook processor retries when trusted connection is unavailable', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    migrateBuildCiSqlite(db);
    const deliveries = new SqliteWebhookDeliveryStore(db);
    await deliveries.enqueue({
      connectionId: 'connection-2', provider: 'github', workspaceId: 'workspace-2',
      repository: 'team/web', deliveryId: 'delivery-2',
      event: { kind: 'push', source: 'github:push', eventType: 'push', eventId: 'delivery-2', branch: 'main' },
      bodySha256: 'b'.repeat(64), receivedAt: '2026-11-04T11:00:00.000Z',
    });
    const processor = new WebhookDeliveryProcessor({
      deliveries,
      buildCi: new BuildCiService({
        store: new SqliteBuildCiStore(db), templates: new SqlitePipelineTemplateStore(db), authorize: async () => true,
      }),
      connections: { resolve: async () => null },
      now: () => Date.parse('2026-11-04T11:01:00.000Z'),
      retryBaseMs: 1_000,
    });
    const result = await processor.processNext('worker-1');
    assert.equal(result.claimed, true);
    assert.equal(result.processed, false);
    assert.equal(result.retryScheduled, true);
    const delivery = await deliveries.find('connection-2', 'delivery-2');
    assert.equal(delivery?.status, 'queued');
    assert.equal(delivery?.attempts, 1);
    assert.ok(delivery?.nextAttemptAt);
  } finally { db.close(); }
});
