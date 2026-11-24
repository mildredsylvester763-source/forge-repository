import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, setPlanForTest, startHarness } from './helpers.ts';

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

describe('ai-training long-running tasks and task budgets (AI-084/085)', () => {
  it('refuses the new routes without a session', async () => {
    const h = await startHarness();
    try {
      const paths = [
        '/v1/ai-training/tasks/start',
        '/v1/ai-training/tasks/checkpoint',
        '/v1/ai-training/tasks/pause',
        '/v1/ai-training/tasks/resume',
        '/v1/ai-training/tasks/complete',
        '/v1/ai-training/tasks/status',
        '/v1/ai-training/tasks/budget/define',
        '/v1/ai-training/tasks/budget/charge',
        '/v1/ai-training/tasks/budget/status',
      ];
      assert.equal(paths.length, 9);
      for (const path of paths) {
        const res = await h.post(path, {});
        assert.equal(res.status, 401, path);
        assert.equal(await errorCode(res), 'unauthenticated', path);
      }
    } finally {
      await h.close();
    }
  });

  it('runs a long-running task: checkpoints, pause, resume, complete (AI-084)', async () => {
    const h = await startHarness();
    try {
      const register = await h.post('/v1/auth/register', { email: 'tasks@forge.test', password: GOOD_PASSWORD, displayName: 'Tasker' });
      assert.equal(register.status, 201);
      await setPlanForTest(h, ((await register.json()) as { user: { id: string } }).user.id, 'enterprise');
      const cookie = sessionCookie(await h.post('/v1/auth/sign-in', { email: 'tasks@forge.test', password: GOOD_PASSWORD }));

      const badKind = await h.post('/v1/ai-training/tasks/start', { taskId: 't', kind: ' ' }, { cookie });
      assert.equal(badKind.status, 400);
      assert.equal(await errorCode(badKind), 'task-start-no-kind');
      const started = await h.post('/v1/ai-training/tasks/start', { taskId: 'task-1', kind: 'render' }, { cookie });
      assert.equal(started.status, 201);
      const startBody = (await started.json()) as { task: { taskId: string; kind: string; status: string; checkpointCount: number; resumedFrom: string | null }; createdAt: number };
      assert.equal(startBody.task.taskId, 'task-1');
      assert.equal(startBody.task.kind, 'render');
      assert.equal(startBody.task.status, 'running');
      assert.equal(startBody.task.checkpointCount, 0);
      assert.deepEqual(startBody.task.checkpoints, []);
      const dup = await h.post('/v1/ai-training/tasks/start', { taskId: 'task-1', kind: 'render' }, { cookie });
      assert.equal(dup.status, 409);
      assert.equal(await errorCode(dup), 'longrunning-task-duplicate:task-1');

      const badStep = await h.post('/v1/ai-training/tasks/checkpoint', { taskId: 'task-1', step: -1, state: { a: 1 } }, { cookie });
      assert.equal(badStep.status, 400);
      assert.equal(await errorCode(badStep), 'checkpoint-bad-step');
      const noState = await h.post('/v1/ai-training/tasks/checkpoint', { taskId: 'task-1', step: 1, state: {} }, { cookie });
      assert.equal(noState.status, 400);
      assert.equal(await errorCode(noState), 'checkpoint-no-state');
      const cp1 = await h.post('/v1/ai-training/tasks/checkpoint', { taskId: 'task-1', step: 1, state: { loss: 0.5 } }, { cookie });
      assert.equal(cp1.status, 200);
      const cp1Body = (await cp1.json()) as { checkpoint: { checkpointId: string; step: number }; task: { checkpointCount: number } };
      assert.equal(cp1Body.checkpoint.checkpointId, 'ltc_task-1_0');
      assert.equal(cp1Body.checkpoint.step, 1);
      assert.equal(cp1Body.task.checkpointCount, 1);
      const cp2 = await h.post('/v1/ai-training/tasks/checkpoint', { taskId: 'task-1', step: 3, state: { loss: 0.3, note: 'x' } }, { cookie });
      assert.equal(((await cp2.json()) as { checkpoint: { checkpointId: string } }).checkpoint.checkpointId, 'ltc_task-1_1');

      const paused = await h.post('/v1/ai-training/tasks/pause', { taskId: 'task-1' }, { cookie });
      assert.equal(paused.status, 200);
      assert.equal(((await paused.json()) as { task: { status: string } }).task.status, 'paused');
      const cpWhilePaused = await h.post('/v1/ai-training/tasks/checkpoint', { taskId: 'task-1', step: 4, state: { a: 1 } }, { cookie });
      assert.equal(cpWhilePaused.status, 400);
      assert.equal(await errorCode(cpWhilePaused), 'task-not-running:paused');
      const resumeUnknown = await h.post('/v1/ai-training/tasks/resume', { taskId: 'task-1', fromCheckpointId: 'ltc_task-1_99' }, { cookie });
      assert.equal(resumeUnknown.status, 400);
      assert.equal(await errorCode(resumeUnknown), 'checkpoint-unknown:ltc_task-1_99');
      const resumed = await h.post('/v1/ai-training/tasks/resume', { taskId: 'task-1', fromCheckpointId: 'ltc_task-1_1' }, { cookie });
      assert.equal(resumed.status, 200);
      const resumedBody = (await resumed.json()) as { task: { status: string; resumedFrom: string | null } };
      assert.equal(resumedBody.task.status, 'running');
      assert.equal(resumedBody.task.resumedFrom, 'ltc_task-1_1');

      const paused2 = await h.post('/v1/ai-training/tasks/pause', { taskId: 'task-1' }, { cookie });
      assert.equal(paused2.status, 200);
      const resumed2 = await h.post('/v1/ai-training/tasks/resume', { taskId: 'task-1' }, { cookie });
      assert.equal(((await resumed2.json()) as { task: { resumedFrom: string | null } }).task.resumedFrom, 'ltc_task-1_1');

      const completed = await h.post('/v1/ai-training/tasks/complete', { taskId: 'task-1' }, { cookie });
      assert.equal(completed.status, 200);
      assert.equal(((await completed.json()) as { task: { status: string } }).task.status, 'completed');
      const pauseAfter = await h.post('/v1/ai-training/tasks/pause', { taskId: 'task-1' }, { cookie });
      assert.equal(pauseAfter.status, 400);
      assert.equal(await errorCode(pauseAfter), 'task-not-running:completed');
      const status = await h.post('/v1/ai-training/tasks/status', { taskId: 'task-1' }, { cookie });
      assert.equal(status.status, 200);
      assert.equal(((await status.json()) as { task: { status: string } }).task.status, 'completed');
      const missing = await h.post('/v1/ai-training/tasks/status', { taskId: 'ghost' }, { cookie });
      assert.equal(missing.status, 404);
      assert.equal(await errorCode(missing), 'longrunning-task-not-found:ghost');
    } finally {
      await h.close();
    }
  });

  it('enforces per-task budgets: atomic charges, honest breach, no silent spend (AI-085)', async () => {
    const h = await startHarness();
    try {
      const register = await h.post('/v1/auth/register', { email: 'budget@forge.test', password: GOOD_PASSWORD, displayName: 'Budgeter' });
      await setPlanForTest(h, ((await register.json()) as { user: { id: string } }).user.id, 'enterprise');
      const cookie = sessionCookie(await h.post('/v1/auth/sign-in', { email: 'budget@forge.test', password: GOOD_PASSWORD }));

      const noLimits = await h.post('/v1/ai-training/tasks/budget/define', { taskId: 'b1', limits: {} }, { cookie });
      assert.equal(noLimits.status, 400);
      assert.equal(await errorCode(noLimits), 'budget-no-limits');
      const badLimit = await h.post('/v1/ai-training/tasks/budget/define', { taskId: 'b1', limits: { timeMs: 0 } }, { cookie });
      assert.equal(badLimit.status, 400);
      assert.equal(await errorCode(badLimit), 'budget-limit-invalid:timeMs');
      const defined = await h.post('/v1/ai-training/tasks/budget/define', { taskId: 'b1', limits: { timeMs: 100, costUsdMicros: 500 } }, { cookie });
      assert.equal(defined.status, 201);
      const defBody = (await defined.json()) as { budget: { taskId: string; limits: Record<string, number>; spent: Record<string, number>; exceeded: string | null }; createdAt: number };
      assert.deepEqual(defBody.budget.limits, { timeMs: 100, costUsdMicros: 500 });
      assert.deepEqual(defBody.budget.spent, { timeMs: 0, costUsdMicros: 0, toolCalls: 0 });
      assert.equal(defBody.budget.exceeded, null);
      const dup = await h.post('/v1/ai-training/tasks/budget/define', { taskId: 'b1', limits: { timeMs: 1 } }, { cookie });
      assert.equal(dup.status, 409);
      assert.equal(await errorCode(dup), 'task-budget-duplicate:b1');

      const badCharge = await h.post('/v1/ai-training/tasks/budget/charge', { taskId: 'b1', timeMs: -5 }, { cookie });
      assert.equal(badCharge.status, 400);
      assert.equal(await errorCode(badCharge), 'budget-charge-invalid:timeMs');
      const c1 = await h.post('/v1/ai-training/tasks/budget/charge', { taskId: 'b1', timeMs: 40, costUsdMicros: 200 }, { cookie });
      assert.equal(c1.status, 200);
      const c1Body = (await c1.json()) as { budget: { spent: Record<string, number>; exceeded: string | null } };
      assert.deepEqual({ timeMs: c1Body.budget.spent.timeMs, costUsdMicros: c1Body.budget.spent.costUsdMicros, exceeded: c1Body.budget.exceeded }, { timeMs: 40, costUsdMicros: 200, exceeded: null });

      const breach = await h.post('/v1/ai-training/tasks/budget/charge', { taskId: 'b1', costUsdMicros: 400 }, { cookie });
      assert.equal(breach.status, 200);
      const breachBody = (await breach.json()) as { budget: { spent: Record<string, number>; exceeded: string | null } };
      assert.equal(breachBody.budget.exceeded, 'costUsdMicros');
      assert.equal(breachBody.budget.spent.costUsdMicros, 600);
      const after = await h.post('/v1/ai-training/tasks/budget/charge', { taskId: 'b1', timeMs: 1 }, { cookie });
      assert.equal(after.status, 400);
      assert.equal(await errorCode(after), 'budget-already-exceeded:costUsdMicros');

      const status = await h.post('/v1/ai-training/tasks/budget/status', { taskId: 'b1' }, { cookie });
      assert.equal(status.status, 200);
      assert.equal(((await status.json()) as { budget: { exceeded: string | null } }).budget.exceeded, 'costUsdMicros');
      const missing = await h.post('/v1/ai-training/tasks/budget/charge', { taskId: 'ghost', timeMs: 1 }, { cookie });
      assert.equal(missing.status, 404);
      assert.equal(await errorCode(missing), 'task-budget-not-found:ghost');
    } finally {
      await h.close();
    }
  });
});
