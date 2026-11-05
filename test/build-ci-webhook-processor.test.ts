import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateBuildCiSqlite } from '../src/modules/build-ci/migrations.ts';
import { BuildCiService } from '../src/modules/build-ci/store.ts';
import { SqliteBuildCiStore } from '../src/modules/build-ci/sqlite-store.ts';
import { SqlitePipelineTemplateStore } from '../src/modules/build-ci/templates.ts';
import { SqliteWebhookDeliveryStore } from '../src/modules/build-ci/webhook-deliveries.ts';
import { WebhookDeliveryProcessor } from '../src/modules/build-ci/webhook-processor.ts';
import type { PullRequestChangedFilesResolver } from '../src/modules/build-ci/changed-files.ts';

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
      connections: { resolveForDelivery: async () => ({
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
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.pipeline_id, 'ci');
    assert.equal(runs[0]?.event_id, 'delivery-1');
    assert.equal(runs[0]?.status, 'queued');
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
      connections: { resolveForDelivery: async () => null },
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



test('webhook delivery storage redacts arbitrary failure details at the persistence boundary', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateBuildCiSqlite(db);
    const deliveries = new SqliteWebhookDeliveryStore(db);
    await deliveries.enqueue({
      connectionId: 'connection-store-redaction', provider: 'github', workspaceId: 'workspace-safe',
      repository: 'team/private', deliveryId: 'delivery-store-redaction',
      event: { kind: 'push', source: 'github:push', eventType: 'push', eventId: 'delivery-store-redaction', branch: 'main' },
      bodySha256: 'd'.repeat(64), receivedAt: '2026-11-04T11:00:00.000Z',
    });
    const claimed = await deliveries.claimNext({
      workerId: 'worker-store-redaction',
      now: '2026-11-04T11:01:00.000Z',
      leaseExpiresAt: '2026-11-04T11:02:00.000Z',
    });
    assert.ok(claimed);
    const credential = 'ghp_STORAGE_BOUNDARY_SECRET_MUST_NOT_PERSIST';
    assert.deepEqual(await deliveries.fail({
      deliveryRowId: claimed.deliveryRowId,
      workerId: 'worker-store-redaction',
      error: 'provider failure included credential ' + credential,
      failedAt: '2026-11-04T11:01:30.000Z',
      retryAt: '2026-11-04T11:03:00.000Z',
      maxAttempts: 1,
    }), { updated: true, terminal: true });
    const failed = await deliveries.find('connection-store-redaction', 'delivery-store-redaction');
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.lastError, 'Webhook delivery processing failed.');
    assert.equal(failed?.lastError?.includes(credential), false);
  } finally { db.close(); }
});

test('webhook processor never persists provider exception text that may contain credentials', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    migrateBuildCiSqlite(db);
    const deliveries = new SqliteWebhookDeliveryStore(db);
    await deliveries.enqueue({
      connectionId: 'connection-secret-leak', provider: 'github', workspaceId: 'workspace-safe',
      repository: 'team/private', deliveryId: 'delivery-secret-leak',
      event: { kind: 'push', source: 'github:push', eventType: 'push', eventId: 'delivery-secret-leak', branch: 'main' },
      bodySha256: 'c'.repeat(64), receivedAt: '2026-11-04T11:00:00.000Z',
    });
    const credential = 'ghp_SUPER_SECRET_TEST_CREDENTIAL_DO_NOT_PERSIST';
    const processor = new WebhookDeliveryProcessor({
      deliveries,
      buildCi: new BuildCiService({
        store: new SqliteBuildCiStore(db), templates: new SqlitePipelineTemplateStore(db), authorize: async () => true,
      }),
      connections: {
        resolveForDelivery: async () => { throw new Error('provider lookup failed using token ' + credential); },
      },
      now: () => Date.parse('2026-11-04T11:01:00.000Z'),
      retryBaseMs: 1_000,
    });

    const result = await processor.processNext('worker-secret-test');
    assert.equal(result.claimed, true);
    assert.equal(result.processed, false);
    const delivery = await deliveries.find('connection-secret-leak', 'delivery-secret-leak');
    assert.equal(delivery?.status, 'queued');
    assert.equal(delivery?.lastError, 'Webhook delivery processing failed.');
    assert.equal(delivery?.lastError?.includes(credential), false);
  } finally { db.close(); }
});


test('webhook processor uses complete PR file lists and fails open when provider diffs are incomplete', async () => {
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
      workspaceId: 'workspace-pr', actorId: 'workspace-service',
      definition: {
        id: 'pr-quality', name: 'PR quality',
        triggers: [{ id: 'pr-main', kind: 'pull_request', branches: ['main'], paths: ['src/**'] }],
        steps: [{ id: 'verify', task: 'quality.verify' }],
      },
    });
    const deliveries = new SqliteWebhookDeliveryStore(db);
    for (const number of [17, 18]) {
      await deliveries.enqueue({
        connectionId: 'github-pr-connection', provider: 'github', workspaceId: 'workspace-pr',
        repository: 'team/api', deliveryId: 'delivery-pr-' + number,
        event: {
          kind: 'pull_request', source: 'github:pull_request', eventType: 'pull_request',
          eventId: 'delivery-pr-' + number, branch: 'feature/change', baseBranch: 'main', pullRequestNumber: number,
        },
        bodySha256: number === 17 ? 'a'.repeat(64) : 'b'.repeat(64),
        receivedAt: number === 17 ? '2026-11-05T11:00:00.000Z' : '2026-11-05T11:00:01.000Z',
      });
    }
    const changedFiles: PullRequestChangedFilesResolver = {
      resolve: async (input) => {
        assert.equal(input.connectionId, 'github-pr-connection');
        assert.equal(input.repository, 'team/api');
        return input.pullRequestNumber === 17
          ? { paths: ['README.md'], complete: true }
          : { paths: ['README.md'], complete: false, reason: 'provider_limit' };
      },
    };
    const processor = new WebhookDeliveryProcessor({
      deliveries,
      buildCi,
      changedFiles,
      connections: {
        resolveForDelivery: async () => ({
          connectionId: 'github-pr-connection', provider: 'github', workspaceId: 'workspace-pr',
          actorId: 'workspace-service', repository: 'team/api', active: true,
        }),
      },
      now: () => Date.parse('2026-11-05T11:01:00.000Z'),
    });

    const complete = await processor.processNext('worker-pr');
    assert.equal(complete.processed, true);
    assert.equal(complete.runsQueued, 0, 'a complete non-matching file list must remain a no-match');

    const incomplete = await processor.processNext('worker-pr');
    assert.equal(incomplete.processed, true);
    assert.equal(incomplete.runsQueued, 1, 'an incomplete file list must fail open and queue the required pipeline');

    const runs = db.prepare('SELECT event_id, status FROM build_pipeline_runs').all() as { event_id: string; status: string }[];
    assert.deepEqual(runs.map((run) => ({ event_id: run.event_id, status: run.status })), [
      { event_id: 'delivery-pr-18', status: 'queued' },
    ]);
    assert.equal((await deliveries.find('github-pr-connection', 'delivery-pr-17'))?.status, 'processed');
    assert.equal((await deliveries.find('github-pr-connection', 'delivery-pr-18'))?.status, 'processed');
  } finally { db.close(); }
});
