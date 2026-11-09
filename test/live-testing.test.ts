import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, setPlanForTest, startHarness, type Harness } from './helpers.ts';

interface TestUser {
  cookie: string;
  id: string;
}

async function signedInUser(h: Harness, email: string): Promise<TestUser> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'LT Tester' });
  assert.equal(register.status, 201);
  const created = (await register.json()) as { user: { id: string } };
  await setPlanForTest(h, created.user.id, 'pro', ["creative"]);
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

describe('live testing routes (FORGE TQ-019..030)', () => {
  it('refuses the new routes without a session', async () => {
    const h = await startHarness();
    try {
      const devices = await h.get('/v1/live-testing/devices');
      assert.equal(devices.status, 401);
      const creative = await h.get('/v1/live-testing/creative');
      assert.equal(creative.status, 401);
      const interrupt = await h.post('/v1/live-testing/sessions/interrupt', { sessionId: 'x', scenario: 'incoming-call' });
      assert.equal(interrupt.status, 401);
      const seed = await h.post('/v1/live-testing/sessions/data/seed', { sessionId: 'x' });
      assert.equal(seed.status, 401);
      const codecs = await h.post('/v1/live-testing/av/codecs', { platform: 'web' });
      assert.equal(codecs.status, 401);
    } finally {
      await h.close();
    }
  });

  it('serves the device, interruption, permission, gesture, creative and av catalogs', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'ltx-catalogs@forge.test');
      const devBody = (await (await h.get('/v1/live-testing/devices', { cookie: user.cookie })).json()) as {
        devices: Array<{ device: string; platform: string; lowEnd: boolean; cpuThrottle: number }>;
        networks: Array<{ network: string }>;
      };
      assert.equal(devBody.devices.length, 12);
      assert.equal(devBody.networks.length, 6);
      assert.deepEqual(devBody.devices.find((d) => d.device === 'low-end-android'), {
        device: 'low-end-android',
        platform: 'android',
        lowEnd: true,
        cpuThrottle: 4,
      });

      const allScenarios = (await (await h.post('/v1/live-testing/interruptions', {}, { cookie: user.cookie })).json()) as { scenarios: unknown[] };
      assert.equal(allScenarios.scenarios.length, 7);
      const webScenarios = (await (await h.post('/v1/live-testing/interruptions', { platform: 'web' }, { cookie: user.cookie })).json()) as { scenarios: Array<{ scenario: string }> };
      assert.deepEqual(webScenarios.scenarios.map((s) => s.scenario), ['push-notification', 'network-drop']);
      const badPlatform = await h.post('/v1/live-testing/interruptions', { platform: 'watch' }, { cookie: user.cookie });
      assert.equal(await errorCode(badPlatform), 'platform-unknown:watch');

      const permissions = (await (await h.post('/v1/live-testing/permissions', { platform: 'web' }, { cookie: user.cookie })).json()) as { permissions: Array<{ platform: string; permissions: string[] }> };
      assert.deepEqual(permissions.permissions, [
        { platform: 'web', permissions: ['camera', 'clipboard-read', 'location', 'microphone', 'notifications'] },
      ]);

      const gestures = (await (await h.post('/v1/live-testing/gestures', {}, { cookie: user.cookie })).json()) as { gestures: unknown[] };
      assert.equal(gestures.gestures.length, 7);

      const creative = (await (await h.get('/v1/live-testing/creative', { cookie: user.cookie })).json()) as { editors: Record<string, string[]> };
      assert.deepEqual(Object.keys(creative.editors).sort(), ['manhwa', 'music', 'three-d']);
      assert.equal(creative.editors['manhwa']!.length, 7);

      const codecs = (await (await h.post('/v1/live-testing/av/codecs', { platform: 'web' }, { cookie: user.cookie })).json()) as { platform: string; video: string[]; audio: string[] };
      assert.deepEqual(codecs, { platform: 'web', video: ['h264', 'vp9', 'av1'], audio: ['aac', 'opus', 'mp3'] });
    } finally {
      await h.close();
    }
  });

  it('simulates live interruptions and pauses the session for manual resume', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'ltx-interrupt@forge.test');
      const created = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'android' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;
      await start(h, user.cookie, id);

      const interrupted = await h.post('/v1/live-testing/sessions/interrupt', { sessionId: id, scenario: 'incoming-call' }, { cookie: user.cookie });
      assert.equal(interrupted.status, 200);
      const body = (await interrupted.json()) as {
        session: { status: string };
        resume: string;
        dataLossRisk: boolean;
        step: { action: string; target: string | null; narration: string };
      };
      assert.equal(body.session.status, 'paused');
      assert.equal(body.resume, 'manual');
      assert.equal(body.dataLossRisk, true);
      assert.equal(body.step.action, 'interrupt');
      assert.equal(body.step.target, 'incoming-call');
      assert.equal(body.step.narration, 'Interrupting the session with Incoming call');

      const again = await h.post('/v1/live-testing/sessions/interrupt', { sessionId: id, scenario: 'incoming-call' }, { cookie: user.cookie });
      assert.equal(await errorCode(again), 'interruption-session-not-running:paused');

      const web = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'web' });
      const wid = ((await web.json()) as { session: { id: string } }).session.id;
      await start(h, user.cookie, wid);
      const unsupported = await h.post('/v1/live-testing/sessions/interrupt', { sessionId: wid, scenario: 'incoming-call' }, { cookie: user.cookie });
      assert.equal(await errorCode(unsupported), 'interruption-platform-unsupported:incoming-call:web');
    } finally {
      await h.close();
    }
  });

  it('stages permission plans and refuses terminal sessions', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'ltx-permissions@forge.test');
      const created = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'android' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;
      await start(h, user.cookie, id);

      const plan = await h.post(
        '/v1/live-testing/sessions/permissions',
        { sessionId: id, grants: [{ permission: 'camera', state: 'granted' }, { permission: 'location', state: 'ask' }] },
        { cookie: user.cookie },
      );
      assert.equal(plan.status, 200);
      const planBody = (await plan.json()) as { granted: number; denied: number; ask: number; step: { narration: string } };
      assert.deepEqual([planBody.granted, planBody.denied, planBody.ask], [1, 0, 1]);
      assert.equal(planBody.step.narration, 'Applying permission plan with 2 entries');

      const blocked = await h.post(
        '/v1/live-testing/sessions/permissions',
        { sessionId: id, grants: [{ permission: 'camera', state: 'blocked' }] },
        { cookie: user.cookie },
      );
      assert.equal(await errorCode(blocked), 'permission-state-not-planable:blocked');
      const unknown = await h.post(
        '/v1/live-testing/sessions/permissions',
        { sessionId: id, grants: [{ permission: 'photos', state: 'granted' }] },
        { cookie: user.cookie },
      );
      assert.equal(await errorCode(unknown), 'permission-unknown:photos:android');

      const done = await h.post('/v1/live-testing/sessions/complete', { sessionId: id }, { cookie: user.cookie });
      assert.equal(done.status, 200);
      const terminal = await h.post(
        '/v1/live-testing/sessions/permissions',
        { sessionId: id, grants: [{ permission: 'camera', state: 'granted' }] },
        { cookie: user.cookie },
      );
      assert.equal(await errorCode(terminal), 'permission-session-terminal:completed');
    } finally {
      await h.close();
    }
  });

  it('hands the session off across devices and platforms', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'ltx-handoff@forge.test');
      const created = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'android' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;
      await start(h, user.cookie, id);

      const first = await h.post('/v1/live-testing/sessions/handoff', { sessionId: id, device: 'iphone-13' }, { cookie: user.cookie });
      assert.equal(first.status, 200);
      const fb = (await first.json()) as {
        handoff: Record<string, unknown>;
        session: { deviceProfile: Record<string, unknown>; status: string };
        step: { narration: string };
      };
      assert.deepEqual(fb.handoff, {
        fromDevice: null,
        toDevice: 'iphone-13',
        toPlatform: 'ios',
        initial: true,
        platformChanged: true,
        resume: 'automatic',
        goalPreserved: true,
      });
      assert.equal(fb.step.narration, 'Handing off to iphone-13 across platforms');
      assert.deepEqual(fb.session.deviceProfile, { device: 'iphone-13', platform: 'ios', lowEnd: false, cpuThrottle: 1 });
      assert.equal(fb.session.status, 'running');

      const second = await h.post('/v1/live-testing/sessions/handoff', { sessionId: id, device: 'ipad-9' }, { cookie: user.cookie });
      const sb = (await second.json()) as { handoff: { platformChanged: boolean }; step: { narration: string } };
      assert.equal(sb.step.narration, 'Handing off to ipad-9');
      assert.equal(sb.handoff.platformChanged, false);

      const third = await h.post('/v1/live-testing/sessions/handoff', { sessionId: id, device: 'low-end-android' }, { cookie: user.cookie });
      const tb = (await third.json()) as { handoff: { resume: string }; session: { deviceProfile: Record<string, unknown> } };
      assert.equal(tb.handoff.resume, 'manual');
      assert.deepEqual(tb.session.deviceProfile, { device: 'low-end-android', platform: 'android', lowEnd: true, cpuThrottle: 4 });

      const same = await h.post('/v1/live-testing/sessions/handoff', { sessionId: id, device: 'low-end-android' }, { cookie: user.cookie });
      assert.equal(await errorCode(same), 'handoff-same-device');
      const unknownDevice = await h.post('/v1/live-testing/sessions/handoff', { sessionId: id, device: 'pixel-99' }, { cookie: user.cookie });
      assert.equal(await errorCode(unknownDevice), 'handoff-device-unknown:pixel-99');
    } finally {
      await h.close();
    }
  });

  it('runs gestures with physics checks and acting walls', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'ltx-gesture@forge.test');
      const created = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'android' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;
      await start(h, user.cookie, id);

      const swipe = await h.post('/v1/live-testing/sessions/gesture', { sessionId: id, gesture: 'swipe', direction: 'up' }, { cookie: user.cookie });
      assert.equal(swipe.status, 201);
      const swipeBody = (await swipe.json()) as { step: { narration: string; payload: Record<string, unknown> } };
      assert.equal(swipeBody.step.narration, 'Swiping up with 1 finger');
      assert.deepEqual(swipeBody.step.payload, { contacts: 1, direction: 'up', pressure: null, durationMs: null });

      const stylus = await h.post('/v1/live-testing/sessions/gesture', { sessionId: id, gesture: 'stylus-pressure', pressure: 0.5 }, { cookie: user.cookie });
      assert.equal(await errorCode(stylus), 'gesture-platform-unsupported:stylus-pressure:android');
      const short = await h.post('/v1/live-testing/sessions/gesture', { sessionId: id, gesture: 'long-press', durationMs: 50 }, { cookie: user.cookie });
      assert.equal(await errorCode(short), 'gesture-duration-invalid:50');
      const pinch = await h.post('/v1/live-testing/sessions/gesture', { sessionId: id, gesture: 'pinch', contacts: 1 }, { cookie: user.cookie });
      assert.equal(await errorCode(pinch), 'gesture-contacts-invalid:1');

      await h.post('/v1/live-testing/sessions/pause', { sessionId: id }, { cookie: user.cookie });
      const paused = await h.post('/v1/live-testing/sessions/gesture', { sessionId: id, gesture: 'tap', target: 'x' }, { cookie: user.cookie });
      assert.equal(await errorCode(paused), 'session-not-acting:paused');
    } finally {
      await h.close();
    }
  });

  it('applies creative operations per editor with undo and redo', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'ltx-creative@forge.test');
      const created = await createSession(h, user.cookie, { goal: 'draw a scene', platform: 'web' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;
      await start(h, user.cookie, id);

      const draw = await h.post('/v1/live-testing/sessions/creative', { sessionId: id, editor: 'manhwa', operation: 'draw' }, { cookie: user.cookie });
      assert.equal(draw.status, 201);
      const drawBody = (await draw.json()) as { state: Record<string, number> };
      assert.deepEqual(drawBody.state, { layers: 1, objects: 0, notes: 0, undoDepth: 1, redoDepth: 0 });

      await h.post('/v1/live-testing/sessions/creative', { sessionId: id, editor: 'manhwa', operation: 'layer-add' }, { cookie: user.cookie });
      const undo = await h.post('/v1/live-testing/sessions/creative', { sessionId: id, editor: 'manhwa', operation: 'undo' }, { cookie: user.cookie });
      const undoBody = (await undo.json()) as { state: Record<string, number> };
      assert.deepEqual(undoBody.state, { layers: 2, objects: 0, notes: 0, undoDepth: 1, redoDepth: 1 });

      const music = await h.post('/v1/live-testing/sessions/creative', { sessionId: id, editor: 'music', operation: 'note-place' }, { cookie: user.cookie });
      const musicBody = (await music.json()) as { state: Record<string, number> };
      assert.deepEqual(musicBody.state, { layers: 1, objects: 0, notes: 1, undoDepth: 1, redoDepth: 0 });

      const redo = await h.post('/v1/live-testing/sessions/creative', { sessionId: id, editor: 'manhwa', operation: 'redo' }, { cookie: user.cookie });
      const redoBody = (await redo.json()) as { state: Record<string, number> };
      assert.deepEqual(redoBody.state, { layers: 2, objects: 0, notes: 0, undoDepth: 2, redoDepth: 0 });
      const redoAgain = await h.post('/v1/live-testing/sessions/creative', { sessionId: id, editor: 'manhwa', operation: 'redo' }, { cookie: user.cookie });
      assert.equal(await errorCode(redoAgain), 'creative-redo-empty');

      const badEditor = await h.post('/v1/live-testing/sessions/creative', { sessionId: id, editor: 'photoshop', operation: 'draw' }, { cookie: user.cookie });
      assert.equal(await errorCode(badEditor), 'creative-editor-unknown:photoshop');
    } finally {
      await h.close();
    }
  });

  it('checks av playback, sync bands and media state transitions', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'ltx-av@forge.test');
      const created = await createSession(h, user.cookie, { goal: 'watch the player', platform: 'web' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;
      await start(h, user.cookie, id);

      const video = await h.post('/v1/live-testing/sessions/av-playback', { sessionId: id, kind: 'video', codec: 'h264' }, { cookie: user.cookie });
      assert.equal(video.status, 201);
      const videoBody = (await video.json()) as { plays: boolean; step: { narration: string } };
      assert.equal(videoBody.plays, true);
      assert.equal(videoBody.step.narration, 'Checking h264 video playback on web');
      const flac = await h.post('/v1/live-testing/sessions/av-playback', { sessionId: id, kind: 'audio', codec: 'flac' }, { cookie: user.cookie });
      assert.equal(await errorCode(flac), 'av-codec-unsupported:flac:web');
      const wrong = await h.post('/v1/live-testing/sessions/av-playback', { sessionId: id, kind: 'video', codec: 'opus' }, { cookie: user.cookie });
      assert.equal(await errorCode(wrong), 'av-codec-wrong-kind:opus');

      const sync50 = await h.post('/v1/live-testing/sessions/av-sync', { sessionId: id, driftMs: 50 }, { cookie: user.cookie });
      assert.equal(sync50.status, 201);
      const sync50Body = (await sync50.json()) as { sync: string; driftMs: number };
      assert.equal(sync50Body.sync, 'drifting');
      assert.equal(sync50Body.driftMs, 50);
      const syncBad = await h.post('/v1/live-testing/sessions/av-sync', { sessionId: id, driftMs: -200 }, { cookie: user.cookie });
      assert.equal(((await syncBad.json()) as { sync: string }).sync, 'out-of-sync');
      const sync30 = await h.post('/v1/live-testing/sessions/av-sync', { sessionId: id, driftMs: 30 }, { cookie: user.cookie });
      assert.equal(((await sync30.json()) as { sync: string }).sync, 'in-sync');

      const state = await h.post('/v1/live-testing/sessions/av-state', { sessionId: id, from: 'idle', to: 'playing' }, { cookie: user.cookie });
      assert.equal(state.status, 201);
      assert.equal(((await state.json()) as { step: { narration: string } }).step.narration, 'Media moves from idle to playing');
      const refused = await h.post('/v1/live-testing/sessions/av-state', { sessionId: id, from: 'idle', to: 'paused' }, { cookie: user.cookie });
      assert.equal(await errorCode(refused), 'av-state-refused:idle:paused');
    } finally {
      await h.close();
    }
  });

  it('seeds deterministic test accounts and cleans them up idempotently', async () => {
    const h = await startHarness();
    try {
      const user = await signedInUser(h, 'ltx-data@forge.test');
      const created = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'web' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;
      await start(h, user.cookie, id);

      const slug = id.replace(/[^a-z0-9]/g, '').slice(0, 12);
      const seeded = await h.post('/v1/live-testing/sessions/data/seed', { sessionId: id, count: 3 }, { cookie: user.cookie });
      assert.equal(seeded.status, 201);
      const seedBody = (await seeded.json()) as {
        accounts: Array<{ username: string; email: string; role: string }>;
        step: { narration: string; payload: Record<string, unknown> };
      };
      assert.deepEqual(seedBody.accounts.map((a) => a.username), [
        'forge-' + slug + '-1',
        'forge-' + slug + '-2',
        'forge-' + slug + '-3',
      ]);
      assert.deepEqual(seedBody.accounts.map((a) => a.email), [
        'forge-' + slug + '-1@forgelocal.test',
        'forge-' + slug + '-2@forgelocal.test',
        'forge-' + slug + '-3@forgelocal.test',
      ]);
      assert.deepEqual(seedBody.accounts.map((a) => a.role), ['shopper', 'editor', 'viewer']);
      assert.equal(seedBody.step.narration, 'Seeding 3 test accounts');
      assert.deepEqual(seedBody.step.payload, { count: 3, domain: 'forgelocal.test' });

      const reseed = await h.post('/v1/live-testing/sessions/data/seed', { sessionId: id, count: 2 }, { cookie: user.cookie });
      assert.equal(await errorCode(reseed), 'data-already-seeded:3');
      const reseedBad = await h.post('/v1/live-testing/sessions/data/seed', { sessionId: id, count: 99 }, { cookie: user.cookie });
      assert.equal(await errorCode(reseedBad), 'data-already-seeded:3');

      const cleanupRunning = await h.post('/v1/live-testing/sessions/data/cleanup', { sessionId: id }, { cookie: user.cookie });
      assert.equal(await errorCode(cleanupRunning), 'data-cleanup-status-refused:running');

      await h.post('/v1/live-testing/sessions/complete', { sessionId: id }, { cookie: user.cookie });
      const cleaned = await h.post('/v1/live-testing/sessions/data/cleanup', { sessionId: id }, { cookie: user.cookie });
      assert.equal(cleaned.status, 200);
      const cleanBody = (await cleaned.json()) as {
        sessionId: string;
        alreadyClean: boolean;
        plan: string[];
        pending: number;
        cleanedIds: string[];
        step: { narration: string };
      };
      assert.equal(cleanBody.sessionId, id);
      assert.equal(cleanBody.alreadyClean, false);
      assert.equal(cleanBody.plan.length, 4);
      assert.equal(cleanBody.pending, 3);
      assert.equal(cleanBody.cleanedIds.length, 3);
      assert.equal(cleanBody.step.narration, 'Cleaning up 3 seeded test accounts');

      const cleanedAgain = await h.post('/v1/live-testing/sessions/data/cleanup', { sessionId: id }, { cookie: user.cookie });
      const againBody = (await cleanedAgain.json()) as { sessionId: string; alreadyClean: boolean; plan: unknown[]; pending: number };
      assert.deepEqual(againBody, { sessionId: id, alreadyClean: true, plan: [], pending: 0 });

      const listed = await h.post('/v1/live-testing/sessions/data/accounts', { sessionId: id }, { cookie: user.cookie });
      const listBody = (await listed.json()) as { accounts: Array<{ state: string; cleanedAt: number | null }> };
      assert.equal(listBody.accounts.length, 3);
      assert.equal(listBody.accounts.every((a) => a.state === 'cleaned' && a.cleanedAt !== null), true);

      const fresh = await createSession(h, user.cookie, { goal: 'buy milk', platform: 'web' });
      const fid = ((await fresh.json()) as { session: { id: string } }).session.id;
      await start(h, user.cookie, fid);
      const badCount = await h.post('/v1/live-testing/sessions/data/seed', { sessionId: fid, count: 99 }, { cookie: user.cookie });
      assert.equal(await errorCode(badCount), 'data-count-invalid:99');
    } finally {
      await h.close();
    }
  });

  it('keeps the new flows inside the collaboration walls', async () => {
    const h = await startHarness();
    try {
      const owner = await signedInUser(h, 'ltx-iso-owner@forge.test');
      const tester = await signedInUser(h, 'ltx-iso-tester@forge.test');
      const observer = await signedInUser(h, 'ltx-iso-observer@forge.test');
      const stranger = await signedInUser(h, 'ltx-iso-stranger@forge.test');

      const created = await createSession(h, owner.cookie, { goal: 'buy milk', platform: 'android' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;
      await start(h, owner.cookie, id);

      const strangerInterrupt = await h.post('/v1/live-testing/sessions/interrupt', { sessionId: id, scenario: 'incoming-call' }, { cookie: stranger.cookie });
      assert.equal(await errorCode(strangerInterrupt), 'session-not-found:' + id);
      const strangerHandoff = await h.post('/v1/live-testing/sessions/handoff', { sessionId: id, device: 'iphone-13' }, { cookie: stranger.cookie });
      assert.equal(await errorCode(strangerHandoff), 'session-not-found:' + id);
      const strangerCleanup = await h.post('/v1/live-testing/sessions/data/cleanup', { sessionId: id }, { cookie: stranger.cookie });
      assert.equal(await errorCode(strangerCleanup), 'session-not-found:' + id);
      const strangerGesture = await h.post('/v1/live-testing/sessions/gesture', { sessionId: id, gesture: 'tap', target: 'x' }, { cookie: stranger.cookie });
      assert.equal(await errorCode(strangerGesture), 'session-not-found:' + id);
      const strangerSeed = await h.post('/v1/live-testing/sessions/data/seed', { sessionId: id, count: 1 }, { cookie: stranger.cookie });
      assert.equal(await errorCode(strangerSeed), 'session-not-found:' + id);

      const invited = await h.post('/v1/live-testing/sessions/participants/invite', { sessionId: id, userId: tester.id }, { cookie: owner.cookie });
      const pid = ((await invited.json()) as { participant: { id: string } }).participant.id;
      await h.post('/v1/live-testing/sessions/participants/accept', { participantId: pid }, { cookie: tester.cookie });

      const testerGesture = await h.post('/v1/live-testing/sessions/gesture', { sessionId: id, gesture: 'tap', target: 'login' }, { cookie: tester.cookie });
      assert.equal(testerGesture.status, 201);
      const testerSeed = await h.post('/v1/live-testing/sessions/data/seed', { sessionId: id, count: 1 }, { cookie: tester.cookie });
      assert.equal(testerSeed.status, 201);
      const testerCleanup = await h.post('/v1/live-testing/sessions/data/cleanup', { sessionId: id }, { cookie: tester.cookie });
      assert.equal(await errorCode(testerCleanup), 'session-not-found:' + id);
      const testerPermissions = await h.post(
        '/v1/live-testing/sessions/permissions',
        { sessionId: id, grants: [{ permission: 'camera', state: 'granted' }] },
        { cookie: tester.cookie },
      );
      assert.equal(await errorCode(testerPermissions), 'collaboration-capability-denied:tester:control');

      const observerInvited = await h.post('/v1/live-testing/sessions/participants/invite', { sessionId: id, userId: observer.id, role: 'observer' }, { cookie: owner.cookie });
      const opid = ((await observerInvited.json()) as { participant: { id: string } }).participant.id;
      await h.post('/v1/live-testing/sessions/participants/accept', { participantId: opid }, { cookie: observer.cookie });
      const observerGesture = await h.post('/v1/live-testing/sessions/gesture', { sessionId: id, gesture: 'tap', target: 'x' }, { cookie: observer.cookie });
      assert.equal(await errorCode(observerGesture), 'collaboration-capability-denied:observer:steps');
    } finally {
      await h.close();
    }
  });
});

describe('live testing comparison route (FORGE TQ-019)', () => {
  it('compares a finished AI session with a human run', async () => {
    const h = await startHarness();
    try {
      const owner = await signedInUser(h, 'ltx-compare-owner@forge.test');
      const created = await createSession(h, owner.cookie, { goal: 'buy milk', platform: 'web' });
      const id = ((await created.json()) as { session: { id: string } }).session.id;
      await start(h, owner.cookie, id);
      await h.post('/v1/live-testing/sessions/steps', { sessionId: id, action: 'click', target: 'login' }, { cookie: owner.cookie });
      await h.post('/v1/live-testing/sessions/steps', { sessionId: id, action: 'click', target: 'cart' }, { cookie: owner.cookie });

      const open = await h.post('/v1/live-testing/sessions/compare', { sessionId: id, human: { steps: 4, durationMs: 5000, outcome: 'completed' } }, { cookie: owner.cookie });
      assert.equal(await errorCode(open), 'comparison-session-open:running');

      await h.post('/v1/live-testing/sessions/complete', { sessionId: id }, { cookie: owner.cookie });
      const compared = await h.post('/v1/live-testing/sessions/compare', { sessionId: id, human: { steps: 4, durationMs: 5000, outcome: 'completed' } }, { cookie: owner.cookie });
      assert.equal(compared.status, 200);
      const body = (await compared.json()) as { sessionId: string; comparison: Record<string, unknown> };
      assert.equal(body.sessionId, id);
      assert.deepEqual(body.comparison, {
        humanSteps: 4,
        aiSteps: 2,
        stepDelta: -2,
        humanDurationMs: 5000,
        aiDurationMs: 0,
        durationDeltaMs: 5000,
        faster: 'ai',
        sameOutcome: true,
        text: 'Human completed with 4 steps in 5000ms; AI completed with 2 steps in 0ms; same outcome',
      });

      const noHuman = await h.post('/v1/live-testing/sessions/compare', { sessionId: id }, { cookie: owner.cookie });
      assert.equal(await errorCode(noHuman), 'comparison-human-missing');
      const badSteps = await h.post('/v1/live-testing/sessions/compare', { sessionId: id, human: { steps: -1, durationMs: 10, outcome: 'completed' } }, { cookie: owner.cookie });
      assert.equal(await errorCode(badSteps), 'comparison-steps-invalid:human:-1');

      const stranger = await signedInUser(h, 'ltx-compare-stranger@forge.test');
      const denied = await h.post('/v1/live-testing/sessions/compare', { sessionId: id, human: { steps: 1, durationMs: 10, outcome: 'completed' } }, { cookie: stranger.cookie });
      assert.equal(await errorCode(denied), 'session-not-found:' + id);

      const anonymous = await h.post('/v1/live-testing/sessions/compare', { sessionId: id });
      assert.equal(anonymous.status, 401);
    } finally {
      await h.close();
    }
  });
});
