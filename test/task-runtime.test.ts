import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

async function signedInUser(h: Harness, email: string): Promise<string> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'Task Tester' });
  assert.equal(register.status, 201);
  const registered = (await register.json()) as { user: { id: string } };
  await h.app.plans.setPlan(registered.user.id, 'pro');
  const signIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signIn.status, 200);
  return sessionCookie(signIn);
}

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

describe('task runtime routes (FORGE AI-079..083)', () => {
  it('refuses every route without a session', async () => {
    const h = await startHarness();
    try {
      const states = await h.get('/v1/tasks/states');
      assert.equal(states.status, 401);
      assert.equal(await errorCode(states), 'unauthenticated');
      const runs = await h.post('/v1/tasks/runs', { goal: 'nope' });
      assert.equal(runs.status, 401);
      const conflicts = await h.post('/v1/tasks/parallel/conflicts', { agents: [] });
      assert.equal(conflicts.status, 401);
    } finally {
      await h.close();
    }
  });

  it('serves the engine catalogs to signed-in users', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'task-catalogs@forge.test');
      assert.deepEqual(await (await h.get('/v1/tasks/step/checks', { cookie })).json(), { checks: ['exit-code', 'field', 'max-length', 'contains', 'equals'] });
      assert.deepEqual(await (await h.get('/v1/tasks/approval/risks', { cookie })).json(), { risks: ['low', 'medium', 'high'] });
      assert.deepEqual(await (await h.get('/v1/tasks/approval/tool-classes', { cookie })).json(), { toolClasses: ['read', 'write', 'exec', 'network'] });
      assert.deepEqual(await (await h.get('/v1/tasks/states', { cookie })).json(), { states: ['running', 'paused', 'cancelled', 'completed', 'failed', 'overtaken'] });
      assert.deepEqual(await (await h.get('/v1/tasks/commands', { cookie })).json(), { commands: ['pause', 'resume', 'cancel', 'takeover'] });
      const events = (await (await h.get('/v1/tasks/events', { cookie })).json()) as { events: string[] };
      assert.equal(events.events.length, 13);
      assert.deepEqual(await (await h.get('/v1/tasks/parallel/modes', { cookie })).json(), { modes: ['strict', 'relaxed'] });
    } finally {
      await h.close();
    }
  });

  it('returns failed step checks as verdicts and refusals by name', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'task-step@forge.test');
      const failed = await h.post(
        '/v1/tasks/step/validate',
        { stepId: 's1', output: { exitCode: 1, title: '' }, checks: [{ type: 'exit-code' }, { type: 'field', path: 'title' }] },
        { cookie },
      );
      assert.equal(failed.status, 200);
      const failedBody = (await failed.json()) as { verdict: { ok: boolean; failed: number; failures: Array<{ detail: string }> } };
      assert.equal(failedBody.verdict.ok, false);
      assert.equal(failedBody.verdict.failed, 2);
      assert.deepEqual(failedBody.verdict.failures.map((f) => f.detail), ['exit:1', 'field-empty:title']);
      const passed = await h.post(
        '/v1/tasks/step/validate',
        { stepId: 's1', output: { exitCode: 0 }, checks: [{ type: 'exit-code' }] },
        { cookie },
      );
      const passedBody = (await passed.json()) as { verdict: { ok: boolean } };
      assert.equal(passedBody.verdict.ok, true);
      const refused = await h.post('/v1/tasks/step/validate', { stepId: 's1', checks: [] }, { cookie });
      assert.equal(refused.status, 400);
      assert.equal(await errorCode(refused), 'stepv-checks-empty');
      const noStepId = await h.post('/v1/tasks/step/validate', { checks: [] }, { cookie });
      assert.equal(await errorCode(noStepId), 'stepv-step-id-missing');
    } finally {
      await h.close();
    }
  });

  it('plans and resolves approval gates', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'task-approval@forge.test');
      const gated = await h.post('/v1/tasks/approval/plan', { risk: 'high', toolClass: 'read', cost: 10 }, { cookie });
      const gatedBody = (await gated.json()) as { verdict: { requiresApproval: boolean; triggers: string[] } };
      assert.equal(gatedBody.verdict.requiresApproval, true);
      assert.deepEqual(gatedBody.verdict.triggers, ['risk:high']);
      const auto = await h.post('/v1/tasks/approval/plan', { risk: 'low', toolClass: 'read', cost: 10 }, { cookie });
      const autoBody = (await auto.json()) as { verdict: { requiresApproval: boolean; triggers: string[] } };
      assert.equal(autoBody.verdict.requiresApproval, false);
      assert.deepEqual(autoBody.verdict.triggers, []);
      const refused = await h.post('/v1/tasks/approval/plan', { risk: 'urgent', toolClass: 'read', cost: 10 }, { cookie });
      assert.equal(refused.status, 400);
      assert.equal(await errorCode(refused), 'approval-risk-invalid');
      const rejected = await h.post('/v1/tasks/approval/resolve', { gateId: 'g1', decision: 'reject', reason: ' over budget ' }, { cookie });
      const rejectedBody = (await rejected.json()) as { verdict: { decision: string; reasonText: string } };
      assert.equal(rejectedBody.verdict.decision, 'reject');
      assert.equal(rejectedBody.verdict.reasonText, 'over budget');
      const noReason = await h.post('/v1/tasks/approval/resolve', { gateId: 'g1', decision: 'reject', reason: '   ' }, { cookie });
      assert.equal(await errorCode(noReason), 'approval-reject-reason-missing');
    } finally {
      await h.close();
    }
  });

  it('applies task commands and refuses illegal transitions by name', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'task-command@forge.test');
      const paused = await h.post('/v1/tasks/command', { state: 'running', command: 'pause' }, { cookie });
      const pausedBody = (await paused.json()) as { verdict: { to: string; terminal: boolean } };
      assert.equal(pausedBody.verdict.to, 'paused');
      assert.equal(pausedBody.verdict.terminal, false);
      const resumed = await h.post('/v1/tasks/command', { state: 'paused', command: 'resume' }, { cookie });
      const resumedBody = (await resumed.json()) as { verdict: { to: string } };
      assert.equal(resumedBody.verdict.to, 'running');
      const terminal = await h.post('/v1/tasks/command', { state: 'completed', command: 'pause' }, { cookie });
      assert.equal(terminal.status, 400);
      assert.equal(await errorCode(terminal), 'task-invalid-transition:completed:pause');
      const unknown = await h.post('/v1/tasks/command', { state: 'running', command: 'rewind' }, { cookie });
      assert.equal(await errorCode(unknown), 'task-command-unknown:rewind');
    } finally {
      await h.close();
    }
  });

  it('detects parallel agent conflicts', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'task-parallel@forge.test');
      const verdict = await h.post(
        '/v1/tasks/parallel/conflicts',
        { agents: [{ agentId: 'a1', writes: ['db.users'] }, { agentId: 'a2', reads: ['db.users'] }] },
        { cookie },
      );
      const body = (await verdict.json()) as { verdict: { ok: boolean; hasConflicts: boolean; conflicts: Array<{ a: string; b: string; resource: string; kind: string }> } };
      assert.equal(body.verdict.ok, true);
      assert.equal(body.verdict.hasConflicts, true);
      assert.deepEqual(body.verdict.conflicts, [{ a: 'a1', b: 'a2', resource: 'db.users', kind: 'read-write' }]);
      const refused = await h.post('/v1/tasks/parallel/conflicts', { agents: [] }, { cookie });
      assert.equal(refused.status, 400);
      assert.equal(await errorCode(refused), 'parallel-agents-empty');
    } finally {
      await h.close();
    }
  });

  it('runs the full create, record and replay lifecycle', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'task-lifecycle@forge.test');
      const create = await h.post('/v1/tasks/runs', { goal: 'ship the report' }, { cookie });
      assert.equal(create.status, 201);
      const created = (await create.json()) as { run: { id: string; state: string; goal: string; eventCount: number } };
      assert.equal(created.run.state, 'running');
      assert.equal(created.run.goal, 'ship the report');
      assert.equal(created.run.eventCount, 1);

      const pause = await h.post('/v1/tasks/runs/event', { runId: created.run.id, type: 'task-paused' }, { cookie });
      assert.equal(pause.status, 200);
      const pausedBody = (await pause.json()) as { run: { state: string }; seq: number };
      assert.equal(pausedBody.run.state, 'paused');
      assert.equal(pausedBody.seq, 2);

      await h.post('/v1/tasks/runs/event', { runId: created.run.id, type: 'task-resumed' }, { cookie });
      await h.post('/v1/tasks/runs/event', { runId: created.run.id, type: 'step-started', stepId: 's1' }, { cookie });
      await h.post('/v1/tasks/runs/event', { runId: created.run.id, type: 'gate-requested', gateId: 'g1' }, { cookie });

      const full = await h.post('/v1/tasks/runs/replay', { runId: created.run.id }, { cookie });
      assert.equal(full.status, 200);
      const fullBody = (await full.json()) as {
        replay: { seq: number; applied: number; state: string; steps: Array<{ stepId: string; status: string }>; gates: Array<{ gateId: string; status: string }> };
      };
      assert.equal(fullBody.replay.seq, 5);
      assert.equal(fullBody.replay.applied, 5);
      assert.equal(fullBody.replay.state, 'running');
      assert.deepEqual(fullBody.replay.steps, [{ stepId: 's1', status: 'started' }]);
      assert.deepEqual(fullBody.replay.gates, [{ gateId: 'g1', status: 'requested' }]);

      const mid = await h.post('/v1/tasks/runs/replay', { runId: created.run.id, toSeq: 2 }, { cookie });
      const midBody = (await mid.json()) as { replay: { state: string; applied: number } };
      assert.equal(midBody.replay.state, 'paused');
      assert.equal(midBody.replay.applied, 2);

      const outOfBounds = await h.post('/v1/tasks/runs/replay', { runId: created.run.id, toSeq: 99 }, { cookie });
      assert.equal(outOfBounds.status, 400);
      assert.equal(await errorCode(outOfBounds), 'history-to-seq-invalid:99');

      const unknownType = await h.post('/v1/tasks/runs/event', { runId: created.run.id, type: 'teleport' }, { cookie });
      assert.equal(await errorCode(unknownType), 'history-type-unknown:teleport');

      const listed = await h.get('/v1/tasks/runs', { cookie });
      const listBody = (await listed.json()) as { runs: Array<{ id: string; state: string; eventCount: number }> };
      assert.equal(listBody.runs.length, 1);
      assert.equal(listBody.runs[0]?.id, created.run.id);
      assert.equal(listBody.runs[0]?.eventCount, 5);
    } finally {
      await h.close();
    }
  });

  it('isolates runs per user', async () => {
    const h = await startHarness();
    try {
      const cookieA = await signedInUser(h, 'task-owner@forge.test');
      const cookieB = await signedInUser(h, 'task-intruder@forge.test');
      const create = await h.post('/v1/tasks/runs', { goal: 'private goal' }, { cookie: cookieA });
      const created = (await create.json()) as { run: { id: string } };
      const replayB = await h.post('/v1/tasks/runs/replay', { runId: created.run.id }, { cookie: cookieB });
      assert.equal(replayB.status, 404);
      assert.equal(await errorCode(replayB), 'task_run_not_found');
      const recordB = await h.post('/v1/tasks/runs/event', { runId: created.run.id, type: 'task-paused' }, { cookie: cookieB });
      assert.equal(recordB.status, 404);
      const listB = await h.get('/v1/tasks/runs', { cookie: cookieB });
      const listBBody = (await listB.json()) as { runs: unknown[] };
      assert.equal(listBBody.runs.length, 0);
      const replayA = await h.post('/v1/tasks/runs/replay', { runId: created.run.id }, { cookie: cookieA });
      assert.equal(replayA.status, 200);
    } finally {
      await h.close();
    }
  });

  it('validates run request bodies strictly', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'task-strict@forge.test');
      const noGoal = await h.post('/v1/tasks/runs', {}, { cookie });
      assert.equal(noGoal.status, 201);
      const noGoalBody = (await noGoal.json()) as { run: { goal: string } };
      assert.equal(noGoalBody.run.goal, '');
      const longGoal = await h.post('/v1/tasks/runs', { goal: 'g'.repeat(501) }, { cookie });
      assert.equal(longGoal.status, 400);
      assert.equal(await errorCode(longGoal), 'invalid_request');
      const created = (await (await h.post('/v1/tasks/runs', { goal: 'strict' }, { cookie })).json()) as { run: { id: string } };
      const unknownField = await h.post('/v1/tasks/runs/replay', { runId: created.run.id, bogus: 1 }, { cookie });
      assert.equal(unknownField.status, 400);
      assert.equal(await errorCode(unknownField), 'invalid_request');
      const badToSeq = await h.post('/v1/tasks/runs/replay', { runId: created.run.id, toSeq: 2.5 }, { cookie });
      assert.equal(badToSeq.status, 400);
      const missingRunId = await h.post('/v1/tasks/runs/replay', {}, { cookie });
      assert.equal(missingRunId.status, 400);
      const eventUnknown = await h.post('/v1/tasks/runs/event', { runId: created.run.id, type: 'task-paused', extra: 'x' }, { cookie });
      assert.equal(eventUnknown.status, 400);
    } finally {
      await h.close();
    }
  });
});
