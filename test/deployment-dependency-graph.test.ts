import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { planDeploymentDependencies } from '../src/modules/deployments/index.ts';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

async function signedIn(h: Harness, email: string, plan?: 'pro'): Promise<string> {
  const register = await h.post('/v1/auth/register', {
    email,
    password: GOOD_PASSWORD,
    displayName: 'Deployment Graph Tester',
  });
  assert.equal(register.status, 201);
  const registered = (await register.json()) as { user: { id: string } };
  if (plan !== undefined) await h.app.plans.setPlan(registered.user.id, plan);
  const login = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(login.status, 200);
  return sessionCookie(login);
}

const errorCode = async (response: Response): Promise<string> => {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
};

describe('DP-015 deployment dependency graph', () => {
  it('returns deterministic dependency-first waves for parallel release planning', () => {
    const result = planDeploymentDependencies([
      { id: 'web', dependsOn: ['api'] },
      { id: 'worker', dependsOn: ['db'] },
      { id: 'api', dependsOn: ['db', 'auth'] },
      { id: 'auth' },
      { id: 'db' },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.waves, [['auth', 'db'], ['api', 'worker'], ['web']]);
    assert.deepEqual(result.order, ['auth', 'db', 'api', 'worker', 'web']);
    assert.equal(result.serviceCount, 5);
    assert.equal(result.dependencyCount, 4);
  });

  it('is independent of caller input order', () => {
    const first = planDeploymentDependencies([
      { id: 'api', dependsOn: ['db'] },
      { id: 'db' },
      { id: 'worker', dependsOn: ['db'] },
    ]);
    const second = planDeploymentDependencies([
      { id: 'worker', dependsOn: ['db'] },
      { id: 'db' },
      { id: 'api', dependsOn: ['db'] },
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(first, second);
  });

  it('rejects duplicate services, missing dependencies and self-dependencies', () => {
    assert.deepEqual(
      planDeploymentDependencies([{ id: 'api' }, { id: 'api' }]),
      { ok: false, reason: 'dependency_graph_duplicate_service' },
    );
    assert.deepEqual(
      planDeploymentDependencies([{ id: 'api', dependsOn: ['database'] }]),
      { ok: false, reason: 'dependency_graph_unknown_dependency:api:database' },
    );
    assert.deepEqual(
      planDeploymentDependencies([{ id: 'api', dependsOn: ['api'] }]),
      { ok: false, reason: 'dependency_graph_self_dependency' },
    );
  });

  it('reports a concrete cycle path instead of returning a partial order', () => {
    const result = planDeploymentDependencies([
      { id: 'api', dependsOn: ['worker'] },
      { id: 'worker', dependsOn: ['queue'] },
      { id: 'queue', dependsOn: ['api'] },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'dependency_graph_cycle');
    assert.deepEqual(result.cycle, ['api', 'worker', 'queue', 'api']);
  });

  it('rejects malformed and oversized graphs', () => {
    assert.deepEqual(planDeploymentDependencies([]), { ok: false, reason: 'dependency_graph_empty' });
    assert.deepEqual(planDeploymentDependencies([{ id: 'bad id' }]), { ok: false, reason: 'dependency_graph_invalid_service_id' });
    assert.deepEqual(planDeploymentDependencies(Array.from({ length: 257 }, (_, i) => ({ id: 's' + i }))), {
      ok: false,
      reason: 'dependency_graph_too_many_services',
    });
  });

  it('requires a session and enforces the Pro catalog gate', async () => {
    const h = await startHarness();
    try {
      const anonymous = await h.post('/v1/deployments/dependency-graph/plan', {
        services: [{ id: 'api' }],
      });
      assert.equal(anonymous.status, 401);
      assert.equal(await errorCode(anonymous), 'unauthenticated');

      const freeCookie = await signedIn(h, 'dp015-free@forge.test');
      const free = await h.post('/v1/deployments/dependency-graph/plan', {
        services: [{ id: 'api' }],
      }, { cookie: freeCookie });
      assert.equal(free.status, 402);
      assert.equal(await errorCode(free), 'plan_required');

      const proCookie = await signedIn(h, 'dp015-pro@forge.test', 'pro');
      const response = await h.post('/v1/deployments/dependency-graph/plan', {
        services: [{ id: 'api', dependsOn: ['db'] }, { id: 'db' }],
      }, { cookie: proCookie });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { plan: { order: string[]; waves: string[][] } };
      assert.deepEqual(body.plan.order, ['db', 'api']);
      assert.deepEqual(body.plan.waves, [['db'], ['api']]);
    } finally {
      await h.close();
    }
  });

  it('refuses unknown request fields and cyclic graphs at the route boundary', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedIn(h, 'dp015-invalid@forge.test', 'pro');
      const unknown = await h.post('/v1/deployments/dependency-graph/plan', {
        services: [{ id: 'api' }],
        execute: true,
      }, { cookie });
      assert.equal(unknown.status, 400);
      assert.equal(await errorCode(unknown), 'invalid_request');

      const cyclic = await h.post('/v1/deployments/dependency-graph/plan', {
        services: [{ id: 'api', dependsOn: ['worker'] }, { id: 'worker', dependsOn: ['api'] }],
      }, { cookie });
      assert.equal(cyclic.status, 400);
      assert.equal(await errorCode(cyclic), 'invalid_request');
    } finally {
      await h.close();
    }
  });
});
