import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { buildCiRoutes } from '../src/modules/build-ci/routes.ts';
import type { IdentityService } from '../src/modules/identity/identity-service.ts';
import type { RequestContext } from '../src/kernel/http.ts';

const definition = {
  id: 'http-pipeline',
  name: 'HTTP pipeline',
  triggers: [{ id: 'manual', kind: 'manual' }],
  inputs: [
    { name: 'target', type: 'string', required: true, options: ['staging', 'production'] },
    { name: 'parallelism', type: 'number', default: 2, options: [1, 2, 4] },
    { name: 'publish', type: 'boolean', default: false },
    { name: 'deploy_credential', type: 'secret_ref', required: true },
  ],
  steps: [{ id: 'verify', task: 'quality.verify' }],
};

function context(body: Record<string, unknown>, token?: string, query: Record<string, string> = {}): RequestContext {
  return {
    requestId: 'request-test',
    ip: '127.0.0.1',
    userAgent: 'test',
    method: 'POST',
    path: '/v1/build-ci/pipelines',
    query: (name) => query[name],
    header: () => undefined,
    cookie: (name) => name === 'forge_session' ? token : undefined,
    json: async () => body,
  };
}

test('Build & CI HTTP routes derive actor from authenticated session and reject unauthenticated requests', async () => {
  const app = buildApp(loadConfig({ FORGE_ENV: 'test', FORGE_SCRYPT_LOG_N: '10' }), {
    logger: silentLogger,
    buildCiAuthorize: async () => true,
  });
  const identity = {
    authenticate: async (token?: string) => token === 'valid-session'
      ? { user: { id: 'session-user' }, sessionExpiresAt: Date.now() + 60_000 }
      : null,
  } as unknown as IdentityService;
  const routes = buildCiRoutes(app.buildCi, identity, { name: 'forge_session' }, () => Date.parse('2026-11-04T00:00:00.000Z'));
  try {
    const create = routes['/v1/build-ci/pipelines']?.POST;
    assert.ok(create);
    await assert.rejects(
      () => create(context({ workspaceId: 'workspace-a', definition })),
      (error: unknown) => error instanceof Error && error.name === 'AppError',
    );

    const allowed = await create(context({ workspaceId: 'workspace-a', definition }, 'valid-session'));
    assert.equal(allowed.status, 201);
    const body = allowed.body as { pipeline: { createdBy: string; version: number } };
    assert.equal(body.pipeline.createdBy, 'session-user');
    assert.equal(body.pipeline.version, 1);

    const read = routes['/v1/build-ci/pipelines']?.GET;
    const listVersions = routes['/v1/build-ci/pipelines/versions']?.GET;
    const getVersion = routes['/v1/build-ci/pipelines/version']?.GET;
    assert.ok(read && listVersions && getVersion);
    const readResult = await read(context({}, 'valid-session', { workspaceId: 'workspace-a', pipelineId: 'http-pipeline' }));
    assert.equal(readResult.status, 200);
    const history = await listVersions(context({}, 'valid-session', { workspaceId: 'workspace-a', pipelineId: 'http-pipeline' }));
    assert.equal((history.body as { versions: unknown[] }).versions.length, 1);
    const version = await getVersion(context({}, 'valid-session', { workspaceId: 'workspace-a', pipelineId: 'http-pipeline', version: '1' }));
    assert.equal(version.status, 200);

    const trigger = routes['/v1/build-ci/pipelines/trigger']?.POST;
    assert.ok(trigger);
    const triggered = await trigger(context({
      workspaceId: 'workspace-a',
      pipelineId: 'http-pipeline',
      event: { kind: 'manual' },
      inputs: { target: 'staging', deploy_credential: 'workspace.ci_deploy_key' },
    }, 'valid-session'));
    assert.equal(triggered.status, 202);
    const run = (triggered.body as { run: { eventSource: string; context: { inputs: Record<string, unknown> } } }).run;
    assert.equal(run.eventSource, 'forge.manual');
    assert.equal(run.context.inputs.target, 'staging');
    assert.equal(run.context.inputs.parallelism, 2);
    assert.equal(run.context.inputs.publish, false);
    assert.equal(run.context.inputs.deploy_credential, 'workspace.ci_deploy_key');
    await assert.rejects(
      () => trigger(context({
        workspaceId: 'workspace-a',
        pipelineId: 'http-pipeline',
        event: { kind: 'manual', source: 'forged.provider', eventId: 'forged' },
      }, 'valid-session')),
      (error: unknown) => error instanceof Error && error.name === 'AppError',
    );

    const dryRun = routes['/v1/build-ci/pipelines/dry-run']?.POST;
    assert.ok(dryRun);
    const candidate = { ...definition, id: 'candidate-pipeline' };
    const candidateResult = await dryRun(context({ workspaceId: 'workspace-a', definition: candidate, inputs: { target: 'production', deploy_credential: 'workspace.preview_key' } }, 'valid-session'));
    assert.equal(candidateResult.status, 200);
    assert.equal((candidateResult.body as { source: string }).source, 'candidate');
    await assert.rejects(() => app.buildCi.getPipeline({ workspaceId: 'workspace-a', pipelineId: 'candidate-pipeline', actorId: 'session-user' }));

    await assert.rejects(
      () => create(context({ workspaceId: 'workspace-a', definition, actorId: 'attacker' }, 'valid-session')),
      (error: unknown) => error instanceof Error && error.name === 'AppError',
    );
  } finally {
    await app.close();
  }
});
