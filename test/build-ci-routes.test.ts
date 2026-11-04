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
  steps: [{ id: 'verify', task: 'quality.verify' }],
};

function context(body: Record<string, unknown>, token?: string): RequestContext {
  return {
    requestId: 'request-test',
    ip: '127.0.0.1',
    userAgent: 'test',
    method: 'POST',
    path: '/v1/build-ci/pipelines',
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
    const denied = await create(context({ workspaceId: 'workspace-a', definition }));
    assert.equal(denied.status, 401);

    const allowed = await create(context({ workspaceId: 'workspace-a', definition }, 'valid-session'));
    assert.equal(allowed.status, 201);
    const body = allowed.body as { pipeline: { createdBy: string; version: number } };
    assert.equal(body.pipeline.createdBy, 'session-user');
    assert.equal(body.pipeline.version, 1);

    await assert.rejects(
      () => create(context({ workspaceId: 'workspace-a', definition, actorId: 'attacker' }, 'valid-session')),
      (error: unknown) => error instanceof Error && error.name === 'AppError',
    );
  } finally {
    await app.close();
  }
});
