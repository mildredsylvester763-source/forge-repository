import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildCiService } from '../src/modules/build-ci/store.ts';
import { PostgresBuildCiStore } from '../src/modules/build-ci/postgres-store.ts';
import { migrateBuildCiPostgres } from '../src/modules/build-ci/migrations.ts';

test('PostgreSQL Build & CI migrations, versioning and idempotent trigger receipts', { skip: !process.env.FORGE_TEST_POSTGRES_URL }, async () => {
  const { makeBlankRealPool } = await import('./pg-helpers.ts');
  const testPool = await makeBlankRealPool();
  try {
    await migrateBuildCiPostgres(testPool.pool);
    const store = new PostgresBuildCiStore(testPool.pool);
    const service = new BuildCiService({ store, authorize: async () => true });
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
