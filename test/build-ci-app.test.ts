import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { PipelineAuthorizationError } from '../src/modules/build-ci/store.ts';
import type { PipelineDefinition } from '../src/modules/build-ci/pipeline.ts';

const definition: PipelineDefinition = {
  id: 'app-integration',
  name: 'Application integration',
  triggers: [{ id: 'manual', kind: 'manual' }],
  steps: [{ id: 'verify', task: 'quality.verify' }],
};

function config() {
  return loadConfig({ FORGE_ENV: 'test', FORGE_SCRYPT_LOG_N: '10' });
}

test('Build & CI service is composed into the app and denies by default without workspace policy', async () => {
  const app = buildApp(config(), { logger: silentLogger });
  try {
    await assert.rejects(
      app.buildCi.createPipeline({ workspaceId: 'workspace-a', definition, actorId: 'user-a' }),
      PipelineAuthorizationError,
    );
  } finally {
    await app.close();
  }
});

test('Build & CI service uses injected workspace authorization and migrated SQLite storage', async () => {
  const app = buildApp(config(), {
    logger: silentLogger,
    buildCiAuthorize: async (request) =>
      request.workspaceId === 'workspace-a' && request.actorId === 'user-a' && request.action === 'create',
  });
  try {
    const version = await app.buildCi.createPipeline({
      workspaceId: 'workspace-a',
      definition,
      actorId: 'user-a',
      createdAt: '2026-11-04T00:00:00.000Z',
    });
    assert.equal(version.version, 1);
    assert.equal(version.pipelineId, 'app-integration');
    assert.equal(version.createdBy, 'user-a');
  } finally {
    await app.close();
  }
});
