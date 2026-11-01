import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

interface TestUser {
  cookie: string;
  id: string;
}

async function signedInUser(h: Harness, email: string): Promise<TestUser> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'LT Tester' });
  assert.equal(register.status, 201);
  const created = (await register.json()) as { user: { id: string } };
  const signIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signIn.status, 200);
  return { cookie: sessionCookie(signIn), id: created.user.id };
}

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

const createSession = (h: Harness, cookie: string, body: unknown) =>
  h.post('/v1/live-testing/sessions', body, { cookie });

const start = (h: Harness, cookie: string, sessionId: string) =>
  h.post('/v1/live-testing/sessions/start', { sessionId }, { cookie });

describe('live testing routes (FORGE TQ-001..018)', () => {
  it('refuses every route without a session', async () => {
    const h = await startHarness();
    try {
      const personas = await h.get('/v1/live-testing/personas');
      assert.equal(personas.status, 401);
      assert.equal(await errorCode(personas), 'unauthenticated');
      const sessions = await h.get('/v1/live-testing/sessions');
      assert.equal(sessions.status, 401);
      const create = await h.post('/v1/live-testing/sessions', { goal: 'x', platform: 'web' });
      assert.equal(create.status, 401);
      const roles = await h.get('/v1/live-testing/collaboration/roles');
      assert.equal(roles.status, 401);
    } finally {
      await h.close();
    }
  });

  it('serves the engine catalogs to signed-in users', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'lt-catalogs@forge.test');
      const personas = await (await h.get('/v1/live-testing/personas', { cookie: user.cookie })).json();
      assert.deepEqual(personas, {
        personas: [
          'impatient-user',
          'low-vision-user',
          'motor-impaired-user',
          'new-user',
          'power-user',
          'screen-reader-user',
        ],
      });
      const roles = await (await h.get('/v1/live-testing/collaboration/roles', { cookie: user.cookie })).json();
      assert.deepEqual(roles, {
        roles: [
          { role: 'owner', capabilities: ['lifecycle', 'steps', 'messages', 'findings', 'control'] },
          { role: 'tester', capabilities: ['steps', 'messages', 'findings'] },
          { role: 'observer', capabilities: ['messages'] },
        ],
      });
    } finally {
      await h.close();
    }
  });

  it('refuses malformed session creation by name', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'lt-create@forge.test');
      const badPlatform = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'watch' });
      assert.equal(badPlatform.status, 400);
      assert.equal(await errorCode(badPlatform), 'platform-unknown:watch');
      const badGoal = await createSession(h, user.cookie, { goal: '', platform: 'web' });
      assert.equal(await errorCode(badGoal), 'goal-empty');
      const badPersona = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'web', persona: 'ghost' });
      assert.equal(await errorCode(badPersona), 'persona-unknown:ghost');
      const badEnv = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'web', environment: 'moon' });
      assert.equal(badEnv.status, 201);
    } finally {
      await h.close();
    }
  });

  it('runs the full session lifecycle with manual control', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'lt-lifecycle@forge.test');
      const created = await createSession(h, user.cookie, {
        goal: 'log in\nthen buy milk\nthen log in',
        platform: 'web',
        title: 'Milk run',
      });
      assert.equal(created.status, 201);
      const session = (await created.json()) as { session: Record<string, unknown> };
      assert.equal(session.session.status, 'planned');
      assert.equal(session.session.safeMode, true);
      assert.equal(session.session.forcedSafeMode, false);
      assert.equal(session.session.title, 'Milk run');
      const tasks = session.session.goalTasks as Array<{ id: string; text: string }>;
      assert.deepEqual(tasks.map((t) => t.text), ['log in', 'buy milk']);
      const id = session.session.id as string;

      const started = await start(h, user.cookie, id);
      assert.equal(started.status, 200);
      assert.equal(((await started.json()) as { session: { status: string; startedAt: number } }).session.status, 'running');

      const paused = await h.post('/v1/live-testing/sessions/pause', { sessionId: id }, { cookie: user.cookie });
      assert.equal(((await paused.json()) as { session: { status: string } }).session.status, 'paused');

      const control = await h.post('/v1/live-testing/sessions/control', { sessionId: id }, { cookie: user.cookie });
      assert.equal(((await control.json()) as { session: { status: string } }).session.status, 'manual');

      const handBack = await h.post('/v1/live-testing/sessions/hand-back', { sessionId: id }, { cookie: user.cookie });
      assert.equal(((await handBack.json()) as { session: { status: string } }).session.status, 'running');

      const done = await h.post('/v1/live-testing/sessions/complete', { sessionId: id }, { cookie: user.cookie });
      assert.equal(((await done.json()) as { session: { status: string; endedAt: number } }).session.status, 'completed');

      const restart = await start(h, user.cookie, id);
      assert.equal(restart.status, 400);
      assert.equal(await errorCode(restart), 'session-terminal:completed');

      const controlAgain = await h.post('/v1/live-testing/sessions/control', { sessionId: id }, { cookie: user.cookie });
      assert.equal(await errorCode(controlAgain), 'session-control-refused:completed');
    } finally {
      await h.close();
    }
  });

  it('evaluates safe mode before the platform vocabulary', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'lt-safemode@forge.test');
      const production = await createSession(h, user.cookie, {
        goal: 'buy milk',
        platform: 'web',
        environment: 'production',
        safeMode: false,
      });
      const prod = (await production.json()) as { session: { id: string; safeMode: boolean; forcedSafeMode: boolean } };
      assert.equal(prod.session.safeMode, true);
      assert.equal(prod.session.forcedSafeMode, true);
      await start(h, user.cookie, prod.session.id);
      const pay = await h.post(
        '/v1/live-testing/sessions/steps',
        { sessionId: prod.session.id, action: 'pay' },
        { cookie: user.cookie },
      );
      assert.equal(await errorCode(pay), 'safe-mode-blocks-payment:pay');

      const staging = await createSession(h, user.cookie, {
        goal: 'buy milk',
        platform: 'web',
        environment: 'staging',
        safeMode: false,
      });
      const st = (await staging.json()) as { session: { id: string; safeMode: boolean } };
      assert.equal(st.session.safeMode, false);
      await start(h, user.cookie, st.session.id);
      const payOff = await h.post(
        '/v1/live-testing/sessions/steps',
        { sessionId: st.session.id, action: 'pay' },
        { cookie: user.cookie },
      );
      assert.equal(await errorCode(payOff), 'platform-action-unknown:pay');

      const safeStaging = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'web' });
      const ss = (await safeStaging.json()) as { session: { id: string } };
      await start(h, user.cookie, ss.session.id);
      const emailStep = await h.post(
        '/v1/live-testing/sessions/steps',
        { sessionId: ss.session.id, action: 'click', target: 'next', value: 'user@real.example' },
        { cookie: user.cookie },
      );
      assert.equal(await errorCode(emailStep), 'safe-mode-blocks-real-address:click');
      const cleanStep = await h.post(
        '/v1/live-testing/sessions/steps',
        { sessionId: ss.session.id, action: 'click', target: 'next' },
        { cookie: user.cookie },
      );
      assert.equal(cleanStep.status, 201);
    } finally {
      await h.close();
    }
  });

  it('enforces the platform vocabulary and narration rules', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'lt-vocab@forge.test');
      const created = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'web' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;
      await start(h, user.cookie, id);

      const tap = await h.post('/v1/live-testing/sessions/steps', { sessionId: id, action: 'tap', target: 'x' }, { cookie: user.cookie });
      assert.equal(await errorCode(tap), 'platform-action-unsupported:tap:web');

      const missingAction = await h.post('/v1/live-testing/sessions/steps', { sessionId: id }, { cookie: user.cookie });
      assert.equal(await errorCode(missingAction), 'safe-mode-action-missing');

      const noTarget = await h.post('/v1/live-testing/sessions/steps', { sessionId: id, action: 'click' }, { cookie: user.cookie });
      assert.equal(await errorCode(noTarget), 'narration-missing-target:click');

      const typed = await h.post(
        '/v1/live-testing/sessions/steps',
        { sessionId: id, action: 'type', target: '#email', value: 'secret-value' },
        { cookie: user.cookie },
      );
      assert.equal(typed.status, 201);
      const step = (await typed.json()) as { step: Record<string, unknown> };
      assert.equal(step.step.narration, 'Typing 12 characters into #email');
      assert.equal(step.step.seq, 1);
      assert.equal((step.step.payload as { value: string }).value, 'secret-value');

      const android = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'android' });
      const aid = ((await android.json()) as { session: { id: string } }).session.id;
      await start(h, user.cookie, aid);
      const install = await h.post('/v1/live-testing/sessions/steps', { sessionId: aid, action: 'install' }, { cookie: user.cookie });
      assert.equal(install.status, 201);
      assert.equal(((await install.json()) as { step: { narration: string } }).step.narration, 'Installing the app build');
    } finally {
      await h.close();
    }
  });

  it('records messages, findings, bug reports, timelines and conversions', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'lt-artifacts@forge.test');
      const created = await createSession(h, user.cookie, { goal: 'buy milk\nthen check out', platform: 'web' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;

      const beforeStart = await h.post('/v1/live-testing/sessions/recording', { sessionId: id }, { cookie: user.cookie });
      assert.equal(await errorCode(beforeStart), 'recording-not-started');
      await start(h, user.cookie, id);

      await h.post('/v1/live-testing/sessions/steps', { sessionId: id, action: 'click', target: 'login' }, { cookie: user.cookie });
      await h.post('/v1/live-testing/sessions/steps', { sessionId: id, action: 'click', target: 'cart' }, { cookie: user.cookie });

      const message = await h.post('/v1/live-testing/sessions/messages', { sessionId: id, body: '  what are you doing?  ' }, { cookie: user.cookie });
      assert.equal(message.status, 201);
      assert.equal(((await message.json()) as { message: { body: string; role: string } }).message.body, 'what are you doing?');
      const emptyMessage = await h.post('/v1/live-testing/sessions/messages', { sessionId: id, body: '   ' }, { cookie: user.cookie });
      assert.equal(await errorCode(emptyMessage), 'message-empty');

      const noFindings = await h.post('/v1/live-testing/sessions/bug-report', { sessionId: id }, { cookie: user.cookie });
      assert.equal(await errorCode(noFindings), 'bugreport-none');

      const badSeverity = await h.post('/v1/live-testing/sessions/findings', { sessionId: id, severity: 9, title: 'Broken cart' }, { cookie: user.cookie });
      assert.equal(await errorCode(badSeverity), 'finding-severity-invalid');
      const badCommit = await h.post('/v1/live-testing/sessions/findings', { sessionId: id, severity: 4, title: 'Broken cart', suspectedCommit: 'zzz!' }, { cookie: user.cookie });
      assert.equal(await errorCode(badCommit), 'finding-commit-invalid');

      const finding = await h.post('/v1/live-testing/sessions/findings', {
        sessionId: id,
        severity: 4,
        title: 'Broken cart',
        reproSteps: ['open cart', 'remove item'],
        evidence: { screenshot: 'cart.png' },
        suspectedCommit: 'abc1234',
      }, { cookie: user.cookie });
      assert.equal(finding.status, 201);

      const recording = await h.post('/v1/live-testing/sessions/recording', { sessionId: id }, { cookie: user.cookie });
      assert.equal(recording.status, 200);
      const rec = (await recording.json()) as { events: Array<{ id: string; kind: string; label: string; offsetMs: number }>; durationMs: number };
      assert.deepEqual(rec.events, [
        { id: 'event-1', kind: 'step', label: 'Clicking login', offsetMs: 0 },
        { id: 'event-2', kind: 'step', label: 'Clicking cart', offsetMs: 0 },
      ]);
      assert.equal(rec.durationMs, 0);

      const bugReport = await h.post('/v1/live-testing/sessions/bug-report', { sessionId: id }, { cookie: user.cookie });
      assert.equal(bugReport.status, 200);
      const report = (await bugReport.json()) as { report: Record<string, unknown> };
      assert.equal(report.report.severityLabel, 'critical');
      assert.equal(report.report.dedupeKey, id + '|4|broken cart');
      assert.equal(report.report.suspectedCommit, 'abc1234');
      const reproLines = report.report.reproLines as string[];
      assert.deepEqual(reproLines, ['Clicking login', 'Clicking cart', 'open cart remove item']);

      const converted = await h.post('/v1/live-testing/sessions/convert', { sessionId: id }, { cookie: user.cookie });
      assert.equal(converted.status, 200);
      assert.deepEqual((await converted.json()) as unknown, {
        sessionId: id,
        testCase: {
          name: 'buy milk',
          caseSteps: [
            { id: 'case-1', line: 'click login' },
            { id: 'case-2', line: 'click cart' },
          ],
          expected: 'All 2 steps replay in the same order',
        },
      });

      const emptySession = await createSession(h, user.cookie, { goal: 'rest', platform: 'web' });
      const eid = ((await emptySession.json()) as { session: { id: string } }).session.id;
      await start(h, user.cookie, eid);
      const convertEmpty = await h.post('/v1/live-testing/sessions/convert', { sessionId: eid }, { cookie: user.cookie });
      assert.equal(await errorCode(convertEmpty), 'conversion-empty');

      const detail = await h.post('/v1/live-testing/sessions/get', { sessionId: id }, { cookie: user.cookie });
      const detailBody = (await detail.json()) as { stepCount: number; messageCount: number; findings: unknown[] };
      assert.equal(detailBody.stepCount, 2);
      assert.equal(detailBody.messageCount, 1);
      assert.equal(detailBody.findings.length, 1);
    } finally {
      await h.close();
    }
  });

  it('manages custom personas beside the builtin catalog', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'lt-personas@forge.test');
      const builtin = await h.post('/v1/live-testing/personas/custom', { name: 'new-user' }, { cookie: user.cookie });
      assert.equal(await errorCode(builtin), 'persona-duplicate:new-user');

      const created = await h.post('/v1/live-testing/personas/custom', {
        name: 'Night Owl',
        traits: ['nocturnal'],
        checklist: ['dark-mode'],
        paceMultiplier: 2,
      }, { cookie: user.cookie });
      assert.equal(created.status, 201);
      const persona = (await created.json()) as { persona: { id: string; name: string; paceMultiplier: number } };
      assert.equal(persona.persona.name, 'night owl');

      const dup = await h.post('/v1/live-testing/personas/custom', { name: 'night owl' }, { cookie: user.cookie });
      assert.equal(await errorCode(dup), 'persona-duplicate:night owl');
      const badPace = await h.post('/v1/live-testing/personas/custom', { name: 'fast', paceMultiplier: 9 }, { cookie: user.cookie });
      assert.equal(await errorCode(badPace), 'persona-pace-invalid');

      const listed = await h.post('/v1/live-testing/personas/custom/list', {}, { cookie: user.cookie });
      assert.equal(((await listed.json()) as { personas: unknown[] }).personas.length, 1);

      const session = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'web', persona: 'night owl' });
      assert.equal(((await session.json()) as { session: { persona: string } }).session.persona, 'night owl');

      const removed = await h.post('/v1/live-testing/personas/custom/delete', { personaId: persona.persona.id }, { cookie: user.cookie });
      assert.equal(removed.status, 200);
      const gone = await h.post('/v1/live-testing/personas/custom/delete', { personaId: persona.persona.id }, { cookie: user.cookie });
      assert.equal(await errorCode(gone), 'persona-not-found:' + persona.persona.id);
    } finally {
      await h.close();
    }
  });

  it('runs multi-user collaboration through the role matrix', async () => {
    const h = await startHarness();
    try {
      const owner = await signedInUser(h, 'lt-owner@forge.test');
      const tester = await signedInUser(h, 'lt-tester@forge.test');
      const observer = await signedInUser(h, 'lt-observer@forge.test');
      const stranger = await signedInUser(h, 'lt-stranger@forge.test');

      const created = await createSession(h, owner.cookie, { goal: 'buy milk', platform: 'web' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;
      await start(h, owner.cookie, id);

      const self = await h.post('/v1/live-testing/sessions/participants/invite', { sessionId: id, userId: owner.id }, { cookie: owner.cookie });
      assert.equal(await errorCode(self), 'collaboration-self-invite');
      const badRole = await h.post('/v1/live-testing/sessions/participants/invite', { sessionId: id, userId: tester.id, role: 'boss' }, { cookie: owner.cookie });
      assert.equal(await errorCode(badRole), 'collaboration-role-unknown:boss');

      const invited = await h.post('/v1/live-testing/sessions/participants/invite', { sessionId: id, userId: tester.id }, { cookie: owner.cookie });
      assert.equal(invited.status, 201);
      const dup = await h.post('/v1/live-testing/sessions/participants/invite', { sessionId: id, userId: tester.id }, { cookie: owner.cookie });
      assert.equal(await errorCode(dup), 'collaboration-participant-duplicate:' + tester.id);
      const pid = ((await invited.json()) as { participant: { id: string; role: string; state: string } }).participant.id;

      const strangerStep = await h.post('/v1/live-testing/sessions/steps', { sessionId: id, action: 'click', target: 'x' }, { cookie: stranger.cookie });
      assert.equal(await errorCode(strangerStep), 'session-not-found:' + id);

      const accepted = await h.post('/v1/live-testing/sessions/participants/accept', { participantId: pid }, { cookie: tester.cookie });
      assert.equal(accepted.status, 200);
      assert.equal(((await accepted.json()) as { participant: { state: string } }).participant.state, 'active');
      const doubleAccept = await h.post('/v1/live-testing/sessions/participants/accept', { participantId: pid }, { cookie: tester.cookie });
      assert.equal(await errorCode(doubleAccept), 'collaboration-state-invalid:active:accept');

      const testerStep = await h.post('/v1/live-testing/sessions/steps', { sessionId: id, action: 'click', target: 'login' }, { cookie: tester.cookie });
      assert.equal(testerStep.status, 201);
      const testerMessage = await h.post('/v1/live-testing/sessions/messages', { sessionId: id, body: 'hi' }, { cookie: tester.cookie });
      assert.equal(testerMessage.status, 201);
      const testerLifecycle = await h.post('/v1/live-testing/sessions/pause', { sessionId: id }, { cookie: tester.cookie });
      assert.equal(await errorCode(testerLifecycle), 'session-not-found:' + id);

      const observerInvited = await h.post('/v1/live-testing/sessions/participants/invite', { sessionId: id, userId: observer.id, role: 'observer' }, { cookie: owner.cookie });
      const opid = ((await observerInvited.json()) as { participant: { id: string } }).participant.id;
      await h.post('/v1/live-testing/sessions/participants/accept', { participantId: opid }, { cookie: observer.cookie });
      const observerStep = await h.post('/v1/live-testing/sessions/steps', { sessionId: id, action: 'click', target: 'x' }, { cookie: observer.cookie });
      assert.equal(await errorCode(observerStep), 'collaboration-capability-denied:observer:steps');
      const observerMessage = await h.post('/v1/live-testing/sessions/messages', { sessionId: id, body: 'watching' }, { cookie: observer.cookie });
      assert.equal(observerMessage.status, 201);

      const participants = await h.post('/v1/live-testing/sessions/participants/list', { sessionId: id }, { cookie: owner.cookie });
      assert.equal(((await participants.json()) as { participants: unknown[] }).participants.length, 2);

      const revoked = await h.post('/v1/live-testing/sessions/participants/revoke', { participantId: opid }, { cookie: owner.cookie });
      assert.equal(revoked.status, 200);
      const observerAfter = await h.post('/v1/live-testing/sessions/messages', { sessionId: id, body: 'hi again' }, { cookie: observer.cookie });
      assert.equal(await errorCode(observerAfter), 'session-not-found:' + id);

      const revokeByTester = await h.post('/v1/live-testing/sessions/participants/revoke', { participantId: pid }, { cookie: tester.cookie });
      assert.equal(await errorCode(revokeByTester), 'session-not-found:' + id);
    } finally {
      await h.close();
    }
  });

  it('isolates users from each others sessions', async () => {
    const h = await startHarness();
    try {
      const owner = await signedInUser(h, 'lt-iso-owner@forge.test');
      const other = await signedInUser(h, 'lt-iso-other@forge.test');
      const created = await createSession(h, owner.cookie, { goal: 'buy milk', platform: 'web' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;

      const list = await h.get('/v1/live-testing/sessions', { cookie: other.cookie });
      assert.equal(((await list.json()) as { sessions: unknown[] }).sessions.length, 0);

      const detail = await h.post('/v1/live-testing/sessions/get', { sessionId: id }, { cookie: other.cookie });
      assert.equal(await errorCode(detail), 'session-not-found:' + id);

      const unknownId = await h.post('/v1/live-testing/sessions/get', { sessionId: 'nope' }, { cookie: owner.cookie });
      assert.equal(await errorCode(unknownId), 'session-not-found:nope');

      const missingId = await h.post('/v1/live-testing/sessions/get', { sessionId: '  ' }, { cookie: owner.cookie });
      assert.equal(await errorCode(missingId), 'invalid_request');
    } finally {
      await h.close();
    }
  });

  it('lists the newest sessions per user', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'lt-list@forge.test');
      for (const goal of ['first errand', 'second errand', 'third errand']) {
        const created = await createSession(h, user.cookie, { goal, platform: 'web' });
        assert.equal(created.status, 201);
      }
      const list = await h.get('/v1/live-testing/sessions', { cookie: user.cookie });
      const body = (await list.json()) as { sessions: Array<{ goal: string; status: string }> };
      assert.equal(body.sessions.length, 3);
      assert.deepEqual(body.sessions.map((s) => s.goal).sort(), ['first errand', 'second errand', 'third errand']);
      assert.equal(body.sessions.every((s) => s.status === 'planned'), true);
    } finally {
      await h.close();
    }
  });
});
