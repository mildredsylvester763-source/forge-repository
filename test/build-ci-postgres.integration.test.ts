import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildCiService } from '../src/modules/build-ci/store.ts';
import { PostgresBuildCiStore } from '../src/modules/build-ci/postgres-store.ts';
import { PostgresPipelineTemplateStore } from '../src/modules/build-ci/templates.ts';
import { PostgresWebhookDeliveryStore } from '../src/modules/build-ci/webhook-deliveries.ts';
import { WebhookDeliveryProcessor } from '../src/modules/build-ci/webhook-processor.ts';
import { PostgresScheduleOccurrenceStore } from '../src/modules/build-ci/schedule-occurrences.ts';
import { ScheduleDispatcher } from '../src/modules/build-ci/schedule-dispatcher.ts';
import { migrateBuildCiPostgres } from '../src/modules/build-ci/migrations.ts';
import { migratePostgres } from '../src/kernel/postgres-migrate.ts';
import { createWorkspacePipelineAuthorizer, PostgresWorkspaceMembershipReader, workspaceAccessMigrations } from '../src/modules/build-ci/workspace-access.ts';

test('PostgreSQL Build & CI migrations, versioning and idempotent trigger receipts', { skip: !process.env.FORGE_TEST_POSTGRES_URL }, async () => {
  const { makeBlankRealPool } = await import('./pg-helpers.ts');
  const testPool = await makeBlankRealPool();
  try {
    await migrateBuildCiPostgres(testPool.pool);
    await migratePostgres(testPool.pool, 'workspace_access', workspaceAccessMigrations);
    await testPool.pool.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
      ['pg-workspace', 'integration-test', 'maintainer', 'active', new Date().toISOString(), new Date().toISOString()],
    );
    const authorize = createWorkspacePipelineAuthorizer(new PostgresWorkspaceMembershipReader(testPool.pool));
    assert.equal(await authorize({ workspaceId: 'pg-workspace', pipelineId: 'pipeline', actorId: 'integration-test', action: 'create' }), true);
    assert.equal(await authorize({ workspaceId: 'other-workspace', pipelineId: 'pipeline', actorId: 'integration-test', action: 'create' }), false);
    const store = new PostgresBuildCiStore(testPool.pool);
    const service = new BuildCiService({ store, templates: new PostgresPipelineTemplateStore(testPool.pool), authorize: async () => true });
    const definition = {
      id: 'postgres-build',
      name: 'PostgreSQL build',
      triggers: [{ id: 'manual', kind: 'manual' as const }],
      steps: [{ id: 'verify', task: 'quality.verify' }],
    };
    const version1 = await service.createPipeline({ workspaceId: 'pg-workspace', definition, actorId: 'integration-test' });
    const version2 = await service.createPipeline({
      workspaceId: 'pg-workspace',
      definition: { ...definition, name: 'PostgreSQL build v2' },
      actorId: 'integration-test',
    });
    const rollback = await service.rollbackPipeline({
      workspaceId: 'pg-workspace',
      pipelineId: 'postgres-build',
      targetVersion: 1,
      actorId: 'integration-test',
    });
    assert.deepEqual([version1.version, version2.version, rollback.version], [1, 2, 3]);
    assert.equal(rollback.definitionHash, version1.definitionHash);

    const templateStore = new PostgresPipelineTemplateStore(testPool.pool);
    const template = await templateStore.create({
      templateId: 'template-pg-quality',
      publisherWorkspaceId: 'pg-workspace',
      source: version1,
      name: 'PostgreSQL quality template',
      visibility: 'workspace',
      changelog: 'Initial PostgreSQL template release',
      createdBy: 'integration-test',
      createdAt: '2026-11-04T00:00:00.000Z',
    });
    assert.equal(template.version, 1);
    assert.equal(await templateStore.canAccess('template-pg-quality', 'pg-consumer'), false);
    await templateStore.grant('template-pg-quality', 'pg-workspace', 'pg-consumer', 'integration-test', '2026-11-04T00:01:00.000Z');
    assert.equal(await templateStore.canAccess('template-pg-quality', 'pg-consumer'), true);
    assert.equal((await templateStore.listAccessible('pg-consumer')).length, 1);
    const templateV2 = await templateStore.publishVersion({
      templateId: 'template-pg-quality',
      publisherWorkspaceId: 'pg-workspace',
      source: version2,
      changelog: 'Updated pipeline template',
      createdBy: 'integration-test',
      createdAt: '2026-11-04T00:02:00.000Z',
    });
    assert.equal(templateV2.version, 2);
    const imported = await store.importTemplate({
      workspaceId: 'pg-consumer',
      templateId: 'template-pg-quality',
      templateVersion: templateV2.version,
      pipelineId: 'pg-imported-quality',
      createdBy: 'integration-test',
    });
    const importedRead = await store.getLatestVersion('pg-consumer', 'pg-imported-quality');
    assert.deepEqual(importedRead?.templateSource, imported.templateSource);
    await templateStore.revoke('template-pg-quality', 'pg-workspace', 'pg-consumer', 'integration-test', '2026-11-04T00:03:00.000Z');
    assert.equal(await templateStore.canAccess('template-pg-quality', 'pg-consumer'), false);
    await assert.rejects(() => store.importTemplate({
      workspaceId: 'pg-consumer', templateId: 'template-pg-quality', templateVersion: 2,
      pipelineId: 'pg-blocked-after-revoke', createdBy: 'integration-test',
    }));
    await templateStore.setStatus('template-pg-quality', 'pg-workspace', 'deprecated', 'integration-test', '2026-11-04T00:04:00.000Z');
    assert.equal(await templateStore.canAccess('template-pg-quality', 'pg-workspace'), true);
    await templateStore.setStatus('template-pg-quality', 'pg-workspace', 'revoked', 'integration-test', '2026-11-04T00:05:00.000Z');
    assert.equal(await templateStore.canAccess('template-pg-quality', 'pg-workspace'), false);
    const templateEvents = await templateStore.listEvents('template-pg-quality', 'pg-workspace');
    assert.ok(templateEvents.some((event) => event.eventType === 'created'));
    assert.ok(templateEvents.some((event) => event.eventType === 'version_published'));
    assert.ok(templateEvents.some((event) => event.eventType === 'share_granted'));
    assert.ok(templateEvents.some((event) => event.eventType === 'share_revoked'));
    assert.ok(templateEvents.some((event) => event.eventType === 'deprecated'));
    assert.ok(templateEvents.some((event) => event.eventType === 'revoked'));
    const consumerTemplateEvents = await templateStore.listEvents('template-pg-quality', 'pg-consumer');
    assert.ok(consumerTemplateEvents.some((event) => event.eventType === 'imported'));
    await assert.rejects(() => testPool.pool.query("UPDATE build_pipeline_template_events SET actor_id = 'tampered' WHERE template_id = $1", ['template-pg-quality']));
    await assert.rejects(() => testPool.pool.query(
      "UPDATE build_pipeline_template_versions SET changelog = 'tampered' WHERE template_id = $1 AND version = 1",
      ['template-pg-quality'],
    ));

    const webhookDeliveries = new PostgresWebhookDeliveryStore(testPool.pool);
    const webhookEvent = {
      kind: 'push' as const,
      source: 'github:push',
      eventType: 'push',
      eventId: 'pg-webhook-delivery-1',
      branch: 'main',
      commitSha: 'feedface',
      changedFiles: ['src/index.ts'],
    };
    const webhookInput = {
      connectionId: 'pg-webhook-connection',
      provider: 'github' as const,
      workspaceId: 'pg-workspace',
      repository: 'team/forge',
      deliveryId: 'pg-webhook-delivery-1',
      event: webhookEvent,
      bodySha256: 'a'.repeat(64),
      receivedAt: '2026-11-04T00:10:00.000Z',
    };
    const webhookFirst = await webhookDeliveries.enqueue(webhookInput);
    const webhookDuplicate = await webhookDeliveries.enqueue(webhookInput);
    assert.equal(webhookFirst.inserted, true);
    assert.equal(webhookDuplicate.inserted, false);
    assert.equal(webhookDuplicate.deliveryRowId, webhookFirst.deliveryRowId);
    assert.deepEqual((await webhookDeliveries.find('pg-webhook-connection', 'pg-webhook-delivery-1'))?.event, webhookEvent);

    const concurrentClaims = await Promise.all([
      webhookDeliveries.claimNext({
        workerId: 'pg-worker-a', now: '2026-11-04T00:11:00.000Z', leaseExpiresAt: '2026-11-04T00:12:00.000Z',
      }),
      webhookDeliveries.claimNext({
        workerId: 'pg-worker-b', now: '2026-11-04T00:11:00.000Z', leaseExpiresAt: '2026-11-04T00:12:00.000Z',
      }),
    ]);
    assert.equal(concurrentClaims.filter(Boolean).length, 1, 'SKIP LOCKED allows only one worker to claim the delivery');
    const claimed = concurrentClaims.find((item) => item !== null)!;
    assert.equal(claimed.status, 'processing');
    assert.equal(claimed.attempts, 1);
    const claimOwner = claimed.leaseOwner!;
    assert.deepEqual(await webhookDeliveries.fail({
      deliveryRowId: claimed.deliveryRowId, workerId: claimOwner, error: 'retry integration test',
      failedAt: '2026-11-04T00:11:30.000Z', retryAt: '2026-11-04T00:12:00.000Z', maxAttempts: 2,
    }), { updated: true, terminal: false });
    assert.equal(await webhookDeliveries.claimNext({
      workerId: 'pg-worker-c', now: '2026-11-04T00:11:59.000Z', leaseExpiresAt: '2026-11-04T00:13:00.000Z',
    }), null);
    const retried = await webhookDeliveries.claimNext({
      workerId: 'pg-worker-c', now: '2026-11-04T00:12:00.000Z', leaseExpiresAt: '2026-11-04T00:13:00.000Z',
    });
    assert.equal(retried?.attempts, 2);
    assert.equal(await webhookDeliveries.complete(retried!.deliveryRowId, 'pg-worker-c', '2026-11-04T00:12:30.000Z'), true);
    assert.equal((await webhookDeliveries.find('pg-webhook-connection', 'pg-webhook-delivery-1'))?.status, 'processed');

    await service.createPipeline({
      workspaceId: 'pg-workspace',
      actorId: 'integration-test',
      definition: {
        id: 'postgres-webhook-build',
        name: 'PostgreSQL webhook build',
        triggers: [{ id: 'push-main', kind: 'push' as const, branches: ['main'] }],
        steps: [{ id: 'verify', task: 'quality.verify' }],
      },
    });
    await webhookDeliveries.enqueue({
      ...webhookInput,
      deliveryId: 'pg-webhook-delivery-processor',
      event: { ...webhookEvent, eventId: 'pg-webhook-delivery-processor' },
      bodySha256: 'c'.repeat(64),
    });
    const webhookProcessor = new WebhookDeliveryProcessor({
      deliveries: webhookDeliveries,
      buildCi: service,
      connections: {
        resolve: async () => ({
          connectionId: 'pg-webhook-connection',
          provider: 'github',
          workspaceId: 'pg-workspace',
          actorId: 'integration-test',
          repository: 'team/forge',
          signingSecret: 'processor-test-secret',
          active: true,
        }),
      },
      now: () => Date.parse('2026-11-04T00:13:00.000Z'),
    });
    const processedWebhook = await webhookProcessor.processNext('pg-processor-worker');
    assert.equal(processedWebhook.processed, true);
    assert.equal(processedWebhook.pipelinesConsidered, 2);
    assert.equal(processedWebhook.runsQueued, 1);
    const webhookRun = await testPool.pool.query<{ event_id: string; pipeline_id: string; status: string }>(
      'SELECT event_id, pipeline_id, status FROM build_pipeline_runs WHERE event_id = $1',
      ['pg-webhook-delivery-processor'],
    );
    assert.deepEqual(webhookRun.rows, [{
      event_id: 'pg-webhook-delivery-processor',
      pipeline_id: 'postgres-webhook-build',
      status: 'queued',
    }]);

    await service.createPipeline({
      workspaceId: 'pg-workspace',
      actorId: 'integration-test',
      definition: {
        id: 'postgres-scheduled-build',
        name: 'PostgreSQL scheduled build',
        triggers: [{
          id: 'every-minute',
          kind: 'schedule' as const,
          scheduleId: 'pg-schedule',
          cron: '* * * * *',
          timeZone: 'UTC',
        }],
        steps: [{ id: 'verify', task: 'quality.verify' }],
      },
    });
    const scheduleOccurrences = new PostgresScheduleOccurrenceStore(testPool.pool);
    const scheduler = new ScheduleDispatcher({
      occurrences: scheduleOccurrences,
      pipelines: store,
      buildCi: service,
      now: () => Date.parse('2026-11-04T00:14:00.000Z'),
      initialLookbackMinutes: 1,
      retryBaseMs: 1_000,
    });
    const scheduleScan = await scheduler.scanWorkspace('pg-workspace');
    assert.equal(scheduleScan.inserted, 1);
    const parallelScheduleClaims = await Promise.all([
      scheduler.processNext({ workspaceId: 'pg-workspace', actorId: 'integration-test', workerId: 'pg-scheduler-a' }),
      scheduler.processNext({ workspaceId: 'pg-workspace', actorId: 'integration-test', workerId: 'pg-scheduler-b' }),
    ]);
    assert.equal(parallelScheduleClaims.filter((item) => item.dispatched).length, 1);
    assert.equal(parallelScheduleClaims.filter((item) => item.claimed).length, 1);
    const scheduledRuns = await testPool.pool.query<{ event_id: string; pipeline_id: string; status: string }>(
      "SELECT event_id, pipeline_id, status FROM build_pipeline_runs WHERE pipeline_id = 'postgres-scheduled-build'",
    );
    assert.equal(scheduledRuns.rows.length, 1);
    assert.equal(scheduledRuns.rows[0]?.status, 'queued');
    assert.equal((await scheduleOccurrences.list('pg-workspace')).filter((item) => item.status === 'dispatched').length, 1);

    const event = { kind: 'manual' as const, source: 'forge:manual', eventId: 'pg-integration-once' };
    const first = await service.trigger({
      workspaceId: 'pg-workspace', pipelineId: 'postgres-build', actorId: 'integration-test', event,
    });
    const duplicate = await service.trigger({
      workspaceId: 'pg-workspace', pipelineId: 'postgres-build', actorId: 'integration-test', event,
    });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(first.run?.runId, duplicate.run?.runId);
  } finally {
    await testPool.pool.end();
    await testPool.cleanup();
  }
});
