import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { buildCiRoutes } from '../src/modules/build-ci/routes.ts';
import { gateBuildCiRoutes } from '../src/modules/plans/build-ci-gate.ts';
import { InMemoryPlanStore, PlansService } from '../src/modules/plans/plans-service.ts';
import type { IdentityService } from '../src/modules/identity/identity-service.ts';
import { AppError } from '../src/kernel/errors.ts';
import type { RequestContext } from '../src/kernel/http.ts';

const plainDefinition = {
  id: 'gated-pipeline',
  name: 'Gated pipeline',
  triggers: [{ id: 'manual', kind: 'manual' }],
  steps: [{ id: 'verify', task: 'quality.verify' }],
};

const conditionalDefinition = {
  ...plainDefinition,
  steps: [{ id: 'verify', task: 'quality.verify', when: { op: 'exists', field: 'event.branch' } }],
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

async function planRefusal(run: () => Promise<unknown>): Promise<{ feature?: unknown; gate?: unknown }> {
  try {
    await run();
    assert.fail('expected a 402 plan_required refusal');
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.status, 402);
    assert.equal(err.code, 'plan_required');
    return (err.details ?? {}) as { feature?: unknown; gate?: unknown };
  }
  return {};
}

test('plan gates wrap the Build & CI routes: free users build plain pipelines, conditional ones need Plus', async () => {
  const app = buildApp(loadConfig({ FORGE_ENV: 'test', FORGE_SCRYPT_LOG_N: '10' }), {
    logger: silentLogger,
    buildCiAuthorize: async () => true,
  });
  const identity = {
    authenticate: async (token?: string) => token === 'valid-session'
      ? { user: { id: 'plan-user' }, sessionExpiresAt: Date.now() + 60_000 }
      : null,
  } as unknown as IdentityService;
  const plans = new PlansService({ store: new InMemoryPlanStore() });
  const routes = gateBuildCiRoutes(
    buildCiRoutes(app.buildCi, identity, { name: 'forge_session' }, () => Date.parse('2026-11-04T00:00:00.000Z')),
    plans,
    identity,
    { name: 'forge_session' },
  );
  try {
    const create = routes['/v1/build-ci/pipelines']?.POST;
    assert.ok(create);

    // BD-001 is free: a plain pipeline is created without any plan upgrade.
    const plain = await create(context({ workspaceId: 'workspace-a', definition: plainDefinition }, 'valid-session'));
    assert.equal(plain.status, 201);

    // BD-017 is plus: a conditional definition is refused with the gate named.
    const details = await planRefusal(() => create(context({ workspaceId: 'workspace-a', definition: conditionalDefinition }, 'valid-session')));
    assert.equal(details.feature, 'BD-017');
    assert.equal(details.gate, 'plus');

    // Upgrading the plan unlocks the same definition, nothing else changed.
    await app.plans.setPlan('plan-user', 'plus');
    const upgraded = await create(context({ workspaceId: 'workspace-a', definition: conditionalDefinition }, 'valid-session'));
    assert.equal(upgraded.status, 201);
  } finally {
    await app.close();
  }
});

test('dry-run candidates are gated the same way, and free rows never block', async () => {
  const app = buildApp(loadConfig({ FORGE_ENV: 'test', FORGE_SCRYPT_LOG_N: '10' }), {
    logger: silentLogger,
    buildCiAuthorize: async () => true,
  });
  const identity = {
    authenticate: async (token?: string) => token === 'valid-session'
      ? { user: { id: 'plan-user' }, sessionExpiresAt: Date.now() + 60_000 }
      : null,
  } as unknown as IdentityService;
  const plans = new PlansService({ store: new InMemoryPlanStore() });
  const routes = gateBuildCiRoutes(
    buildCiRoutes(app.buildCi, identity, { name: 'forge_session' }, () => Date.parse('2026-11-04T00:00:00.000Z')),
    plans,
    identity,
    { name: 'forge_session' },
  );
  try {
    const dryRun = routes['/v1/build-ci/pipelines/dry-run']?.POST;
    assert.ok(dryRun);

    // BD-029 is free: a plain candidate dry-runs for a free user.
    const plainDry = await dryRun(context({ workspaceId: 'workspace-a', definition: plainDefinition }, 'valid-session'));
    assert.equal(plainDry.status, 200);

    // A conditional candidate is refused on BD-017 before the plan runs.
    const details = await planRefusal(() => dryRun(context({ workspaceId: 'workspace-a', definition: conditionalDefinition }, 'valid-session')));
    assert.equal(details.feature, 'BD-017');

    // BD-030 is free: the rollback gate never refuses a free user (the inner route
    // answers instead - here a not-found, because nothing was rolled back).
    const rollback = routes['/v1/build-ci/pipelines/rollback']?.POST;
    assert.ok(rollback);
    try {
      await rollback(context({ workspaceId: 'workspace-a', pipelineId: 'gated-pipeline', targetVersion: 1 }, 'valid-session'));
      assert.fail('expected the inner route to answer');
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.notEqual(err.code, 'plan_required');
    }

    // The plans routes answer for the same session.
    const me = routes['/v1/plans/me']?.GET;
    assert.ok(me);
    const meResult = await me({ ...context({}), method: 'GET' } as RequestContext);
    assert.equal(meResult.status, 200);
    assert.equal((meResult.body as { plan: string }).plan, 'free');

    const check = routes['/v1/plans/check']?.POST;
    assert.ok(check);
    const allowed = await check(context({ feature: 'BD-001' }, 'valid-session'));
    assert.equal(allowed.status, 200);
    const checkDetails = await planRefusal(() => check(context({ feature: 'BD-017' }, 'valid-session')));
    assert.equal(checkDetails.feature, 'BD-017');
  } finally {
    await app.close();
  }
});
