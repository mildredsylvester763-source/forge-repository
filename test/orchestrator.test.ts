import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

async function signedInUser(h: Harness, email: string): Promise<string> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'Orchestrator Tester' });
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

describe('orchestrator routes (FORGE AI-073..078)', () => {
  it('refuses every route without a session', async () => {
    const h = await startHarness();
    try {
      const intents = await h.get('/v1/orchestrator/intents');
      assert.equal(intents.status, 401);
      assert.equal(await errorCode(intents), 'unauthenticated');
      const classify = await h.post('/v1/orchestrator/intent', { text: 'what' });
      assert.equal(classify.status, 401);
      const plans = await h.get('/v1/orchestrator/plans');
      assert.equal(plans.status, 401);
      const create = await h.post('/v1/orchestrator/plans', { goal: 'nope', steps: [{ action: 'search' }] });
      assert.equal(create.status, 401);
    } finally {
      await h.close();
    }
  });

  it('serves the engine catalogs to signed-in users', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'orch-catalogs@forge.test');
      assert.deepEqual(await (await h.get('/v1/orchestrator/intents', { cookie })).json(), { intents: ['question', 'command', 'creation', 'analysis', 'comparison', 'conversation'] });
      assert.deepEqual(await (await h.get('/v1/orchestrator/plan-actions', { cookie })).json(), { actions: ['search', 'write', 'run', 'verify', 'present'] });
      assert.deepEqual(await (await h.get('/v1/orchestrator/agents', { cookie })).json(), { agents: ['coordinator', 'researcher', 'writer', 'executor', 'reviewer'] });
      assert.deepEqual(await (await h.get('/v1/orchestrator/tool-classes', { cookie })).json(), { classes: ['read', 'write', 'exec', 'network'] });
      const tools = (await (await h.get('/v1/orchestrator/tools', { cookie })).json()) as { tools: Array<{ name: string; cls: string }> };
      assert.equal(tools.tools.length, 8);
      assert.deepEqual(tools.tools[0], { name: 'web-search', cls: 'read', description: 'Search the public web' });
    } finally {
      await h.close();
    }
  });

  it('classifies intents and previews plans through the sync wrappers', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'orch-intent@forge.test');
      const question = await h.post('/v1/orchestrator/intent', { text: 'what is a forge' }, { cookie });
      const questionBody = (await question.json()) as { verdict: { ok: boolean; intent: string; confidence: number } };
      assert.equal(questionBody.verdict.ok, true);
      assert.equal(questionBody.verdict.intent, 'question');
      assert.equal(questionBody.verdict.confidence, 1);
      const notAllowed = await h.post('/v1/orchestrator/intent', { text: 'what is a forge', allowed: ['command'] }, { cookie });
      assert.equal(notAllowed.status, 400);
      assert.equal(await errorCode(notAllowed), 'intent-not-allowed:question');
      const noMatch = await h.post('/v1/orchestrator/intent', { text: 'zzz qqq' }, { cookie });
      assert.equal(await errorCode(noMatch), 'intent-no-match');
      const missing = await h.post('/v1/orchestrator/intent', {}, { cookie });
      assert.equal(await errorCode(missing), 'intent-text-missing');

      const preview = await h.post('/v1/orchestrator/preview', { steps: [{ action: 'write', file: 'a.md' }] }, { cookie });
      const previewBody = (await preview.json()) as { verdict: { ok: boolean; risk: string; estimatedCost: number; requiresApproval: boolean; filesTouched: string[] } };
      assert.equal(previewBody.verdict.ok, true);
      assert.equal(previewBody.verdict.risk, 'medium');
      assert.equal(previewBody.verdict.estimatedCost, 1200);
      assert.equal(previewBody.verdict.requiresApproval, false);
      assert.deepEqual(previewBody.verdict.filesTouched, ['a.md']);
      const high = await h.post('/v1/orchestrator/preview', { steps: [{ action: 'run' }] }, { cookie });
      const highBody = (await high.json()) as { verdict: { risk: string; estimatedCost: number; requiresApproval: boolean } };
      assert.equal(highBody.verdict.risk, 'high');
      assert.equal(highBody.verdict.estimatedCost, 600);
      assert.equal(highBody.verdict.requiresApproval, true);
      const refused = await h.post('/v1/orchestrator/preview', { steps: [] }, { cookie });
      assert.equal(await errorCode(refused), 'preview-steps-empty');
    } finally {
      await h.close();
    }
  });

  it('assigns agents, checks tools and sandboxes actions', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'orch-agents@forge.test');
      const handoffs = await h.post('/v1/orchestrator/handoffs', { steps: [{ action: 'search' }, { action: 'write' }] }, { cookie });
      const handoffsBody = (await handoffs.json()) as {
        verdict: {
          assignments: Array<{ step: number; action: string; agent: string }>;
          handoffs: Array<{ from: string; to: string; atStep: number }>;
        };
      };
      assert.deepEqual(handoffsBody.verdict.assignments, [
        { step: 1, action: 'search', agent: 'researcher' },
        { step: 2, action: 'write', agent: 'writer' },
      ]);
      assert.deepEqual(handoffsBody.verdict.handoffs, [{ from: 'researcher', to: 'writer', atStep: 2 }]);
      const bounce = await h.post('/v1/orchestrator/handoffs', { steps: [{ action: 'search' }, { action: 'write' }, { action: 'search' }] }, { cookie });
      assert.equal(await errorCode(bounce), 'handoff-bounce-detected:researcher->writer->researcher');
      const badRoster = await h.post('/v1/orchestrator/handoffs', { steps: [{ action: 'search' }], roster: ['intern'] }, { cookie });
      assert.equal(await errorCode(badRoster), 'handoff-agent-unknown:intern');

      const allowed = await h.post('/v1/orchestrator/tools/check', { agent: 'researcher', tool: 'web-search' }, { cookie });
      const allowedBody = (await allowed.json()) as { verdict: { ok: boolean; cls: string } };
      assert.equal(allowedBody.verdict.ok, true);
      assert.equal(allowedBody.verdict.cls, 'read');
      const denied = await h.post('/v1/orchestrator/tools/check', { agent: 'coordinator', tool: 'shell-exec' }, { cookie });
      assert.equal(await errorCode(denied), 'tool-denied:coordinator:shell-exec');
      const plan = await h.post('/v1/orchestrator/tools/plan', { assignments: [{ agent: 'researcher', action: 'search' }] }, { cookie });
      const planBody = (await plan.json()) as { verdict: { required: Array<{ step: number; agent: string; action: string; tool: string }> } };
      assert.deepEqual(planBody.verdict.required, [{ step: 1, agent: 'researcher', action: 'search', tool: 'web-search' }]);
      const planDenied = await h.post('/v1/orchestrator/tools/plan', { assignments: [{ agent: 'coordinator', action: 'write' }] }, { cookie });
      assert.equal(await errorCode(planDenied), 'tool-denied:coordinator:fs-write');

      const sandbox = await h.post('/v1/orchestrator/sandbox', { tool: 'shell-exec', command: 'ls', timeout: 5 }, { cookie });
      const sandboxBody = (await sandbox.json()) as { verdict: { ok: boolean; timeout: number; restrictions: string[] } };
      assert.equal(sandboxBody.verdict.ok, true);
      assert.equal(sandboxBody.verdict.timeout, 5);
      assert.deepEqual(sandboxBody.verdict.restrictions, ['workspace-only-fs', 'no-network', 'timeout-5s']);
      const forbidden = await h.post('/v1/orchestrator/sandbox', { tool: 'shell-exec', command: 'rm -rf /' }, { cookie });
      assert.equal(await errorCode(forbidden), 'sandbox-command-forbidden:rm -rf /');
      const badTimeout = await h.post('/v1/orchestrator/sandbox', { tool: 'shell-exec', timeout: 0 }, { cookie });
      assert.equal(await errorCode(badTimeout), 'sandbox-timeout-invalid:0');
      const outside = await h.post('/v1/orchestrator/sandbox', { tool: 'fs-write', fileWrites: ['/etc/passwd'] }, { cookie });
      assert.equal(await errorCode(outside), 'sandbox-path-outside-workspace:/etc/passwd');
      const egress = await h.post('/v1/orchestrator/sandbox', { tool: 'web-fetch', egress: { host: 'evil.com' } }, { cookie });
      assert.equal(await errorCode(egress), 'sandbox-egress-denied:evil.com');
    } finally {
      await h.close();
    }
  });

  it('runs the full plan create, edit and get lifecycle', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'orch-lifecycle@forge.test');
      const create = await h.post('/v1/orchestrator/plans', { goal: 'ship the report', steps: [{ action: 'search' }, { action: 'write', file: 'doc.md' }] }, { cookie });
      assert.equal(create.status, 201);
      const created = (await create.json()) as {
        plan: {
          id: string;
          goal: string;
          intent: string;
          risk: string;
          estimatedCost: number;
          requiresApproval: boolean;
          stepCount: number;
          filesTouched: string[];
          steps: Array<{ id: string; action: string; dependsOn: string[] }>;
        };
      };
      assert.equal(created.plan.goal, 'ship the report');
      assert.equal(created.plan.intent, 'unclassified');
      assert.equal(created.plan.risk, 'medium');
      assert.equal(created.plan.estimatedCost, 1600);
      assert.equal(created.plan.requiresApproval, false);
      assert.equal(created.plan.stepCount, 2);
      assert.deepEqual(created.plan.filesTouched, ['doc.md']);
      assert.equal(created.plan.steps[0]?.id, 's1');
      assert.deepEqual(created.plan.steps[1]?.dependsOn, ['s1']);

      const explicit = await h.post('/v1/orchestrator/plans', { goal: 'hello there', steps: [{ action: 'present' }], intent: 'conversation' }, { cookie });
      const explicitBody = (await explicit.json()) as { plan: { id: string; intent: string; risk: string; estimatedCost: number } };
      assert.equal(explicitBody.plan.intent, 'conversation');
      assert.equal(explicitBody.plan.risk, 'low');
      assert.equal(explicitBody.plan.estimatedCost, 200);

      const unknownIntent = await h.post('/v1/orchestrator/plans', { goal: 'g', steps: [{ action: 'search' }], intent: 'zzz' }, { cookie });
      assert.equal(unknownIntent.status, 400);
      assert.equal(await errorCode(unknownIntent), 'plan-intent-unknown:zzz');
      const noGoal = await h.post('/v1/orchestrator/plans', { steps: [{ action: 'search' }] }, { cookie });
      assert.equal(await errorCode(noGoal), 'plan-goal-missing');
      const badAction = await h.post('/v1/orchestrator/plans', { goal: 'g', steps: [{ action: 'bogus' }] }, { cookie });
      assert.equal(await errorCode(badAction), 'plan-step-action-unknown:bogus');

      const edit = await h.post('/v1/orchestrator/plans/edit', { planId: created.plan.id, edits: [{ op: 'insert', index: 0, step: { action: 'verify' } }] }, { cookie });
      assert.equal(edit.status, 200);
      const edited = (await edit.json()) as {
        plan: { stepCount: number; estimatedCost: number; risk: string; intent: string; filesTouched: string[]; steps: Array<{ id: string; action: string }> };
      };
      assert.equal(edited.plan.stepCount, 3);
      assert.equal(edited.plan.steps[0]?.action, 'verify');
      assert.equal(edited.plan.steps[0]?.id, 's1');
      assert.equal(edited.plan.estimatedCost, 1900);
      assert.equal(edited.plan.risk, 'medium');
      assert.equal(edited.plan.intent, 'unclassified');
      assert.deepEqual(edited.plan.filesTouched, ['doc.md']);
      const emptyEdits = await h.post('/v1/orchestrator/plans/edit', { planId: created.plan.id, edits: [] }, { cookie });
      assert.equal(await errorCode(emptyEdits), 'plan-edits-empty');
      const missingPlan = await h.post('/v1/orchestrator/plans/edit', { planId: 'nope', edits: [{ op: 'remove', id: 's1' }] }, { cookie });
      assert.equal(missingPlan.status, 404);
      assert.equal(await errorCode(missingPlan), 'orchestrator_plan_not_found');

      const get = await h.post('/v1/orchestrator/plans/get', { planId: created.plan.id }, { cookie });
      assert.equal(get.status, 200);
      const fetched = (await get.json()) as { plan: { stepCount: number; estimatedCost: number } };
      assert.equal(fetched.plan.stepCount, 3);
      assert.equal(fetched.plan.estimatedCost, 1900);

      const list = await h.get('/v1/orchestrator/plans', { cookie });
      const listBody = (await list.json()) as { plans: Array<{ id: string }> };
      assert.equal(listBody.plans.length, 2);
      assert.equal(listBody.plans[0]?.id, explicitBody.plan.id);
      assert.equal(listBody.plans[1]?.id, created.plan.id);
    } finally {
      await h.close();
    }
  });

  it('isolates plans per user', async () => {
    const h = await startHarness();
    try {
      const cookieA = await signedInUser(h, 'orch-owner@forge.test');
      const cookieB = await signedInUser(h, 'orch-intruder@forge.test');
      const create = await h.post('/v1/orchestrator/plans', { goal: 'private goal', steps: [{ action: 'search' }] }, { cookie: cookieA });
      const created = (await create.json()) as { plan: { id: string } };
      const getB = await h.post('/v1/orchestrator/plans/get', { planId: created.plan.id }, { cookie: cookieB });
      assert.equal(getB.status, 404);
      assert.equal(await errorCode(getB), 'orchestrator_plan_not_found');
      const editB = await h.post('/v1/orchestrator/plans/edit', { planId: created.plan.id, edits: [{ op: 'remove', id: 's1' }] }, { cookie: cookieB });
      assert.equal(editB.status, 404);
      const listB = await h.get('/v1/orchestrator/plans', { cookie: cookieB });
      const listBBody = (await listB.json()) as { plans: unknown[] };
      assert.equal(listBBody.plans.length, 0);
      const getA = await h.post('/v1/orchestrator/plans/get', { planId: created.plan.id }, { cookie: cookieA });
      assert.equal(getA.status, 200);
    } finally {
      await h.close();
    }
  });

  it('validates plan request bodies strictly', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'orch-strict@forge.test');
      const created = (await (await h.post('/v1/orchestrator/plans', { goal: 'strict', steps: [{ action: 'search' }] }, { cookie })).json()) as { plan: { id: string } };
      const unknownField = await h.post('/v1/orchestrator/plans', { goal: 'x', steps: [{ action: 'search' }], bogus: 1 }, { cookie });
      assert.equal(unknownField.status, 400);
      assert.equal(await errorCode(unknownField), 'invalid_request');
      const badIntentType = await h.post('/v1/orchestrator/plans', { goal: 'x', steps: [{ action: 'search' }], intent: 5 }, { cookie });
      assert.equal(badIntentType.status, 400);
      assert.equal(await errorCode(badIntentType), 'invalid_request');
      const badPlanId = await h.post('/v1/orchestrator/plans/edit', { planId: 12, edits: [{ op: 'remove', id: 's1' }] }, { cookie });
      assert.equal(badPlanId.status, 400);
      assert.equal(await errorCode(badPlanId), 'invalid_request');
      const missingPlanId = await h.post('/v1/orchestrator/plans/edit', { edits: [] }, { cookie });
      assert.equal(missingPlanId.status, 400);
      const badEdits = await h.post('/v1/orchestrator/plans/edit', { planId: created.plan.id, edits: 'x' }, { cookie });
      assert.equal(badEdits.status, 400);
      assert.equal(await errorCode(badEdits), 'invalid_request');
      const getUnknown = await h.post('/v1/orchestrator/plans/get', { planId: created.plan.id, extra: 'x' }, { cookie });
      assert.equal(getUnknown.status, 400);
      assert.equal(await errorCode(getUnknown), 'invalid_request');
      const getMissing = await h.post('/v1/orchestrator/plans/get', {}, { cookie });
      assert.equal(getMissing.status, 400);
    } finally {
      await h.close();
    }
  });
});
