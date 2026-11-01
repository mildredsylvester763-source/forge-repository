import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { assembleBugReport } from '../src/modules/live-testing/engine/bug-report.ts';
import {
  deriveChecklist,
  getPersona,
  listPersonas,
  paceMultiplier,
  type PersonaProfile,
} from '../src/modules/live-testing/engine/persona-profile.ts';
import { checkAction, isPlatform, listActions, validateDeviceProfile } from '../src/modules/live-testing/engine/platform-capability.ts';
import {
  checkCapability,
  checkInvitation,
  normalizeRole,
  roleCatalog,
} from '../src/modules/live-testing/engine/session-collaboration.ts';
import {
  canHandBack,
  canTakeControl,
  isActing,
  isTerminal,
  transition,
} from '../src/modules/live-testing/engine/session-lifecycle.ts';
import { buildTimeline } from '../src/modules/live-testing/engine/session-recording.ts';
import { evaluateStep, resolveSafeMode } from '../src/modules/live-testing/engine/safe-mode.ts';
import { narrate, parseGoal } from '../src/modules/live-testing/engine/step-narration.ts';
import { convertSession } from '../src/modules/live-testing/engine/test-conversion.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('session-lifecycle engine (FORGE TQ-001, TQ-009, TQ-010)', () => {
  it('allows exactly the legal transitions', () => {
    assert.deepEqual(transition('planned', 'running'), { ok: true });
    assert.deepEqual(transition('running', 'manual'), { ok: true });
    assert.deepEqual(transition('manual', 'running'), { ok: true });
    assert.deepEqual(transition('paused', 'cancelled'), { ok: true });
  });

  it('refuses illegal, unknown and terminal moves by name', () => {
    assert.deepEqual(transition('planned', 'completed'), { ok: false, reason: 'session-transition-illegal:planned:completed' });
    assert.deepEqual(transition('completed', 'running'), { ok: false, reason: 'session-terminal:completed' });
    assert.deepEqual(transition('paused', 'x'), { ok: false, reason: 'session-unknown-status:x' });
    assert.deepEqual(transition(7, 'running'), { ok: false, reason: 'session-unknown-status:7' });
  });

  it('marks manual control, hand back and acting states', () => {
    assert.equal(canTakeControl('running'), true);
    assert.equal(canTakeControl('paused'), true);
    assert.equal(canTakeControl('manual'), false);
    assert.equal(canHandBack('manual'), true);
    assert.equal(canHandBack('running'), false);
    assert.equal(isActing('running'), true);
    assert.equal(isActing('manual'), true);
    assert.equal(isActing('paused'), false);
    assert.equal(isTerminal('cancelled'), true);
    assert.equal(isTerminal('paused'), false);
  });

  it('matches an independent oracle on 500 mulberry32(42) state pairs', () => {
    const ORACLE: Record<string, string[]> = {
      planned: ['running', 'cancelled'],
      running: ['paused', 'manual', 'completed', 'failed', 'cancelled'],
      paused: ['running', 'manual', 'cancelled'],
      manual: ['running', 'paused', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: [],
    };
    const statuses = Object.keys(ORACLE);
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const from = c % 6 === 0 ? 'junk' + c : statuses[Math.floor(rand() * statuses.length)]!;
      const to = c % 7 === 0 ? 12 + c : statuses[Math.floor(rand() * statuses.length)]!;
      const got = transition(from, to);
      let expected: { ok: boolean; reason?: string };
      if (!(from in ORACLE)) expected = { ok: false, reason: 'session-unknown-status:' + String(from) };
      else if (!(to in ORACLE)) expected = { ok: false, reason: 'session-unknown-status:' + String(to) };
      else if (ORACLE[from]!.length === 0) expected = { ok: false, reason: 'session-terminal:' + from };
      else if (!ORACLE[from]!.includes(String(to))) {
        expected = { ok: false, reason: 'session-transition-illegal:' + String(from) + ':' + String(to) };
      } else expected = { ok: true };
      assert.deepEqual(got, expected);
    }
  });
});

describe('platform-capability engine (FORGE TQ-002..TQ-005)', () => {
  it('lists the per platform action and gesture vocabulary', () => {
    assert.deepEqual(listActions('web'), [
      'click', 'type', 'scroll', 'drag', 'hover', 'key', 'upload', 'navigate', 'wait', 'assert',
    ]);
    assert.deepEqual(listActions('ios'), [
      'tap', 'swipe', 'long-press', 'type', 'scroll', 'rotate', 'terminate', 'assert',
      'pinch', 'multi-touch', 'stylus-pressure',
    ]);
  });

  it('refuses unknown platforms, actions and unsupported steps by name', () => {
    assert.deepEqual(checkAction('web', 'click'), { ok: true });
    assert.deepEqual(checkAction('web', 'tap'), { ok: false, reason: 'platform-action-unsupported:tap:web' });
    assert.deepEqual(checkAction('web', 'churn'), { ok: false, reason: 'platform-action-unknown:churn' });
    assert.deepEqual(checkAction('watch', 'click'), { ok: false, reason: 'platform-unknown:watch' });
    assert.deepEqual(checkAction('web', ''), { ok: false, reason: 'platform-action-missing' });
    assert.equal(isPlatform('android'), true);
    assert.equal(isPlatform('watch'), false);
  });

  it('validates device profiles with defaults', () => {
    const v = validateDeviceProfile({ platform: 'web', deviceClass: 'low-end', network: '3g', screenWidth: 1280, screenHeight: 720 });
    assert.deepEqual(v.profile, { platform: 'web', deviceClass: 'low-end', network: '3g', screenWidth: 1280, screenHeight: 720 });
    assert.deepEqual(validateDeviceProfile({ platform: 'web', network: '9g' }), { ok: false, reason: 'device-network-invalid:9g' });
    assert.deepEqual(validateDeviceProfile({ platform: 'web', deviceClass: 'extreme' }), { ok: false, reason: 'device-class-invalid:extreme' });
    assert.deepEqual(validateDeviceProfile({ platform: 'tv' }), { ok: false, reason: 'device-profile-missing-platform' });
    const bare = validateDeviceProfile({ platform: 'desktop' });
    assert.deepEqual(bare.profile, { platform: 'desktop', deviceClass: 'standard', network: 'wifi', screenWidth: null, screenHeight: null });
  });

  it('matches an independent oracle on 500 mulberry32(42) platform and action pairs', () => {
    const ORACLE_ACTIONS: Record<string, string[]> = {
      web: ['click', 'type', 'scroll', 'drag', 'hover', 'key', 'upload', 'navigate', 'wait', 'assert'],
      android: ['tap', 'swipe', 'long-press', 'type', 'scroll', 'back', 'home', 'rotate', 'install', 'assert'],
      ios: ['tap', 'swipe', 'long-press', 'type', 'scroll', 'rotate', 'terminate', 'assert'],
      desktop: ['click', 'type', 'key', 'hover', 'drag', 'menu', 'window-resize', 'file-dialog', 'assert'],
    };
    const ORACLE_GESTURES: Record<string, string[]> = { web: [], android: ['pinch', 'multi-touch'], ios: ['pinch', 'multi-touch', 'stylus-pressure'], desktop: [] };
    const all = new Set<string>();
    for (const p of Object.keys(ORACLE_ACTIONS)) for (const a of ORACLE_ACTIONS[p]!) all.add(a);
    for (const p of Object.keys(ORACLE_GESTURES)) for (const g of ORACLE_GESTURES[p]!) all.add(g);
    const platforms = ['web', 'android', 'ios', 'desktop', 'watch', ''];
    const actions = [...all, 'pinch', 'nope', ''];
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const p = platforms[Math.floor(rand() * platforms.length)]!;
      const a = actions[Math.floor(rand() * actions.length)]!;
      const got = checkAction(p, a);
      let expected: { ok: boolean; reason?: string };
      if (!ORACLE_ACTIONS[p]) expected = { ok: false, reason: 'platform-unknown:' + String(p) };
      else if (a.length === 0) expected = { ok: false, reason: 'platform-action-missing' };
      else if (!all.has(a)) expected = { ok: false, reason: 'platform-action-unknown:' + a };
      else if (!ORACLE_ACTIONS[p]!.includes(a) && !ORACLE_GESTURES[p]!.includes(a)) {
        expected = { ok: false, reason: 'platform-action-unsupported:' + a + ':' + p };
      } else expected = { ok: true };
      assert.deepEqual(got, expected);
    }
  });
});

describe('step-narration engine (FORGE TQ-008, TQ-012)', () => {
  it('splits goals into deterministic deduped tasks with keywords', () => {
    const goal = parseGoal('log in\nthen buy the widget; then log in');
    assert.equal(goal.ok, true);
    assert.deepEqual(goal.tasks?.map((t) => t.id), ['task-1', 'task-2']);
    assert.deepEqual(goal.tasks?.[0]?.keywords, ['log']);
    assert.deepEqual(goal.tasks?.[1]?.keywords, ['buy', 'widget']);
    assert.deepEqual(parseGoal(''), { ok: false, reason: 'goal-empty' });
    assert.deepEqual(parseGoal(42), { ok: false, reason: 'goal-not-a-string' });
    const parts: string[] = [];
    for (let i = 0; i < 13; i++) parts.push('step ' + i);
    assert.deepEqual(parseGoal(parts.join('\n')), { ok: false, reason: 'goal-too-many-tasks:13' });
  });

  it('narrates actions and never echoes typed values', () => {
    assert.deepEqual(narrate({ action: 'type', target: '#email', value: 'secret123' }), { ok: true, text: 'Typing 9 characters into #email' });
    assert.deepEqual(narrate({ action: 'click', target: 'login' }), { ok: true, text: 'Clicking login' });
    assert.deepEqual(narrate({ action: 'scroll', target: 'feed', direction: 'up', count: 3 }), { ok: true, text: 'Scrolling up 3 time(s) on feed' });
    assert.deepEqual(narrate({ action: 'swipe', direction: 'right' }), { ok: true, text: 'Swiping right' });
    assert.deepEqual(narrate({ action: 'key', key: 'Escape' }), { ok: true, text: 'Pressing Escape' });
    assert.deepEqual(narrate({ action: 'navigate' }), { ok: true, text: 'Opening the app' });
    assert.deepEqual(narrate({ action: 'churn' }), { ok: false, reason: 'narration-unknown-action:churn' });
    assert.deepEqual(narrate({ action: 'click' }), { ok: false, reason: 'narration-missing-target:click' });
  });

  it('matches an independent oracle on 500 mulberry32(42) narratable steps', () => {
    const TARGETED = ['click', 'tap', 'type', 'scroll', 'drag', 'hover', 'wait', 'assert', 'upload', 'menu', 'long-press'];
    const ACTIONS = [
      'click', 'tap', 'type', 'scroll', 'drag', 'hover', 'key', 'upload', 'navigate', 'wait', 'assert',
      'swipe', 'long-press', 'pinch', 'multi-touch', 'stylus-pressure', 'back', 'home', 'rotate',
      'install', 'terminate', 'menu', 'window-resize', 'file-dialog', 'zorp', '',
    ];
    const oracle = (step: { action: string; target?: unknown; value?: unknown; direction?: unknown; key?: unknown; count?: unknown }): { ok: boolean; reason?: string; text?: string } => {
      const action = typeof step.action === 'string' ? step.action.trim().toLowerCase() : '';
      if (action.length === 0) return { ok: false, reason: 'narration-action-missing' };
      const target = typeof step.target === 'string' ? step.target.trim() : '';
      if (TARGETED.includes(action) && target.length === 0) return { ok: false, reason: 'narration-missing-target:' + action };
      const dir = typeof step.direction === 'string' && step.direction.length > 0 ? step.direction : null;
      const lines: Record<string, string> = {
        click: 'Clicking ' + target,
        tap: 'Clicking ' + target,
        drag: 'Dragging ' + target,
        hover: 'Hovering over ' + target,
        upload: 'Uploading a file to ' + target,
        wait: 'Waiting for ' + target,
        assert: 'Checking ' + target,
        long_press: 'Long-pressing ' + target,
        menu: 'Opening menu ' + target,
        navigate: 'Opening ' + (target.length > 0 ? target : 'the app'),
        back: 'Pressing back',
        home: 'Going home',
        rotate: 'Rotating the device',
        install: 'Installing the app build',
        terminate: 'Terminating the app',
        'window-resize': 'Resizing the window',
        'file-dialog': 'Working the file dialog',
        pinch: 'Pinching ' + (target.length > 0 ? target : 'the screen'),
        'multi-touch': 'Multi-touching ' + (target.length > 0 ? target : 'the screen'),
        'stylus-pressure': 'Drawing with stylus pressure on ' + (target.length > 0 ? target : 'the canvas'),
      };
      if (action === 'type') {
        const n = typeof step.value === 'string' ? step.value.length : 0;
        return { ok: true, text: 'Typing ' + n + ' characters into ' + target };
      }
      if (action === 'scroll') {
        return { ok: true, text: 'Scrolling ' + (dir ?? 'down') + ' ' + (Number.isInteger(step.count) && (step.count as number) > 0 ? step.count : 1) + ' time(s) on ' + target };
      }
      if (action === 'key') {
        return { ok: true, text: 'Pressing ' + (typeof step.key === 'string' && step.key.length > 0 ? step.key : 'unknown-key') };
      }
      if (action === 'swipe') {
        return { ok: true, text: 'Swiping ' + (dir ?? 'left') + (target.length > 0 ? ' on ' + target : '') };
      }
      const line = lines[action.replace('-', '_')] ?? lines[action];
      if (line === undefined) return { ok: false, reason: 'narration-unknown-action:' + action };
      return { ok: true, text: line };
    };
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const action = ACTIONS[Math.floor(rand() * ACTIONS.length)]!;
      const withTarget = rand() < 0.8;
      const step = {
        action,
        target: withTarget ? 'box' + c : undefined,
        value: action === 'type' ? 'v'.repeat(Math.floor(rand() * 8)) : undefined,
        direction: rand() < 0.4 ? ['up', 'down', 'left', 'right'][Math.floor(rand() * 4)] : undefined,
        key: rand() < 0.2 ? 'Enter' : undefined,
        count: rand() < 0.3 ? Math.floor(rand() * 5) : undefined,
      };
      assert.deepEqual(narrate(step), oracle(step));
    }
  });
});

describe('persona-profile engine (FORGE TQ-014)', () => {
  it('serves fresh copies of the six builtin personas', () => {
    assert.deepEqual(listPersonas(), [
      'impatient-user',
      'low-vision-user',
      'motor-impaired-user',
      'new-user',
      'power-user',
      'screen-reader-user',
    ]);
    const a = getPersona('power-user');
    const b = getPersona('power-user');
    assert.equal(a.profile?.familiarity, 95);
    assert.notEqual(a.profile, b.profile);
    assert.deepEqual(getPersona('ghost'), { ok: false, reason: 'persona-unknown:ghost' });
    assert.deepEqual(getPersona(''), { ok: false, reason: 'persona-missing' });
  });

  it('derives checklists and pacing from the trait vector', () => {
    const p = getPersona('new-user').profile!;
    assert.deepEqual(deriveChecklist(p), [
      'smoke-critical-path',
      'onboarding-flow',
      'empty-states',
      'help-affordances',
      'edge-case-inputs',
      'error-paths',
    ]);
    const sr = getPersona('screen-reader-user').profile!;
    assert.deepEqual(deriveChecklist(sr), [
      'smoke-critical-path',
      'keyboard-navigation',
      'focus-order',
      'screen-reader-labels',
      'contrast-checks',
      'keyboard-only-trap-scan',
    ]);
    assert.equal(paceMultiplier(getPersona('new-user').profile!), 1.5);
    assert.equal(paceMultiplier(getPersona('power-user').profile!), 1.0);
    assert.equal(paceMultiplier(getPersona('impatient-user').profile!), 0.75);
  });

  it('matches an independent oracle on 500 mulberry32(42) trait vectors', () => {
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const profile: PersonaProfile = {
        name: 'v' + c,
        familiarity: Math.floor(rand() * 101),
        patience: Math.floor(rand() * 101),
        exploratory: Math.floor(rand() * 101),
        a11yNeeds: rand() < 0.3,
        keyboardOnly: rand() < 0.25,
        prefersSlowPacing: rand() < 0.5,
      };
      const expected: string[] = ['smoke-critical-path'];
      if (profile.familiarity <= 30) expected.push('onboarding-flow', 'empty-states', 'help-affordances');
      if (profile.exploratory >= 60) expected.push('edge-case-inputs', 'error-paths');
      if (profile.a11yNeeds) expected.push('keyboard-navigation', 'focus-order', 'screen-reader-labels', 'contrast-checks');
      if (profile.keyboardOnly) expected.push('keyboard-only-trap-scan');
      if (profile.patience <= 20) expected.push('loading-feedback');
      assert.deepEqual(deriveChecklist(profile), expected);
      const pace = profile.patience >= 70 ? 1.5 : profile.patience >= 40 ? 1.0 : 0.75;
      assert.equal(paceMultiplier(profile), pace);
    }
  });
});

describe('session-recording engine (FORGE TQ-015, TQ-016)', () => {
  const START = new Date(1_000_000);

  it('builds one deterministic ordered timeline from steps and markers', () => {
    const v = buildTimeline(
      START,
      [
        { seq: 1, narration: 'Clicking login', status: 'recorded', occurredAt: new Date(1_000_100) },
        { seq: 2, narration: null, status: 'recorded', occurredAt: new Date(1_000_050) },
      ],
      [{ label: '  crash  ', occurredAt: new Date(1_000_075) }],
    );
    assert.equal(v.ok, true);
    assert.deepEqual(v.events, [
      { id: 'event-1', offsetMs: 50, kind: 'step', label: 'Step 2' },
      { id: 'event-2', offsetMs: 75, kind: 'marker', label: 'crash' },
      { id: 'event-3', offsetMs: 100, kind: 'step', label: 'Clicking login' },
    ]);
    assert.equal(v.durationMs, 100);
  });

  it('breaks ties with steps before markers at the same offset', () => {
    const v = buildTimeline(START, [
      { seq: 1, narration: 'a', status: 'recorded', occurredAt: new Date(1_000_010) },
    ], [{ label: 'm', occurredAt: new Date(1_000_010) }]);
    assert.deepEqual(v.events?.map((e) => e.kind), ['step', 'marker']);
  });

  it('refuses broken recordings by name', () => {
    assert.deepEqual(buildTimeline(null, [], []), { ok: false, reason: 'recording-not-started' });
    assert.deepEqual(
      buildTimeline(START, [{ seq: 3, narration: 'a', status: 'recorded', occurredAt: START }], []),
      { ok: false, reason: 'recording-step-seq-broken:3' },
    );
    assert.deepEqual(
      buildTimeline(START, [{ seq: 1, narration: 'a', status: 'recorded', occurredAt: new Date(999_999) }], []),
      { ok: false, reason: 'recording-step-before-start:1' },
    );
    assert.deepEqual(buildTimeline(START, [], [{ label: '  ', occurredAt: START }]), {
      ok: false,
      reason: 'recording-marker-label-empty',
    });
    const empty = buildTimeline(START, [], []);
    assert.deepEqual(empty, { ok: true, events: [], durationMs: 0 });
  });

  it('matches an independent oracle on 500 mulberry32(42) timelines', () => {
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const start = 5_000_000;
      const steps: Array<{ seq: number; narration: string | null; status: string; occurredAt: Date }> = [];
      const markers: Array<{ label: string; occurredAt: Date }> = [];
      const n = Math.floor(rand() * 6);
      const brokenSeq = rand() < 0.1 && n > 0;
      for (let i = 0; i < n; i++) {
        const seq = brokenSeq && i === n - 1 ? i + 2 : i + 1;
        steps.push({
          seq,
          narration: rand() < 0.5 ? 'step ' + i : null,
          status: 'recorded',
          occurredAt: new Date(start + Math.floor(rand() * 200) - 20),
        });
      }
      const m = Math.floor(rand() * 3);
      for (let i = 0; i < m; i++) {
        markers.push({ label: 'mark ' + i, occurredAt: new Date(start + Math.floor(rand() * 200) - 20) });
      }
      const got = buildTimeline(new Date(start), steps, markers);
      let expected: { ok: boolean; reason?: string; events?: unknown[]; durationMs?: number };
      let broken = false;
      const entries: Array<{ at: number; tie: number; kind: string; label: string }> = [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]!;
        if (s.seq !== i + 1) {
          expected = { ok: false, reason: 'recording-step-seq-broken:' + s.seq };
          broken = true;
          break;
        }
        const off = s.occurredAt.getTime() - start;
        if (off < 0) {
          expected = { ok: false, reason: 'recording-step-before-start:' + s.seq };
          broken = true;
          break;
        }
        entries.push({ at: off, tie: 0, kind: 'step', label: s.narration === null ? 'Step ' + s.seq : s.narration });
      }
        if (!broken) {
          for (const mk of markers) {
            const off = mk.occurredAt.getTime() - start;
            if (off < 0) {
              expected = { ok: false, reason: 'recording-marker-before-start' };
              broken = true;
              break;
            }
            entries.push({ at: off, tie: 1, kind: 'marker', label: mk.label.trim() });
          }
        }
        if (!broken) {
          entries.sort((x, y) => x.at - y.at || x.tie - y.tie);
          expected = {
            ok: true,
            events: entries.map((e, i) => ({ id: 'event-' + (i + 1), offsetMs: e.at, kind: e.kind, label: e.label })),
            durationMs: entries.length === 0 ? 0 : entries[entries.length - 1]!.at,
          };
        }
      assert.deepEqual(got, expected);
    }
  });
});

describe('bug-report engine (FORGE TQ-017)', () => {
  it('assembles one structured report with a deterministic dedupe key', () => {
    const v = assembleBugReport(
      's1',
      { platform: 'web', environment: 'test', safeMode: true },
      { severity: 3, title: '  Cart   Broken ', reproSteps: 'open the cart', evidence: '{"shot":"x"}', suspectedCommit: 'abc1234' },
      [{ narration: 'Clicking cart', status: 'recorded' }, { narration: null, status: 'recorded' }],
    );
    assert.equal(v.ok, true);
    assert.equal(v.report?.title, 'Cart   Broken');
    assert.equal(v.report?.severityLabel, 'major');
    assert.deepEqual(v.report?.reproLines, ['Clicking cart', 'open the cart']);
    assert.equal(v.report?.environmentLine, 'platform web, environment test, safe mode on');
    assert.equal(v.report?.evidence, '{"shot":"x"}');
    assert.equal(v.report?.suspectedCommit, 'abc1234');
    assert.equal(v.report?.dedupeKey, 's1|3|cart broken');
  });

  it('refuses malformed findings by name', () => {
    const session = { platform: 'web', environment: 'dev', safeMode: false };
    assert.deepEqual(assembleBugReport('s', session, { severity: 0, title: 'x', reproSteps: null, evidence: null, suspectedCommit: null }, []), { ok: false, reason: 'bugreport-severity-invalid:0' });
    assert.deepEqual(assembleBugReport('s', session, { severity: 6, title: 'x', reproSteps: null, evidence: null, suspectedCommit: null }, []), { ok: false, reason: 'bugreport-severity-invalid:6' });
    assert.deepEqual(assembleBugReport('s', session, { severity: 2, title: '   ', reproSteps: null, evidence: null, suspectedCommit: null }, []), { ok: false, reason: 'bugreport-title-empty' });
    assert.deepEqual(assembleBugReport('s', session, { severity: 2, title: 'x', reproSteps: null, evidence: null, suspectedCommit: 'zz!' }, []), { ok: false, reason: 'bugreport-suspected-commit-invalid' });
  });

  it('matches an independent oracle on 500 mulberry32(42) findings', () => {
    const rand = mulberry32(42);
    const TITLES = ['Checkout fails', '  blank  ', '', 'Cart drops items'];
    const COMMITS = ['abc1234', '', 'not-a-commit', null, 'a'.repeat(40)];
    for (let c = 0; c < 500; c++) {
      const severity = Math.floor(rand() * 7);
      const title = TITLES[Math.floor(rand() * TITLES.length)]!;
      const commit = COMMITS[Math.floor(rand() * COMMITS.length)]!;
      const steps = Array.from({ length: Math.floor(rand() * 4) }, (_, i) => ({
        narration: rand() < 0.5 ? 'n' + i : null,
        status: 'recorded',
      }));
      const repro = rand() < 0.5 ? 'extra ' + c : null;
      const got = assembleBugReport('sid', { platform: 'web', environment: 'test', safeMode: true }, { severity, title, reproSteps: repro, evidence: null, suspectedCommit: commit }, steps);
      let expected: { ok: boolean; reason?: string };
      if (!Number.isInteger(severity) || severity < 1 || severity > 5) {
        expected = { ok: false, reason: 'bugreport-severity-invalid:' + severity };
      } else if (typeof title !== 'string' || title.trim().length === 0) {
        expected = { ok: false, reason: 'bugreport-title-empty' };
      } else if (commit !== null && commit !== '' && !/^[0-9a-f]{7,40}$/.test(commit)) {
        expected = { ok: false, reason: 'bugreport-suspected-commit-invalid' };
      } else {
        expected = { ok: true };
      }
      assert.equal(got.ok, expected.ok);
      assert.equal(got.reason, expected.reason);
      if (got.ok) {
        const lines = steps.filter((s) => typeof s.narration === 'string' && s.narration.length > 0).map((s) => s.narration);
        if (repro !== null && repro.trim().length > 0) lines.push(repro.trim());
        assert.deepEqual(got.report?.reproLines, lines);
        assert.equal(got.report?.severityLabel, ['trivial', 'minor', 'major', 'critical', 'blocker'][severity - 1]);
        assert.equal(got.report?.dedupeKey, 'sid|' + severity + '|' + title.trim().replace(/\s+/g, ' ').toLowerCase());
      }
    }
  });
});

describe('test-conversion engine (FORGE TQ-018)', () => {
  it('turns a finished session into one replayable test case', () => {
    const v = convertSession(
      { title: 'Checkout', tasks: [{ id: 'task-1', text: 'buy the thing' }] },
      [
        { seq: 1, action: ' click ', target: 'buy' },
        { seq: 2, action: 'assert', target: null },
      ],
    );
    assert.deepEqual(v.testCase, {
      name: 'buy the thing',
      caseSteps: [
        { id: 'case-1', line: 'click buy' },
        { id: 'case-2', line: 'assert' },
      ],
      expected: 'All 2 steps replay in the same order',
    });
    assert.deepEqual(convertSession({ title: 'T' }, []), { ok: false, reason: 'conversion-empty' });
    assert.deepEqual(convertSession({ title: 'T' }, [{ seq: 2, action: 'click', target: null }]), {
      ok: false,
      reason: 'conversion-step-seq-broken:2',
    });
    assert.deepEqual(convertSession({ title: 'T' }, [{ seq: 1, action: '  ', target: null }]), {
      ok: false,
      reason: 'conversion-step-action-empty:1',
    });
    const fallback = convertSession({}, [{ seq: 1, action: 'click', target: null }]);
    assert.equal(fallback.testCase?.name, 'Converted session');
  });

  it('matches an independent oracle on 500 mulberry32(42) step lists', () => {
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const n = Math.floor(rand() * 6);
      const breakSeq = rand() < 0.12 && n > 0;
      const steps = Array.from({ length: n }, (_, i) => ({
        seq: breakSeq && i === n - 1 ? i + 2 : i + 1,
        action: rand() < 0.1 ? '  ' : 'act' + i,
        target: rand() < 0.5 ? 't' + i : null,
      }));
      const withTasks = rand() < 0.6;
      const goal = withTasks
        ? { title: 'Title ' + c, tasks: [{ id: 'task-1', text: 'first task ' + c }] }
        : { title: rand() < 0.5 ? 'Only Title' : '', tasks: [] };
      const got = convertSession(goal, steps);
      let expectedReason: string | null = null;
      if (steps.length === 0) expectedReason = 'conversion-empty';
      for (let i = 0; i < steps.length && expectedReason === null; i++) {
        if (steps[i]!.seq !== i + 1) expectedReason = 'conversion-step-seq-broken:' + steps[i]!.seq;
        else if (steps[i]!.action.trim().length === 0) expectedReason = 'conversion-step-action-empty:' + steps[i]!.seq;
      }
      if (expectedReason !== null) {
        assert.deepEqual(got, { ok: false, reason: expectedReason });
        continue;
      }
      assert.equal(got.ok, true);
      assert.equal(got.testCase?.name, withTasks ? 'first task ' + c : goal.title.length > 0 ? goal.title : 'Converted session');
      assert.deepEqual(got.testCase?.caseSteps, steps.map((s, i) => ({
        id: 'case-' + (i + 1),
        line: s.action.trim() + (s.target !== null && s.target.length > 0 ? ' ' + s.target : ''),
      })));
      assert.equal(got.testCase?.expected, 'All ' + steps.length + ' steps replay in the same order');
    }
  });
});

describe('safe-mode engine (FORGE TQ-030)', () => {
  it('forces safe mode on production and off only on request', () => {
    assert.deepEqual(resolveSafeMode(false, 'production'), { safeMode: true, forced: true });
    assert.deepEqual(resolveSafeMode(false, 'test'), { safeMode: false, forced: false });
    assert.deepEqual(resolveSafeMode(undefined, 'production'), { safeMode: true, forced: true });
    assert.deepEqual(resolveSafeMode(undefined, 'nonsense'), { safeMode: true, forced: false });
  });

  it('blocks destructive, payment and message actions and real addresses', () => {
    assert.deepEqual(evaluateStep({ action: 'delete', payload: {} }, true), { ok: false, reason: 'safe-mode-blocks-destructive:delete' });
    assert.deepEqual(evaluateStep({ action: 'pay', payload: {} }, true), { ok: false, reason: 'safe-mode-blocks-payment:pay' });
    assert.deepEqual(evaluateStep({ action: 'post', payload: {} }, true), { ok: false, reason: 'safe-mode-blocks-real-message:post' });
    assert.deepEqual(evaluateStep({ action: 'type', payload: { value: 'a@b.c' } }, true), { ok: false, reason: 'safe-mode-blocks-real-address:type' });
    assert.deepEqual(evaluateStep({ action: 'type', payload: { value: 'a@b.c' } }, false), { ok: true });
    assert.deepEqual(evaluateStep({ action: '', payload: {} }, true), { ok: false, reason: 'safe-mode-action-missing' });
    assert.deepEqual(evaluateStep({ action: '', payload: {} }, false), { ok: true });
  });

  it('matches an independent oracle on 500 mulberry32(42) step intents', () => {
    const DESTRUCTIVE = ['delete', 'wipe', 'purge', 'drop', 'erase', 'format', 'uninstall'];
    const PAYMENT = ['pay', 'purchase', 'checkout', 'buy', 'subscribe', 'charge', 'billing'];
    const MESSAGE = ['send-message', 'send-email', 'send-sms', 'invite', 'post', 'publish', 'share'];
    const SAFE = ['click', 'type', 'scroll', 'navigate'];
    const ACTIONS = [...DESTRUCTIVE, ...PAYMENT, ...MESSAGE, ...SAFE, 'zoom'];
    const PAYLOADS = [
      {},
      { value: 'plain text' },
      { value: 'user@forgelocal.test' },
      { value: 'no-at-sign' },
      { extra: 'x y z' },
    ];
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const action = ACTIONS[Math.floor(rand() * ACTIONS.length)]!;
      const payload = PAYLOADS[Math.floor(rand() * PAYLOADS.length)]!;
      const safeMode = rand() < 0.5;
      const got = evaluateStep({ action, payload }, safeMode);
      let expected: { ok: boolean; reason?: string };
      if (!safeMode) expected = { ok: true };
      else if (action.trim().length === 0) expected = { ok: false, reason: 'safe-mode-action-missing' };
      else if (DESTRUCTIVE.includes(action)) expected = { ok: false, reason: 'safe-mode-blocks-destructive:' + action };
      else if (PAYMENT.includes(action)) expected = { ok: false, reason: 'safe-mode-blocks-payment:' + action };
      else if (MESSAGE.includes(action)) expected = { ok: false, reason: 'safe-mode-blocks-real-message:' + action };
      else if (/[^\s"']+@[^\s"']+\.[^\s"']+/.test(JSON.stringify(payload))) {
        expected = { ok: false, reason: 'safe-mode-blocks-real-address:' + action };
      } else expected = { ok: true };
      assert.deepEqual(got, expected);
    }
  });
});

describe('session-collaboration engine (FORGE TQ-024)', () => {
  it('decides every capability through the role matrix', () => {
    assert.deepEqual(roleCatalog(), [
      { role: 'owner', capabilities: ['lifecycle', 'steps', 'messages', 'findings', 'control'] },
      { role: 'tester', capabilities: ['steps', 'messages', 'findings'] },
      { role: 'observer', capabilities: ['messages'] },
    ]);
    assert.deepEqual(checkCapability({ role: 'tester', capability: 'findings' }), { ok: true, allowed: true });
    assert.deepEqual(checkCapability({ role: 'observer', capability: 'steps' }), {
      ok: false,
      allowed: false,
      reason: 'collaboration-capability-denied:observer:steps',
    });
    assert.deepEqual(checkCapability({ role: 'chief', capability: 'steps' }), {
      ok: false,
      reason: 'collaboration-role-unknown:chief',
    });
    assert.deepEqual(checkCapability({ role: 'tester', capability: 'fly' }), {
      ok: false,
      reason: 'collaboration-capability-unknown:fly',
    });
    assert.equal(normalizeRole('  TESTER '), 'tester');
    assert.equal(normalizeRole('chief'), null);
  });

  it('walks the invitation state machine', () => {
    assert.deepEqual(checkInvitation({ state: 'invited', action: 'accept' }), { ok: true, state: 'active' });
    assert.deepEqual(checkInvitation({ state: 'invited', action: 'revoke' }), { ok: true, state: 'revoked' });
    assert.deepEqual(checkInvitation({ state: 'active', action: 'accept' }), {
      ok: false,
      reason: 'collaboration-state-invalid:active:accept',
    });
    assert.deepEqual(checkInvitation({ state: 'ghost', action: 'accept' }), {
      ok: false,
      reason: 'collaboration-state-unknown:ghost',
    });
    assert.deepEqual(checkInvitation({ state: 'invited', action: 'boot' }), {
      ok: false,
      reason: 'collaboration-action-unknown:boot',
    });
  });

  it('matches an independent oracle on 500 mulberry32(42) role checks', () => {
    const MATRIX: Record<string, string[]> = {
      owner: ['lifecycle', 'steps', 'messages', 'findings', 'control'],
      tester: ['steps', 'messages', 'findings'],
      observer: ['messages'],
    };
    const roles = ['owner', 'tester', 'observer', 'boss', ''];
    const caps = ['lifecycle', 'steps', 'messages', 'findings', 'control', 'warp'];
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const role = roles[Math.floor(rand() * roles.length)]!;
      const capability = caps[Math.floor(rand() * caps.length)]!;
      const got = checkCapability({ role, capability });
      let expected: { ok: boolean; reason?: string; allowed?: boolean };
      if (!(role in MATRIX)) expected = { ok: false, reason: 'collaboration-role-unknown:' + String(role) };
      else if (!caps.includes(capability) || capability === 'warp') {
        expected = { ok: false, reason: 'collaboration-capability-unknown:' + String(capability) };
      } else if (!MATRIX[role]!.includes(capability)) {
        expected = { ok: false, allowed: false, reason: 'collaboration-capability-denied:' + role + ':' + capability };
      } else expected = { ok: true, allowed: true };
      assert.deepEqual(got, expected);
    }
  });
});
