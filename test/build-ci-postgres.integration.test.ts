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
import { PostgresProviderConnectionStore, StoredWebhookConnectionResolver } from '../src/modules/build-ci/provider-connections.ts';
import { ProviderConnectionOperations } from '../src/modules/build-ci/provider-connection-operations.ts';
import { migratePostgres } from '../src/kernel/postgres-migrate.ts';
import { createWorkspacePipelineAuthorizer, PostgresWorkspaceMembershipReader, workspaceAccessMigrations } from '../src/modules/build-ci/workspace-access.ts';

test('PostgreSQL Build & CI migrations, versioning and idempotent trigger receipts', { skip: !process.env.FORGE_TEST_POSTGRES_URL }, async () => {
  const { makeBlankRealPool } = await import('./pg-helpers.ts');
  const testPool = await makeBlankRealPool();
  try {
    await migrateBuildCiPostgres(testPool.pool);
    const providerConnections = new PostgresProviderConnectionStore(testPool.pool);
    await assert.rejects(() => providerConnections.create({
      connectionId: 'pg-invalid-repository',
      provider: 'github',
      workspaceId: 'pg-workspace',
      actorId: 'integration-test',
      repository: 'team/../private-app',
      secretRef: 'vault://forge/pg-workspace/github/invalid',
    }), /GitHub repository/);
    await assert.rejects(() => providerConnections.create({
      connectionId: 'pg-invalid-workspace-reference',
      provider: 'github',
      workspaceId: 'pg-workspace',
      actorId: 'integration-test',
      repository: 'team/private-app',
      secretRef: 'vault://forge/../github/invalid',
    }), /valid workspace-scoped/);
    await assert.rejects(() => providerConnections.create({
      connectionId: 'pg-cross-workspace-reference',
      provider: 'github',
      workspaceId: 'pg-workspace',
      actorId: 'integration-test',
      repository: 'team/private-app',
      secretRef: 'vault://forge/another-workspace/github/invalid',
    }), /different workspace/);
    const invalidProviderRows = await testPool.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM build_ci_provider_connections WHERE connection_id LIKE 'pg-invalid-%' OR connection_id = 'pg-cross-workspace-reference'",
    );
    assert.equal(Number(invalidProviderRows.rows[0]?.count ?? 0), 0);
    const providerConnection = await providerConnections.create({
      connectionId: 'pg-github-installation',
      provider: 'github',
      workspaceId: 'pg-workspace',
      actorId: 'integration-test',
      createdBy: 'connection-admin',
      repository: 'team/postgres-app',
      secretRef: 'vault://forge/pg-workspace/github/webhook',
      createdAt: '2026-11-04T00:00:00.000Z',
    });
    assert.equal(providerConnection.active, true);
    assert.equal(await providerConnections.rotateSecretReference('github', 'pg-github-installation',
      'vault://forge/pg-workspace/github/webhook', 'vault://forge/pg-workspace/github/webhook-v2',
      '2026-11-04T00:00:30.000Z', 'integration-test'), true);
    assert.equal(await providerConnections.rotateSecretReference('github', 'pg-github-installation',
      'vault://forge/pg-workspace/github/webhook', 'vault://forge/pg-workspace/github/webhook-v3',
      '2026-11-04T00:00:45.000Z', 'integration-test'), false);
    let vaultResolutions = 0;
    const providerResolver = new StoredWebhookConnectionResolver(providerConnections, {
      resolve: async (reference) => {
        vaultResolutions += 1;
        assert.equal(reference, 'vault://forge/pg-workspace/github/webhook-v2');
        return 'postgres-integration-secret';
      },
    });
    assert.equal((await providerResolver.resolveForIngress('github', 'pg-github-installation'))?.signingSecret, 'postgres-integration-secret');
    assert.equal((await providerResolver.resolveForDelivery('github', 'pg-github-installation'))?.actorId, 'integration-test');
    assert.equal(vaultResolutions, 1);
    assert.equal(await providerConnections.revoke('github', 'pg-github-installation', '2026-11-04T00:01:00.000Z', 'integration-test'), true);
    const providerEvents = await providerConnections.listEvents('pg-workspace', 'github', 'pg-github-installation');
    assert.deepEqual(providerEvents.map((event) => event.eventType), ['created', 'secret_reference_rotated', 'revoked']);
    assert.deepEqual(providerEvents.map((event) => event.actorId), ['connection-admin', 'integration-test', 'integration-test']);
    assert.equal((await providerConnections.find('github', 'pg-github-installation'))?.actorId, 'integration-test');
    assert.deepEqual(providerEvents[1]?.metadata, { secretReferenceChanged: true });
    assert.equal(JSON.stringify(providerEvents).includes('vault://'), false);
    const workspaceConnections = await providerConnections.listForWorkspace('pg-workspace');
    assert.ok(workspaceConnections.some((connection) => connection.connectionId === 'pg-github-installation'));
    await assert.rejects(() => testPool.pool.query(
      "UPDATE build_ci_provider_connection_events SET actor_id = 'tampered' WHERE connection_id = $1",
      ['pg-github-installation'],
    ));
    await assert.rejects(() => testPool.pool.query(
      "DELETE FROM build_ci_provider_connection_events WHERE connection_id = $1",
      ['pg-github-installation'],
    ));
    await assert.rejects(() => testPool.pool.query("TRUNCATE build_ci_provider_connection_events"));
    assert.equal(await providerConnections.revoke('github', 'pg-github-installation', '2026-11-04T00:02:00.000Z', 'integration-test'), false);
    assert.equal(await providerResolver.resolveForIngress('github', 'pg-github-installation'), null);
    assert.equal(await providerResolver.resolveForDelivery('github', 'pg-github-installation'), null);
    assert.equal(vaultResolutions, 1);
    const revocationRaceRef = 'vault://forge/pg-workspace/github/race-revocation';
    await providerConnections.create({
      connectionId: 'pg-race-revocation',
      provider: 'github',
      workspaceId: 'pg-workspace',
      actorId: 'integration-test',
      repository: 'team/postgres-app',
      secretRef: revocationRaceRef,
      createdAt: '2026-11-04T00:02:00.000Z',
    });
    const revocationRaceResolver = new StoredWebhookConnectionResolver(providerConnections, {
      resolve: async () => {
        assert.equal(await providerConnections.revoke('github', 'pg-race-revocation', '2026-11-04T00:02:30.000Z', 'integration-test'), true);
        return 'secret-read-before-postgres-revocation';
      },
    });
    assert.equal(await revocationRaceResolver.resolveForIngress('github', 'pg-race-revocation'), null,
      'PostgreSQL ingress must reject a secret lookup raced by connection revocation');

    const rotationRaceRef = 'vault://forge/pg-workspace/github/race-rotation';
    const rotatedRaceRef = 'vault://forge/pg-workspace/github/race-rotation-v2';
    await providerConnections.create({
      connectionId: 'pg-race-rotation',
      provider: 'github',
      workspaceId: 'pg-workspace',
      actorId: 'integration-test',
      repository: 'team/postgres-app',
      secretRef: rotationRaceRef,
      createdAt: '2026-11-04T00:03:00.000Z',
    });
    const rotationRaceResolver = new StoredWebhookConnectionResolver(providerConnections, {
      resolve: async (reference) => {
        assert.equal(reference, rotationRaceRef);
        assert.equal(await providerConnections.rotateSecretReference(
          'github', 'pg-race-rotation', rotationRaceRef, rotatedRaceRef, '2026-11-04T00:03:30.000Z', 'integration-test',
        ), true);
        return 'secret-read-before-postgres-rotation';
      },
    });
    assert.equal(await rotationRaceResolver.resolveForIngress('github', 'pg-race-rotation'), null,
      'PostgreSQL ingress must reject a secret resolved for a superseded reference');
    assert.equal((await providerConnections.find('github', 'pg-race-rotation'))?.secretRef, rotatedRaceRef);

    await migratePostgres(testPool.pool, 'workspace_access', workspaceAccessMigrations);
    await testPool.pool.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
      ['pg-workspace', 'integration-test', 'maintainer', 'active', new Date().toISOString(), new Date().toISOString()],
    );
    const authorize = createWorkspacePipelineAuthorizer(new PostgresWorkspaceMembershipReader(testPool.pool));
    let providerSecretLookups = 0;
    const providerOperations = new ProviderConnectionOperations({
      connections: providerConnections,
      authorize,
      secrets: {
        resolve: async (reference) => {
          providerSecretLookups += 1;
          return reference.startsWith('vault://forge/pg-workspace/github/managed') ? 'managed-postgres-secret' : null;
        },
      },
      now: () => Date.parse('2026-11-04T00:04:00.000Z'),
    });
    const managedConnection = await providerOperations.create({
      workspaceId: 'pg-workspace',
      actorId: 'integration-test',
      deliveryActorId: 'integration-test',
      connectionId: 'pg-managed-connection',
      provider: 'github',
      repository: 'team/managed-app',
      secretRef: 'vault://forge/pg-workspace/github/managed',
    });
    assert.equal(managedConnection.active, true);
    assert.equal('secretRef' in managedConnection, false);
    await assert.rejects(
      () => providerOperations.create({
        workspaceId: 'pg-workspace',
        actorId: 'integration-test',
        deliveryActorId: 'integration-test',
        connectionId: 'pg-managed-connection',
        provider: 'github',
        repository: 'team/managed-app',
        secretRef: 'vault://forge/pg-workspace/github/managed',
      }),
      (error: unknown) => error instanceof Error && error.name === 'ProviderConnectionConflictError',
    );
    assert.equal((await providerConnections.find('github', 'pg-managed-connection'))?.actorId, 'integration-test');
    const managedRotation = await providerOperations.rotateSecretReference({
      workspaceId: 'pg-workspace',
      actorId: 'integration-test',
      connectionId: 'pg-managed-connection',
      provider: 'github',
      nextSecretRef: 'vault://forge/pg-workspace/github/managed-v2',
    });
    assert.equal(managedRotation.updatedAt, '2026-11-04T00:04:00.000Z');
    const managedEventsAfterRotation = await providerOperations.listEvents({
      workspaceId: 'pg-workspace', actorId: 'integration-test',
      connectionId: 'pg-managed-connection', provider: 'github',
    });
    assert.deepEqual(managedEventsAfterRotation.map((event) => event.eventType), ['created', 'secret_reference_rotated']);
    const managedRevocation = await providerOperations.revoke({
      workspaceId: 'pg-workspace', actorId: 'integration-test',
      connectionId: 'pg-managed-connection', provider: 'github',
    });
    assert.equal(managedRevocation.revoked, true);
    assert.equal(providerSecretLookups, 2);
    const managedEvents = await providerOperations.listEvents({
      workspaceId: 'pg-workspace', actorId: 'integration-test',
      connectionId: 'pg-managed-connection', provider: 'github',
    });
    assert.deepEqual(managedEvents.map((event) => event.eventType), ['created', 'secret_reference_rotated', 'revoked']);
    assert.equal(JSON.stringify(managedEvents).includes('vault://'), false);
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
    await assert.rejects(() => testPool.pool.query(
      'UPDATE build_pipelines SET current_version = 1 WHERE workspace_id = $1 AND pipeline_id = $2',
      ['pg-workspace', 'postgres-build'],
    ), /monotonic/, 'PostgreSQL must reject a backward pipeline head update');
    await assert.rejects(() => testPool.pool.query(
      'UPDATE build_pipelines SET current_version = 4 WHERE workspace_id = $1 AND pipeline_id = $2',
      ['pg-workspace', 'postgres-build'],
    ), /existing version/, 'PostgreSQL must reject a head that points to a missing version');

    const integrityVersion = await service.createPipeline({
      workspaceId: 'pg-integrity-workspace',
      actorId: 'integration-test',
      createdAt: '2026-11-04T00:04:30.000Z',
      definition: {
        id: 'postgres-integrity-probe',
        name: 'Integrity probe',
        triggers: [{ id: 'manual', kind: 'manual' as const }],
        steps: [{ id: 'verify', task: 'quality.verify' }],
      },
    });
    await testPool.pool.query('ALTER TABLE build_pipeline_versions DISABLE TRIGGER build_pipeline_versions_block_update');
    try {
      await testPool.pool.query(
        'UPDATE build_pipeline_versions SET definition_json = $1 WHERE workspace_id = $2 AND pipeline_id = $3 AND version = $4',
        [JSON.stringify({ ...integrityVersion.definition, name: 'Tampered after persistence' }),
          'pg-integrity-workspace', integrityVersion.pipelineId, integrityVersion.version],
      );
    } finally {
      await testPool.pool.query('ALTER TABLE build_pipeline_versions ENABLE TRIGGER build_pipeline_versions_block_update');
    }
    await assert.rejects(
      () => store.getVersion('pg-integrity-workspace', integrityVersion.pipelineId, integrityVersion.version),
      /failed integrity verification/,
    );
    await assert.rejects(
      () => store.getLatestVersion('pg-integrity-workspace', integrityVersion.pipelineId),
      /failed integrity verification/,
    );

    const concurrentVersions = await Promise.all([1, 2, 3].map((number) => service.createPipeline({
      workspaceId: 'pg-workspace',
      actorId: 'integration-test',
      createdAt: new Date(Date.parse('2026-11-04T00:05:00.000Z') + number * 1000).toISOString(),
      definition: {
        id: 'postgres-concurrent-version',
        name: 'Concurrent version ' + number,
        triggers: [{ id: 'manual', kind: 'manual' as const }],
        steps: [{ id: 'verify', task: 'quality.verify' }],
      },
    })));
    assert.deepEqual(concurrentVersions.map((item) => item.version).sort((a, b) => a - b), [1, 2, 3]);
    assert.deepEqual(
      (await store.listVersions('pg-workspace', 'postgres-concurrent-version')).map((item) => item.version),
      [1, 2, 3],
    );

    const concurrentRollbacks = await Promise.all([
      service.rollbackPipeline({
        workspaceId: 'pg-workspace', pipelineId: 'postgres-concurrent-version',
        targetVersion: 1, actorId: 'integration-test', createdAt: '2026-11-04T00:05:10.000Z',
      }),
      service.rollbackPipeline({
        workspaceId: 'pg-workspace', pipelineId: 'postgres-concurrent-version',
        targetVersion: 2, actorId: 'integration-test', createdAt: '2026-11-04T00:05:11.000Z',
      }),
    ]);
    assert.deepEqual(concurrentRollbacks.map((item) => item.version).sort((a, b) => a - b), [4, 5]);
    assert.deepEqual(concurrentRollbacks.map((item) => item.rollbackOfVersion).sort(), [1, 2]);
    assert.deepEqual(
      (await store.listVersions('pg-workspace', 'postgres-concurrent-version')).map((item) => item.version),
      [1, 2, 3, 4, 5],
    );

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
    const failureCredential = 'ghp_POSTGRES_STORAGE_BOUNDARY_SECRET_MUST_NOT_PERSIST';
    assert.deepEqual(await webhookDeliveries.fail({
      deliveryRowId: claimed.deliveryRowId, workerId: claimOwner,
      error: 'provider error with credential ' + failureCredential,
      failedAt: '2026-11-04T00:11:30.000Z', retryAt: '2026-11-04T00:12:00.000Z', maxAttempts: 2,
    }), { updated: true, terminal: false });
    const retriableFailure = await webhookDeliveries.find('pg-webhook-connection', 'pg-webhook-delivery-1');
    assert.equal(retriableFailure?.lastError, 'Webhook delivery processing failed.');
    assert.equal(retriableFailure?.lastError?.includes(failureCredential), false);
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
    const processorEnqueue = await webhookDeliveries.enqueue({
      ...webhookInput,
      deliveryId: 'pg-webhook-delivery-processor',
      event: { ...webhookEvent, eventId: 'pg-webhook-delivery-processor' },
      bodySha256: 'c'.repeat(64),
    });
    assert.equal(processorEnqueue.inserted, true, 'processor fixture must insert a distinct queued receipt');
    const webhookProcessor = new WebhookDeliveryProcessor({
      deliveries: webhookDeliveries,
      buildCi: service,
      connections: {
        resolveForDelivery: async () => ({
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
    assert.equal(processedWebhook.claimed, true, 'processor must claim the inserted receipt: ' + JSON.stringify(processedWebhook));
    assert.equal(processedWebhook.processed, true, 'processor must complete the claimed receipt: ' + JSON.stringify(processedWebhook));
    assert.equal(processedWebhook.pipelinesConsidered, 3);
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

    await webhookDeliveries.enqueue({
      ...webhookInput,
      deliveryId: 'pg-webhook-dead-letter',
      event: { ...webhookEvent, eventId: 'pg-webhook-dead-letter' },
      bodySha256: 'd'.repeat(64),
      receivedAt: '2026-11-04T00:14:00.000Z',
    });
    const deadLetterClaim = await webhookDeliveries.claimNext({
      workerId: 'pg-dead-letter-worker',
      now: '2026-11-04T00:14:30.000Z',
      leaseExpiresAt: '2026-11-04T00:15:30.000Z',
    });
    assert.ok(deadLetterClaim);
    assert.deepEqual(await webhookDeliveries.fail({
      deliveryRowId: deadLetterClaim.deliveryRowId,
      workerId: 'pg-dead-letter-worker',
      error: 'provider diagnostic containing ghp_POSTGRES_DEAD_LETTER_SECRET',
      failedAt: '2026-11-04T00:14:45.000Z',
      retryAt: '2026-11-04T00:15:00.000Z',
      maxAttempts: 1,
    }), { updated: true, terminal: true });
    const deadLetterPage = await webhookDeliveries.listDeadLetters({ workspaceId: 'pg-workspace', limit: 10 });
    assert.ok(deadLetterPage.items.some((item) => item.deliveryRowId === deadLetterClaim.deliveryRowId));
    assert.equal(deadLetterPage.items.find((item) => item.deliveryRowId === deadLetterClaim.deliveryRowId)?.lastError,
      'Webhook delivery processing failed.');
    const concurrentReplayResults = await Promise.all([
      webhookDeliveries.replayFailed({
        workspaceId: 'pg-workspace',
        deliveryRowId: deadLetterClaim.deliveryRowId,
        actorId: 'integration-test',
        replayedAt: '2026-11-04T00:16:00.000Z',
      }),
      webhookDeliveries.replayFailed({
        workspaceId: 'pg-workspace',
        deliveryRowId: deadLetterClaim.deliveryRowId,
        actorId: 'integration-test',
        replayedAt: '2026-11-04T00:16:01.000Z',
      }),
    ]);
    assert.equal(concurrentReplayResults.filter((result) => result.replayed).length, 1);
    assert.equal(concurrentReplayResults.filter((result) => !result.replayed).length, 1);
    assert.equal(concurrentReplayResults.find((result) => result.replayed)?.previousAttempts, 1);
    const postgresReplay = await webhookDeliveries.listReplayEvents('pg-workspace', deadLetterClaim.deliveryRowId);
    assert.equal(postgresReplay.length, 1);
    assert.equal(postgresReplay[0]?.actorId, 'integration-test');
    assert.deepEqual(postgresReplay[0]?.metadata, { previousAttempts: 1 });
    assert.equal((await webhookDeliveries.find('pg-webhook-connection', 'pg-webhook-dead-letter'))?.status, 'queued');
    assert.deepEqual(await webhookDeliveries.replayFailed({
      workspaceId: 'pg-workspace',
      deliveryRowId: deadLetterClaim.deliveryRowId,
      actorId: 'integration-test',
      replayedAt: '2026-11-04T00:17:00.000Z',
    }), { replayed: false });
    await assert.rejects(() => testPool.pool.query(
      "UPDATE build_ci_webhook_delivery_events SET actor_id = 'tampered' WHERE delivery_row_id = $1",
      [deadLetterClaim.deliveryRowId],
    ));

    await service.createPipeline({
      workspaceId: 'pg-workspace',
      actorId: 'integration-test',
      createdAt: '2026-11-04T00:00:00.000Z',
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
