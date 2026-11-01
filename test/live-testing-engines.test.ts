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
import { DEVICES, deviceCatalog, NETWORKS, networkCatalog, normalizeDeviceProfile } from '../src/modules/live-testing/engine/device-profile.ts';
import { checkHandoff } from '../src/modules/live-testing/engine/cross-device-handoff.ts';
import { checkInterruption, interruptionCatalog } from '../src/modules/live-testing/engine/interruption-scenario.ts';
import { checkPermissionPlan, nextPermissionState, permissionCatalog } from '../src/modules/live-testing/engine/permission-matrix.ts';
import { checkGesture, gestureCatalog } from '../src/modules/live-testing/engine/gesture-mechanics.ts';
import { applyCreativeOperation, creativeEditorCatalog, INITIAL_CREATIVE_STATE } from '../src/modules/live-testing/engine/creative-tool-operation.ts';
import { avCatalog, avStateTransition, checkPlayback, checkSync } from '../src/modules/live-testing/engine/av-output.ts';
import { checkCleanup, deriveTestAccounts, FIXTURE_DOMAIN } from '../src/modules/live-testing/engine/test-data-lifecycle.ts';

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
      let expected: { ok: boolean; reason?: string; events?: unknown[]; durationMs?: number } | undefined;
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

describe('device-profile engine (FORGE TQ-019..TQ-021)', () => {
  it('lists the twelve named devices and six pinned networks', () => {
    assert.equal(deviceCatalog().length, 12);
    assert.equal(networkCatalog().length, 6);
    assert.deepEqual(DEVICES.filter((d) => d.lowEnd).map((d) => d.device), ['low-end-android', 'low-end-iphone']);
    assert.deepEqual(DEVICES.filter((d) => d.lowEnd).map((d) => d.cpuThrottle), [4, 4]);
    assert.deepEqual(NETWORKS.find((n) => n.network === 'offline'), { network: 'offline', offline: true, downlinkKbps: 0, latencyMs: 0 });
    assert.deepEqual(NETWORKS.find((n) => n.network === 'wifi'), { network: 'wifi', offline: false, downlinkKbps: 30000, latencyMs: 40 });
  });

  it('normalizes one profile verdict out of a device and a network', () => {
    const v = normalizeDeviceProfile({ device: '  Pixel-5  ', network: ' slow-3g ' });
    assert.deepEqual(v.profile, {
      device: 'pixel-5',
      network: 'slow-3g',
      platform: 'android',
      lowEnd: false,
      cpuThrottle: 1,
      offline: false,
      downlinkKbps: 400,
      latencyMs: 2000,
    });
    const lowEnd = normalizeDeviceProfile({ device: 'low-end-android', network: 'offline' });
    assert.deepEqual(lowEnd.profile, {
      device: 'low-end-android',
      network: 'offline',
      platform: 'android',
      lowEnd: true,
      cpuThrottle: 4,
      offline: true,
      downlinkKbps: 0,
      latencyMs: 0,
    });
  });

  it('refuses broken profiles by name', () => {
    assert.deepEqual(normalizeDeviceProfile(null), { ok: false, reason: 'deviceprofile-not-object' });
    assert.deepEqual(normalizeDeviceProfile('pixel-5'), { ok: false, reason: 'deviceprofile-not-object' });
    assert.deepEqual(normalizeDeviceProfile([]), { ok: false, reason: 'deviceprofile-not-object' });
    assert.deepEqual(normalizeDeviceProfile({}), { ok: false, reason: 'device-missing' });
    assert.deepEqual(normalizeDeviceProfile({ device: 'pixel-99' }), { ok: false, reason: 'device-unknown:pixel-99' });
    assert.deepEqual(normalizeDeviceProfile({ device: 'pixel-5' }), { ok: false, reason: 'network-missing' });
    assert.deepEqual(normalizeDeviceProfile({ device: 'pixel-5', network: '9g' }), { ok: false, reason: 'network-unknown:9g' });
  });

  it('matches an independent oracle on 500 mulberry32(42) profile inputs', () => {
    const rand = mulberry32(42);
    const deviceNames = [...DEVICES.map((d) => d.device), 'pixel-99', 'watch'];
    const networkNames = [...NETWORKS.map((n) => n.network), '9g', ''];
    for (let c = 0; c < 500; c++) {
      const input: unknown = c % 11 === 0 ? [c] : c % 13 === 0 ? null : { device: deviceNames[Math.floor(rand() * deviceNames.length)]!, network: networkNames[Math.floor(rand() * networkNames.length)]! };
      const got = normalizeDeviceProfile(input);
      let expected: { ok: boolean; reason?: string; profile?: Record<string, unknown> } | undefined;
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        expected = { ok: false, reason: 'deviceprofile-not-object' };
      } else {
        const obj = input as Record<string, unknown>;
        const dn = typeof obj.device === 'string' ? obj.device.trim().toLowerCase() : '';
        const device = DEVICES.find((d) => d.device === dn);
        const nn = typeof obj.network === 'string' ? obj.network.trim().toLowerCase() : '';
        const network = NETWORKS.find((n) => n.network === nn);
        if (dn.length === 0) expected = { ok: false, reason: 'device-missing' };
        else if (!device) expected = { ok: false, reason: 'device-unknown:' + dn };
        else if (nn.length === 0) expected = { ok: false, reason: 'network-missing' };
        else if (!network) expected = { ok: false, reason: 'network-unknown:' + nn };
        else {
          expected = {
            ok: true,
            profile: {
              device: device.device,
              network: network.network,
              platform: device.platform,
              lowEnd: device.lowEnd,
              cpuThrottle: device.cpuThrottle,
              offline: network.offline,
              downlinkKbps: network.downlinkKbps,
              latencyMs: network.latencyMs,
            },
          };
        }
      }
      assert.deepEqual(got, expected);
    }
  });
});

describe('cross-device-handoff engine (FORGE TQ-025)', () => {
  it('hands an acting session to another named device from the catalog', () => {
    const v = checkHandoff({ status: 'running', toDevice: 'iphone-13', fromDevice: 'pixel-5' });
    assert.deepEqual(v.handoff, {
      fromDevice: 'pixel-5',
      toDevice: 'iphone-13',
      toPlatform: 'ios',
      initial: false,
      platformChanged: true,
      resume: 'manual',
      goalPreserved: true,
    });
    const samePlatform = checkHandoff({ status: 'paused', toDevice: 'ipad-9', fromDevice: 'iphone-13' });
    assert.equal(samePlatform.handoff?.platformChanged, false);
    assert.equal(samePlatform.handoff?.resume, 'automatic');
  });

  it('stages the first device automatically even across platforms', () => {
    const v = checkHandoff({ status: 'running', toDevice: 'iphone-13', platform: 'android' });
    assert.deepEqual(v.handoff, {
      fromDevice: null,
      toDevice: 'iphone-13',
      toPlatform: 'ios',
      initial: true,
      platformChanged: true,
      resume: 'automatic',
      goalPreserved: true,
    });
  });

  it('refuses broken handoffs by name', () => {
    assert.deepEqual(checkHandoff({}), { ok: false, reason: 'handoff-status-missing' });
    assert.deepEqual(checkHandoff({ status: 'completed', toDevice: 'ipad-9' }), { ok: false, reason: 'handoff-state-invalid:completed' });
    assert.deepEqual(checkHandoff({ status: 'running' }), { ok: false, reason: 'handoff-to-missing' });
    assert.deepEqual(checkHandoff({ status: 'running', toDevice: 'pixel-99' }), { ok: false, reason: 'handoff-device-unknown:pixel-99' });
    assert.deepEqual(checkHandoff({ status: 'running', toDevice: 'ipad-9', fromDevice: 'pixel-99' }), { ok: false, reason: 'handoff-device-unknown:pixel-99' });
    assert.deepEqual(checkHandoff({ status: 'running', toDevice: 'ipad-9' }), { ok: false, reason: 'handoff-platform-missing' });
    assert.deepEqual(checkHandoff({ status: 'running', toDevice: 'pixel-5', fromDevice: 'pixel-5' }), { ok: false, reason: 'handoff-same-device' });
  });

  it('matches an independent oracle on 500 mulberry32(42) handoff intents', () => {
    const DEVICE_NAMES = DEVICES.map((d) => d.device);
    const STATUSES = ['running', 'paused', 'completed', 'manual', ''];
    const toList = [...DEVICE_NAMES, ''];
    const fromList = [...DEVICE_NAMES, 'pixel-99'];
    const platforms = ['web', 'android', 'ios', 'desktop', ''];
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const status = STATUSES[Math.floor(rand() * STATUSES.length)]!;
      const to = toList[Math.floor(rand() * toList.length)]!;
      const useFrom = rand() < 0.45;
      const input = {
        status,
        toDevice: to,
        fromDevice: useFrom ? fromList[Math.floor(rand() * fromList.length)]! : undefined,
        platform: useFrom ? undefined : platforms[Math.floor(rand() * platforms.length)]!,
      };
      const got = checkHandoff(input);
      let expected: { ok: boolean; reason?: string; handoff?: Record<string, unknown> } | undefined;
      if (status.length === 0) expected = { ok: false, reason: 'handoff-status-missing' };
      else if (status !== 'running' && status !== 'paused') expected = { ok: false, reason: 'handoff-state-invalid:' + status };
      else if (to.length === 0) expected = { ok: false, reason: 'handoff-to-missing' };
      else if (!DEVICES.some((d) => d.device === to)) expected = { ok: false, reason: 'handoff-device-unknown:' + to };
      else {
        const toSpec = DEVICES.find((d) => d.device === to)!;
        const hasFrom = useFrom && typeof input.fromDevice === 'string' && input.fromDevice.length > 0;
        if (hasFrom) {
          const fn = (input.fromDevice as string).trim().toLowerCase();
          const fromSpec = DEVICES.find((d) => d.device === fn);
          if (!fromSpec) expected = { ok: false, reason: 'handoff-device-unknown:' + fn };
          else if (fromSpec.device === toSpec.device) expected = { ok: false, reason: 'handoff-same-device' };
          else {
            const changed = fromSpec.platform !== toSpec.platform;
            expected = {
              ok: true,
              handoff: {
                fromDevice: fromSpec.device,
                toDevice: toSpec.device,
                toPlatform: toSpec.platform,
                initial: false,
                platformChanged: changed,
                resume: changed ? 'manual' : 'automatic',
                goalPreserved: true,
              },
            };
          }
        } else {
          const platform = typeof input.platform === 'string' ? input.platform : '';
          if (platform.length === 0) expected = { ok: false, reason: 'handoff-platform-missing' };
          else {
            const changed = platform !== toSpec.platform;
            expected = {
              ok: true,
              handoff: {
                fromDevice: null,
                toDevice: toSpec.device,
                toPlatform: toSpec.platform,
                initial: true,
                platformChanged: changed,
                resume: 'automatic',
                goalPreserved: true,
              },
            };
          }
        }
      }
      assert.deepEqual(got, expected);
    }
  });
});

describe('interruption-scenario engine (FORGE TQ-022)', () => {
  it('catalogs the seven interruption scenarios per platform', () => {
    assert.equal(interruptionCatalog().length, 7);
    assert.deepEqual(interruptionCatalog('web').map((s) => s.scenario), ['push-notification', 'network-drop']);
    assert.deepEqual(interruptionCatalog('desktop').map((s) => s.scenario), ['push-notification', 'low-battery', 'network-drop', 'system-update']);
    assert.deepEqual(interruptionCatalog('watch'), []);
  });

  it('rules on live interruptions with a named verdict', () => {
    assert.deepEqual(checkInterruption({ platform: 'android', scenario: 'incoming-call', status: 'running' }), {
      ok: true,
      scenario: 'incoming-call',
      name: 'Incoming call',
      resume: 'manual',
      dataLossRisk: true,
      expectation: 'The app pauses mid-flow and restores full state when the call ends',
    });
    assert.deepEqual(checkInterruption({ platform: 'web', scenario: 'incoming-sms', status: 'running' }), {
      ok: false,
      reason: 'interruption-platform-unsupported:incoming-sms:web',
    });
  });

  it('refuses broken interruptions by name', () => {
    assert.deepEqual(checkInterruption({}), { ok: false, reason: 'interruption-platform-missing' });
    assert.deepEqual(checkInterruption({ platform: 'watch' }), { ok: false, reason: 'interruption-platform-unknown:watch' });
    assert.deepEqual(checkInterruption({ platform: 'web' }), { ok: false, reason: 'interruption-scenario-missing' });
    assert.deepEqual(checkInterruption({ platform: 'web', scenario: 'ghost' }), { ok: false, reason: 'interruption-unknown:ghost' });
    assert.deepEqual(checkInterruption({ platform: 'android', scenario: 'incoming-call' }), { ok: false, reason: 'interruption-status-missing' });
    assert.deepEqual(checkInterruption({ platform: 'android', scenario: 'incoming-call', status: 'paused' }), { ok: false, reason: 'interruption-session-not-running:paused' });
  });

  it('matches an independent oracle on 500 mulberry32(42) interruption intents', () => {
    const SCENARIOS = interruptionCatalog();
    const scenarioNames = [...SCENARIOS.map((s) => s.scenario), 'ghost', ''];
    const platforms = ['web', 'android', 'ios', 'desktop', 'watch'];
    const statuses = ['running', 'paused', 'manual', 'completed', ''];
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const platform = platforms[Math.floor(rand() * platforms.length)]!;
      const scenario = scenarioNames[Math.floor(rand() * scenarioNames.length)]!;
      const status = statuses[Math.floor(rand() * statuses.length)]!;
      const got = checkInterruption({ platform, scenario, status });
      const spec = SCENARIOS.find((s) => s.scenario === scenario);
      let expected: { ok: boolean; reason?: string; scenario?: string; name?: string; resume?: string; dataLossRisk?: boolean; expectation?: string } | undefined;
      if (!['web', 'android', 'ios', 'desktop'].includes(platform)) expected = { ok: false, reason: 'interruption-platform-unknown:' + platform };
      else if (scenario.length === 0) expected = { ok: false, reason: 'interruption-scenario-missing' };
      else if (!spec) expected = { ok: false, reason: 'interruption-unknown:' + scenario };
      else if (!spec.platforms.includes(platform)) expected = { ok: false, reason: 'interruption-platform-unsupported:' + scenario + ':' + platform };
      else if (status.length === 0) expected = { ok: false, reason: 'interruption-status-missing' };
      else if (status !== 'running') expected = { ok: false, reason: 'interruption-session-not-running:' + status };
      else expected = { ok: true, scenario: spec.scenario, name: spec.name, resume: spec.resume, dataLossRisk: spec.dataLossRisk, expectation: spec.expectation };
      assert.deepEqual(got, expected);
    }
  });
});

describe('permission-matrix engine (FORGE TQ-023)', () => {
  it('catalogs the per platform permission vocabulary', () => {
    assert.equal(permissionCatalog().length, 4);
    assert.deepEqual(permissionCatalog('web'), [
      { platform: 'web', permissions: ['camera', 'clipboard-read', 'location', 'microphone', 'notifications'] },
    ]);
    assert.equal(permissionCatalog('android')[0]!.permissions.length, 7);
    assert.equal(permissionCatalog('ios')[0]!.permissions.length, 7);
    assert.deepEqual(permissionCatalog('watch'), []);
  });

  it('stages permission plans with counts and named refusals', () => {
    const v = checkPermissionPlan({
      platform: 'web',
      grants: [
        { permission: 'camera', state: 'granted' },
        { permission: 'location', state: 'ask' },
        { permission: 'microphone', state: 'denied' },
      ],
    });
    assert.equal(v.ok, true);
    assert.deepEqual(v.plan, [
      { permission: 'camera', state: 'granted' },
      { permission: 'location', state: 'ask' },
      { permission: 'microphone', state: 'denied' },
    ]);
    assert.deepEqual([v.granted, v.denied, v.ask], [1, 1, 1]);

    assert.deepEqual(checkPermissionPlan({}), { ok: false, reason: 'permission-platform-missing' });
    assert.deepEqual(checkPermissionPlan({ platform: 'watch' }), { ok: false, reason: 'permission-platform-unknown:watch' });
    assert.deepEqual(checkPermissionPlan({ platform: 'web' }), { ok: false, reason: 'permission-plan-not-array' });
    assert.deepEqual(checkPermissionPlan({ platform: 'web', grants: [] }), { ok: false, reason: 'permission-plan-empty' });
    assert.deepEqual(checkPermissionPlan({ platform: 'web', grants: [null] }), { ok: false, reason: 'permission-grant-not-object' });
    assert.deepEqual(checkPermissionPlan({ platform: 'web', grants: [{ state: 'granted' }] }), { ok: false, reason: 'permission-name-missing' });
    assert.deepEqual(checkPermissionPlan({ platform: 'web', grants: [{ permission: 'photos', state: 'granted' }] }), { ok: false, reason: 'permission-unknown:photos:web' });
    assert.deepEqual(checkPermissionPlan({ platform: 'web', grants: [{ permission: 'camera' }] }), { ok: false, reason: 'permission-state-missing' });
    assert.deepEqual(checkPermissionPlan({ platform: 'web', grants: [{ permission: 'camera', state: 'maybe' }] }), { ok: false, reason: 'permission-state-invalid:maybe' });
    assert.deepEqual(checkPermissionPlan({ platform: 'web', grants: [{ permission: 'camera', state: 'blocked' }] }), { ok: false, reason: 'permission-state-not-planable:blocked' });
    assert.deepEqual(checkPermissionPlan({ platform: 'web', grants: [{ permission: 'camera', state: 'granted' }, { permission: 'camera', state: 'ask' }] }), { ok: false, reason: 'permission-duplicate:camera' });
  });

  it('walks the ask, grant, deny and block runtime flow', () => {
    assert.deepEqual(nextPermissionState({ current: 'ask', choice: 'grant' }), { ok: true, state: 'granted', askable: false });
    assert.deepEqual(nextPermissionState({ current: 'ask', choice: 'deny' }), { ok: true, state: 'denied', askable: true });
    assert.deepEqual(nextPermissionState({ current: 'denied', choice: 'grant' }), { ok: true, state: 'granted', askable: false });
    assert.deepEqual(nextPermissionState({ current: 'denied', choice: 'deny' }), { ok: true, state: 'blocked', askable: false });
    assert.deepEqual(nextPermissionState({ current: 'granted', choice: 'deny' }), { ok: true, state: 'denied', askable: true });
    assert.deepEqual(nextPermissionState({ current: 'granted', choice: 'grant' }), { ok: true, state: 'granted', askable: false });
    assert.deepEqual(nextPermissionState({ current: 'blocked', choice: 'grant' }), { ok: false, reason: 'permission-blocked-no-prompt' });
    assert.deepEqual(nextPermissionState({ current: 'junk' }), { ok: false, reason: 'permission-state-unknown:junk' });
    assert.deepEqual(nextPermissionState({ current: 'ask', choice: 'maybe' }), { ok: false, reason: 'permission-choice-invalid:maybe' });
  });

  it('matches an independent oracle on 500 mulberry32(42) runtime choices', () => {
    const states = ['ask', 'granted', 'denied', 'blocked', 'junk', ''];
    const choices = ['grant', 'deny', 'maybe', ''];
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const current = states[Math.floor(rand() * states.length)]!;
      const choice = choices[Math.floor(rand() * choices.length)]!;
      const got = nextPermissionState({ current, choice });
      let expected: { ok: boolean; reason?: string; state?: string; askable?: boolean } | undefined;
      if (!['ask', 'granted', 'denied', 'blocked'].includes(current)) {
        expected = { ok: false, reason: 'permission-state-unknown:' + current };
      } else if (current === 'blocked') {
        expected = { ok: false, reason: 'permission-blocked-no-prompt' };
      } else if (choice !== 'grant' && choice !== 'deny') {
        expected = { ok: false, reason: 'permission-choice-invalid:' + choice };
      } else if (current === 'ask') {
        expected = choice === 'grant' ? { ok: true, state: 'granted', askable: false } : { ok: true, state: 'denied', askable: true };
      } else if (current === 'denied') {
        expected = choice === 'grant' ? { ok: true, state: 'granted', askable: false } : { ok: true, state: 'blocked', askable: false };
      } else {
        expected = choice === 'deny' ? { ok: true, state: 'denied', askable: true } : { ok: true, state: 'granted', askable: false };
      }
      assert.deepEqual(got, expected);
    }
  });
});

describe('gesture-mechanics engine (FORGE TQ-026)', () => {
  it('catalogs gesture physics per platform', () => {
    assert.equal(gestureCatalog().length, 7);
    assert.equal(gestureCatalog('ios').length, 7);
    assert.equal(gestureCatalog('android').length, 6);
    assert.deepEqual(gestureCatalog('web'), []);
    assert.deepEqual(gestureCatalog('watch'), []);
  });

  it('checks gesture physics with pinned verdicts', () => {
    assert.deepEqual(checkGesture({ platform: 'android', gesture: 'swipe', direction: 'up' }), {
      ok: true,
      gesture: 'swipe',
      platform: 'android',
      contacts: 1,
      direction: 'up',
      pressure: null,
      durationMs: null,
      text: 'Swiping up with 1 finger',
    });
    assert.deepEqual(checkGesture({ platform: 'ios', gesture: 'long-press' }), {
      ok: true,
      gesture: 'long-press',
      platform: 'ios',
      contacts: 1,
      direction: null,
      pressure: null,
      durationMs: 500,
      text: 'Long pressing for 500ms',
    });
    assert.deepEqual(checkGesture({ platform: 'ios', gesture: 'stylus-pressure', pressure: 0.5 }), {
      ok: true,
      gesture: 'stylus-pressure',
      platform: 'ios',
      contacts: 1,
      direction: null,
      pressure: 0.5,
      durationMs: null,
      text: 'Drawing with stylus at 0.5 pressure',
    });
    assert.deepEqual(checkGesture({ platform: 'android', gesture: 'multi-touch', contacts: 3 }), {
      ok: true,
      gesture: 'multi-touch',
      platform: 'android',
      contacts: 3,
      direction: null,
      pressure: null,
      durationMs: null,
      text: 'Touching with 3 fingers',
    });
  });

  it('refuses physically impossible gestures by name', () => {
    assert.deepEqual(checkGesture({}), { ok: false, reason: 'gesture-platform-missing' });
    assert.deepEqual(checkGesture({ platform: 'watch' }), { ok: false, reason: 'gesture-platform-unknown:watch' });
    assert.deepEqual(checkGesture({ platform: 'android' }), { ok: false, reason: 'gesture-missing' });
    assert.deepEqual(checkGesture({ platform: 'android', gesture: 'churn' }), { ok: false, reason: 'gesture-unknown:churn' });
    assert.deepEqual(checkGesture({ platform: 'web', gesture: 'tap' }), { ok: false, reason: 'gesture-platform-unsupported:tap:web' });
    assert.deepEqual(checkGesture({ platform: 'android', gesture: 'swipe' }), { ok: false, reason: 'gesture-direction-missing' });
    assert.deepEqual(checkGesture({ platform: 'android', gesture: 'swipe', direction: 'sideways' }), { ok: false, reason: 'gesture-direction-invalid:sideways' });
    assert.deepEqual(checkGesture({ platform: 'android', gesture: 'tap', direction: 'up' }), { ok: false, reason: 'gesture-direction-unexpected' });
    assert.deepEqual(checkGesture({ platform: 'ios', gesture: 'stylus-pressure' }), { ok: false, reason: 'gesture-pressure-missing' });
    assert.deepEqual(checkGesture({ platform: 'ios', gesture: 'stylus-pressure', pressure: 2 }), { ok: false, reason: 'gesture-pressure-invalid:2' });
    assert.deepEqual(checkGesture({ platform: 'android', gesture: 'tap', pressure: 0.5 }), { ok: false, reason: 'gesture-pressure-unexpected' });
    assert.deepEqual(checkGesture({ platform: 'android', gesture: 'long-press', durationMs: 50 }), { ok: false, reason: 'gesture-duration-invalid:50' });
    assert.deepEqual(checkGesture({ platform: 'android', gesture: 'long-press', durationMs: 20000 }), { ok: false, reason: 'gesture-duration-invalid:20000' });
    assert.deepEqual(checkGesture({ platform: 'android', gesture: 'tap', durationMs: 300 }), { ok: false, reason: 'gesture-duration-unexpected' });
    assert.deepEqual(checkGesture({ platform: 'android', gesture: 'pinch', contacts: 1 }), { ok: false, reason: 'gesture-contacts-invalid:1' });
    assert.deepEqual(checkGesture({ platform: 'android', gesture: 'multi-touch', contacts: 6 }), { ok: false, reason: 'gesture-contacts-invalid:6' });
  });

  it('matches an independent oracle on 500 mulberry32(42) gesture intents', () => {
    const SPECS = gestureCatalog();
    const platforms = ['web', 'android', 'ios', 'desktop', 'watch', ''];
    const gestures = [...SPECS.map((s) => s.gesture), 'churn', ''];
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const platform = platforms[Math.floor(rand() * platforms.length)]!;
      const gesture = gestures[Math.floor(rand() * gestures.length)]!;
      const spec = SPECS.find((s) => s.gesture === gesture);
      const intent = {
        platform,
        gesture,
        contacts: rand() < 0.5 ? (spec ? spec.minContacts + Math.floor(rand() * (spec.maxContacts - spec.minContacts + 2)) : 2) : undefined,
        direction: rand() < 0.5 ? ['up', 'down', 'left', 'right', 'sideways'][Math.floor(rand() * 5)]! : undefined,
        pressure: rand() < 0.4 ? [0.25, 0.5, 1, 2, 0][Math.floor(rand() * 5)]! : undefined,
        durationMs: rand() < 0.4 ? [100, 500, 250, 10000, 50, 20000][Math.floor(rand() * 6)]! : undefined,
      };
      const got = checkGesture(intent);
      let expected: { ok: boolean; reason?: string; gesture?: string; platform?: string; contacts?: number; direction?: string | null; pressure?: number | null; durationMs?: number | null; text?: string } | undefined;
      if (platform.length === 0) expected = { ok: false, reason: 'gesture-platform-missing' };
      else if (!['web', 'android', 'ios', 'desktop'].includes(platform)) expected = { ok: false, reason: 'gesture-platform-unknown:' + platform };
      else if (gesture.length === 0) expected = { ok: false, reason: 'gesture-missing' };
      else if (!spec) expected = { ok: false, reason: 'gesture-unknown:' + gesture };
      else if (!spec.platforms.includes(platform)) expected = { ok: false, reason: 'gesture-platform-unsupported:' + gesture + ':' + platform };
      else {
        let contacts = spec.minContacts;
        let bad = false;
        if (intent.contacts !== undefined) {
          const cc = Number(intent.contacts);
          if (!Number.isInteger(cc) || cc < spec.minContacts || cc > spec.maxContacts) {
            expected = { ok: false, reason: 'gesture-contacts-invalid:' + String(intent.contacts) };
            bad = true;
          } else {
            contacts = cc;
          }
        }
        let direction: string | null = null;
        if (!bad) {
          if (spec.requiresDirection) {
            const d = typeof intent.direction === 'string' ? intent.direction.trim().toLowerCase() : '';
            if (d.length === 0) {
              expected = { ok: false, reason: 'gesture-direction-missing' };
              bad = true;
            } else if (!['up', 'down', 'left', 'right'].includes(d)) {
              expected = { ok: false, reason: 'gesture-direction-invalid:' + d };
              bad = true;
            } else {
              direction = d;
            }
          } else if (typeof intent.direction === 'string' && intent.direction.trim().length > 0) {
            expected = { ok: false, reason: 'gesture-direction-unexpected' };
            bad = true;
          }
        }
        let pressure: number | null = null;
        if (!bad) {
          if (spec.requiresPressure) {
            if (intent.pressure === undefined) {
              expected = { ok: false, reason: 'gesture-pressure-missing' };
              bad = true;
            } else {
              const pr = Number(intent.pressure);
              if (!Number.isFinite(pr) || pr <= 0 || pr > 1) {
                expected = { ok: false, reason: 'gesture-pressure-invalid:' + String(intent.pressure) };
                bad = true;
              } else {
                pressure = pr;
              }
            }
          } else if (intent.pressure !== undefined) {
            expected = { ok: false, reason: 'gesture-pressure-unexpected' };
            bad = true;
          }
        }
        let durationMs: number | null = null;
        if (!bad) {
          if (spec.allowsDuration) {
            if (intent.durationMs !== undefined) {
              const d = Number(intent.durationMs);
              if (!Number.isInteger(d) || d < 100 || d > 10000) {
                expected = { ok: false, reason: 'gesture-duration-invalid:' + String(intent.durationMs) };
                bad = true;
              } else {
                durationMs = d;
              }
            } else {
              durationMs = 500;
            }
          } else if (intent.durationMs !== undefined) {
            expected = { ok: false, reason: 'gesture-duration-unexpected' };
            bad = true;
          }
        }
        if (!bad) {
          const fingers = contacts === 1 ? ' finger' : ' fingers';
          const text =
            gesture === 'tap'
              ? 'Tapping with 1 finger'
              : gesture === 'swipe'
                ? 'Swiping ' + direction + ' with 1 finger'
                : gesture === 'long-press'
                  ? 'Long pressing for ' + durationMs + 'ms'
                  : gesture === 'pinch'
                    ? 'Pinching with 2 fingers'
                    : gesture === 'rotate'
                      ? 'Rotating with 2 fingers'
                      : gesture === 'multi-touch'
                        ? 'Touching with ' + contacts + fingers
                        : 'Drawing with stylus at ' + pressure + ' pressure';
          expected = { ok: true, gesture, platform, contacts, direction, pressure, durationMs, text };
        }
      }
      assert.deepEqual(got, expected);
    }
  });
});

describe('creative-tool-operation engine (FORGE TQ-027)', () => {
  it('catalogs the per editor operation vocabulary', () => {
    assert.deepEqual(creativeEditorCatalog(), {
      manhwa: ['draw', 'paint', 'layer-add', 'layer-merge', 'layer-hide', 'undo', 'redo'],
      'three-d': ['object-add', 'object-move', 'object-rotate', 'camera-orbit', 'undo', 'redo'],
      music: ['note-place', 'note-drag', 'clip-trim', 'instrument-select', 'undo', 'redo'],
    });
  });

  it('applies edits under limits and keeps undo and redo stacks honest', () => {
    const draw = applyCreativeOperation(null, { editor: 'manhwa', operation: 'draw' });
    assert.deepEqual(draw.state, { layers: 1, objects: 0, notes: 0, undoDepth: 1, redoDepth: 0 });
    const layered = applyCreativeOperation(draw.state, { editor: 'manhwa', operation: 'layer-add' });
    assert.deepEqual(layered.state, { layers: 2, objects: 0, notes: 0, undoDepth: 2, redoDepth: 0 });
    const undone = applyCreativeOperation(layered.state, { editor: 'manhwa', operation: 'undo' });
    assert.deepEqual(undone.state, { layers: 2, objects: 0, notes: 0, undoDepth: 1, redoDepth: 1 });
    const redone = applyCreativeOperation(undone.state, { editor: 'manhwa', operation: 'redo' });
    assert.deepEqual(redone.state, { layers: 2, objects: 0, notes: 0, undoDepth: 2, redoDepth: 0 });
    const cleared = applyCreativeOperation(undone.state, { editor: 'manhwa', operation: 'paint' });
    assert.deepEqual(cleared.state, { layers: 2, objects: 0, notes: 0, undoDepth: 2, redoDepth: 0 });
  });

  it('refuses broken creative operations by name', () => {
    assert.deepEqual(applyCreativeOperation(null, {}), { ok: false, reason: 'creative-editor-missing' });
    assert.deepEqual(applyCreativeOperation(null, { editor: 'photoshop' }), { ok: false, reason: 'creative-editor-unknown:photoshop' });
    assert.deepEqual(applyCreativeOperation(null, { editor: 'manhwa' }), { ok: false, reason: 'creative-operation-missing' });
    assert.deepEqual(applyCreativeOperation(null, { editor: 'manhwa', operation: 'note-place' }), { ok: false, reason: 'creative-operation-unknown:note-place:manhwa' });
    assert.deepEqual(applyCreativeOperation(null, { editor: 'manhwa', operation: 'undo' }), { ok: false, reason: 'creative-undo-empty' });
    assert.deepEqual(applyCreativeOperation(null, { editor: 'manhwa', operation: 'redo' }), { ok: false, reason: 'creative-redo-empty' });
    assert.deepEqual(applyCreativeOperation({ layers: 50, objects: 0, notes: 0, undoDepth: 5, redoDepth: 0 }, { editor: 'manhwa', operation: 'layer-add' }), { ok: false, reason: 'creative-layer-limit:50' });
    assert.deepEqual(applyCreativeOperation(INITIAL_CREATIVE_STATE, { editor: 'manhwa', operation: 'layer-merge' }), { ok: false, reason: 'creative-layer-floor:1' });
    assert.deepEqual(applyCreativeOperation({ layers: 1, objects: 200, notes: 0, undoDepth: 5, redoDepth: 0 }, { editor: 'three-d', operation: 'object-add' }), { ok: false, reason: 'creative-object-limit:200' });
    assert.deepEqual(applyCreativeOperation({ layers: 1, objects: 0, notes: 500, undoDepth: 5, redoDepth: 0 }, { editor: 'music', operation: 'note-place' }), { ok: false, reason: 'creative-note-limit:500' });
    const garbage = applyCreativeOperation('junk', { editor: 'music', operation: 'note-place' });
    assert.deepEqual(garbage.state, { layers: 1, objects: 0, notes: 1, undoDepth: 1, redoDepth: 0 });
  });

  it('matches an independent oracle on 500 mulberry32(42) operation sequences', () => {
    const rand = mulberry32(42);
    const catalog = creativeEditorCatalog();
    for (let c = 0; c < 500; c++) {
      const editor = ['manhwa', 'three-d', 'music'][Math.floor(rand() * 3)]!;
      const ops = catalog[editor]!;
      let state: unknown = null;
      let oracle = { layers: 1, objects: 0, notes: 0, undoDepth: 0, redoDepth: 0 };
      const n = 1 + Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        const operation = ops[Math.floor(rand() * ops.length)]!;
        const got = applyCreativeOperation(state, { editor, operation });
        let next: { layers: number; objects: number; notes: number; undoDepth: number; redoDepth: number };
        if (operation === 'undo') {
          if (oracle.undoDepth === 0) {
            assert.deepEqual(got, { ok: false, reason: 'creative-undo-empty' });
            continue;
          }
          next = { ...oracle, undoDepth: oracle.undoDepth - 1, redoDepth: oracle.redoDepth + 1 };
        } else if (operation === 'redo') {
          if (oracle.redoDepth === 0) {
            assert.deepEqual(got, { ok: false, reason: 'creative-redo-empty' });
            continue;
          }
          next = { ...oracle, redoDepth: oracle.redoDepth - 1, undoDepth: oracle.undoDepth + 1 };
        } else {
          next = { ...oracle, undoDepth: oracle.undoDepth + 1, redoDepth: 0 };
          if (operation === 'layer-add') {
            if (oracle.layers >= 50) {
              assert.deepEqual(got, { ok: false, reason: 'creative-layer-limit:50' });
              continue;
            }
            next.layers = oracle.layers + 1;
          } else if (operation === 'layer-merge') {
            if (oracle.layers <= 1) {
              assert.deepEqual(got, { ok: false, reason: 'creative-layer-floor:1' });
              continue;
            }
            next.layers = oracle.layers - 1;
          } else if (operation === 'object-add') {
            if (oracle.objects >= 200) {
              assert.deepEqual(got, { ok: false, reason: 'creative-object-limit:200' });
              continue;
            }
            next.objects = oracle.objects + 1;
          } else if (operation === 'note-place') {
            if (oracle.notes >= 500) {
              assert.deepEqual(got, { ok: false, reason: 'creative-note-limit:500' });
              continue;
            }
            next.notes = oracle.notes + 1;
          }
        }
        assert.equal(got.ok, true);
        assert.deepEqual(got.state, next);
        oracle = next;
        state = got.state;
      }
    }
  });
});

describe('av-output engine (FORGE TQ-028)', () => {
  it('catalogs codec support per platform', () => {
    assert.deepEqual(avCatalog(), { platform: null, video: ['h264', 'vp9', 'av1', 'hevc'], audio: ['aac', 'opus', 'mp3', 'amr', 'flac'] });
    assert.deepEqual(avCatalog('web'), { platform: 'web', video: ['h264', 'vp9', 'av1'], audio: ['aac', 'opus', 'mp3'] });
    assert.deepEqual(avCatalog('desktop'), { platform: 'desktop', video: ['h264', 'vp9', 'av1', 'hevc'], audio: ['aac', 'opus', 'mp3', 'flac'] });
    assert.deepEqual(avCatalog('watch'), { platform: null, video: [], audio: [] });
  });

  it('checks playback with pinned verdicts and named refusals', () => {
    assert.deepEqual(checkPlayback({ platform: 'web', kind: 'video', codec: 'h264' }), {
      ok: true,
      platform: 'web',
      kind: 'video',
      codec: 'h264',
      plays: true,
      text: 'Checking h264 video playback on web',
    });
    assert.deepEqual(checkPlayback({}), { ok: false, reason: 'av-platform-missing' });
    assert.deepEqual(checkPlayback({ platform: 'watch', kind: 'video', codec: 'h264' }), { ok: false, reason: 'av-platform-unknown:watch' });
    assert.deepEqual(checkPlayback({ platform: 'web' }), { ok: false, reason: 'av-kind-missing' });
    assert.deepEqual(checkPlayback({ platform: 'web', kind: 'film' }), { ok: false, reason: 'av-kind-unknown:film' });
    assert.deepEqual(checkPlayback({ platform: 'web', kind: 'video' }), { ok: false, reason: 'av-codec-missing' });
    assert.deepEqual(checkPlayback({ platform: 'web', kind: 'video', codec: 'zz' }), { ok: false, reason: 'av-codec-unknown:zz' });
    assert.deepEqual(checkPlayback({ platform: 'web', kind: 'video', codec: 'opus' }), { ok: false, reason: 'av-codec-wrong-kind:opus' });
    assert.deepEqual(checkPlayback({ platform: 'web', kind: 'audio', codec: 'h264' }), { ok: false, reason: 'av-codec-wrong-kind:h264' });
    assert.deepEqual(checkPlayback({ platform: 'web', kind: 'audio', codec: 'flac' }), { ok: false, reason: 'av-codec-unsupported:flac:web' });
  });

  it('bands sync drift and walks the media state machine', () => {
    assert.deepEqual(checkSync(50), {
      ok: true,
      driftMs: 50,
      sync: 'drifting',
      detectable: true,
      acceptable: true,
      text: 'Measuring audio and video drift of 50ms',
    });
    assert.deepEqual(checkSync(-200), {
      ok: true,
      driftMs: -200,
      sync: 'out-of-sync',
      detectable: true,
      acceptable: false,
      text: 'Measuring audio and video drift of -200ms',
    });
    assert.deepEqual(checkSync(30), {
      ok: true,
      driftMs: 30,
      sync: 'in-sync',
      detectable: false,
      acceptable: true,
      text: 'Measuring audio and video drift of 30ms',
    });
    assert.deepEqual(checkSync(undefined), { ok: false, reason: 'av-drift-missing' });
    assert.deepEqual(checkSync('x'), { ok: false, reason: 'av-drift-not-a-number:x' });
    assert.deepEqual(avStateTransition('idle', 'playing'), { ok: true, from: 'idle', to: 'playing', text: 'Media moves from idle to playing' });
    assert.deepEqual(avStateTransition('idle', 'paused'), { ok: false, reason: 'av-state-refused:idle:paused' });
    assert.deepEqual(avStateTransition('ended', 'playing'), { ok: false, reason: 'av-state-refused:ended:playing' });
    assert.deepEqual(avStateTransition('', 'playing'), { ok: false, reason: 'av-state-missing' });
    assert.deepEqual(avStateTransition('junk', 'playing'), { ok: false, reason: 'av-state-unknown:junk' });
    assert.deepEqual(avStateTransition('idle', 'junk'), { ok: false, reason: 'av-state-unknown:junk' });
  });

  it('matches an independent oracle on 500 mulberry32(42) playback intents', () => {
    const TABLE: Record<string, { video: string[]; audio: string[] }> = {
      web: { video: ['h264', 'vp9', 'av1'], audio: ['aac', 'opus', 'mp3'] },
      android: { video: ['h264', 'hevc'], audio: ['aac', 'opus', 'amr'] },
      ios: { video: ['h264', 'hevc'], audio: ['aac', 'opus'] },
      desktop: { video: ['h264', 'vp9', 'av1', 'hevc'], audio: ['aac', 'opus', 'mp3', 'flac'] },
    };
    const ALL_VIDEO = ['h264', 'vp9', 'av1', 'hevc'];
    const ALL_AUDIO = ['aac', 'opus', 'mp3', 'amr', 'flac'];
    const platforms = ['web', 'android', 'ios', 'desktop', 'watch', ''];
    const kinds = ['video', 'audio', 'film', ''];
    const codecs = [...ALL_VIDEO, ...ALL_AUDIO, 'zz', ''];
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const platform = platforms[Math.floor(rand() * platforms.length)]!;
      const kind = kinds[Math.floor(rand() * kinds.length)]!;
      const codec = codecs[Math.floor(rand() * codecs.length)]!;
      const got = checkPlayback({ platform, kind, codec });
      let expected: { ok: boolean; reason?: string; platform?: string; kind?: string; codec?: string; plays?: boolean; text?: string } | undefined;
      if (platform.length === 0) expected = { ok: false, reason: 'av-platform-missing' };
      else if (!(platform in TABLE)) expected = { ok: false, reason: 'av-platform-unknown:' + platform };
      else if (kind.length === 0) expected = { ok: false, reason: 'av-kind-missing' };
      else if (kind !== 'video' && kind !== 'audio') expected = { ok: false, reason: 'av-kind-unknown:' + kind };
      else if (codec.length === 0) expected = { ok: false, reason: 'av-codec-missing' };
      else if (!ALL_VIDEO.includes(codec) && !ALL_AUDIO.includes(codec)) expected = { ok: false, reason: 'av-codec-unknown:' + codec };
      else if (kind === 'video' && !ALL_VIDEO.includes(codec)) expected = { ok: false, reason: 'av-codec-wrong-kind:' + codec };
      else if (kind === 'audio' && !ALL_AUDIO.includes(codec)) expected = { ok: false, reason: 'av-codec-wrong-kind:' + codec };
      else if (!(TABLE[platform] as Record<string, string[]>)[kind]!.includes(codec)) {
        expected = { ok: false, reason: 'av-codec-unsupported:' + codec + ':' + platform };
      } else {
        expected = { ok: true, platform, kind, codec, plays: true, text: 'Checking ' + codec + ' ' + kind + ' playback on ' + platform };
      }
      assert.deepEqual(got, expected);
    }
  });

  it('matches an independent oracle on 500 mulberry32(42) sync and state pairs', () => {
    const STATES = ['idle', 'playing', 'paused', 'ended', 'junk', ''];
    const LEGAL: Record<string, string[]> = { idle: ['playing'], playing: ['paused', 'ended'], paused: ['playing'], ended: [] };
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const driftRaw: unknown = c % 23 === 0 ? 'x' : c % 29 === 0 ? null : Math.floor(rand() * 400) - 200;
      const sync = checkSync(driftRaw);
      if (driftRaw === undefined || driftRaw === null) {
        assert.deepEqual(sync, { ok: false, reason: 'av-drift-missing' });
      } else if (!Number.isFinite(Number(driftRaw))) {
        assert.deepEqual(sync, { ok: false, reason: 'av-drift-not-a-number:' + String(driftRaw) });
      } else {
        const d = Number(driftRaw);
        let band = 'in-sync';
        if (d > 45 || d < -125) band = 'drifting';
        if (d > 90 || d < -185) band = 'out-of-sync';
        assert.deepEqual(sync, {
          ok: true,
          driftMs: d,
          sync: band,
          detectable: band !== 'in-sync',
          acceptable: band !== 'out-of-sync',
          text: 'Measuring audio and video drift of ' + d + 'ms',
        });
      }
      const from = STATES[Math.floor(rand() * STATES.length)]!;
      const to = STATES[Math.floor(rand() * STATES.length)]!;
      const st = avStateTransition(from, to);
      let stateExpected: { ok: boolean; reason?: string; from?: string; to?: string; text?: string } | undefined;
      if (from.length === 0) stateExpected = { ok: false, reason: 'av-state-missing' };
      else if (!(from in LEGAL)) stateExpected = { ok: false, reason: 'av-state-unknown:' + from };
      else if (to.length === 0) stateExpected = { ok: false, reason: 'av-state-missing' };
      else if (!(to in LEGAL)) stateExpected = { ok: false, reason: 'av-state-unknown:' + to };
      else if (!LEGAL[from]!.includes(to)) stateExpected = { ok: false, reason: 'av-state-refused:' + from + ':' + to };
      else stateExpected = { ok: true, from, to, text: 'Media moves from ' + from + ' to ' + to };
      assert.deepEqual(st, stateExpected);
    }
  });
});

describe('test-data-lifecycle engine (FORGE TQ-029)', () => {
  it('derives deterministic accounts from the session seed', () => {
    const v = deriveTestAccounts('session-abc', undefined);
    assert.equal(v.ok, true);
    assert.equal(v.domain, FIXTURE_DOMAIN);
    assert.deepEqual(v.accounts?.map((a) => a.username), ['forge-sessionabc-1', 'forge-sessionabc-2', 'forge-sessionabc-3']);
    assert.deepEqual(v.accounts?.map((a) => a.role), ['shopper', 'editor', 'viewer']);
    const four = deriveTestAccounts('session-abc', 4);
    assert.equal(four.accounts?.[3]?.role, 'admin');
    const tiny = deriveTestAccounts('s', undefined);
    assert.deepEqual(tiny.accounts?.map((a) => a.username), ['forge-s-1', 'forge-s-2', 'forge-s-3']);
    assert.equal(deriveTestAccounts('seed', 12).accounts?.length, 12);
    assert.deepEqual(deriveTestAccounts('seed', 0), { ok: false, reason: 'data-count-invalid:0' });
    assert.deepEqual(deriveTestAccounts('seed', 13), { ok: false, reason: 'data-count-invalid:13' });
    assert.deepEqual(deriveTestAccounts('seed', 2.5), { ok: false, reason: 'data-count-invalid:2.5' });
    assert.deepEqual(deriveTestAccounts('', undefined), { ok: false, reason: 'data-seed-missing' });
    assert.deepEqual(deriveTestAccounts('seed', 3), deriveTestAccounts('seed', 3));
  });

  it('cleans up only terminal sessions with a named plan', () => {
    assert.deepEqual(checkCleanup({}), { ok: false, reason: 'data-status-missing' });
    assert.deepEqual(checkCleanup({ status: 'running', pending: 3, cleaned: 0 }), {
      ok: false,
      reason: 'data-cleanup-status-refused:running',
    });
    assert.deepEqual(checkCleanup({ status: 'completed', pending: undefined }), { ok: false, reason: 'data-pending-invalid:undefined' });
    assert.deepEqual(checkCleanup({ status: 'completed', pending: -1 }), { ok: false, reason: 'data-pending-invalid:-1' });
    assert.deepEqual(checkCleanup({ status: 'completed', pending: 1 }), { ok: false, reason: 'data-cleaned-invalid:undefined' });
    assert.deepEqual(checkCleanup({ status: 'completed', pending: 0, cleaned: 2 }), {
      ok: true,
      alreadyClean: true,
      plan: [],
      pending: 0,
      cleaned: 2,
    });
    assert.deepEqual(checkCleanup({ status: 'failed', pending: 3, cleaned: 1 }), {
      ok: true,
      alreadyClean: false,
      plan: ['disable fixtures', 'purge seeded uploads', 'restore app settings', 'remove test accounts'],
      pending: 3,
      cleaned: 1,
    });
  });

  it('matches an independent oracle on 500 mulberry32(42) account plans', () => {
    const rand = mulberry32(42);
    const LOWER = 'abcdefghjkmnpqrstuvwxyz';
    const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
    const DIGITS = '23456789';
    for (let c = 0; c < 500; c++) {
      const seed = c % 17 === 0 ? '!!' : 'lt-' + c;
      const countRaw: unknown = c % 19 === 0 ? 2.5 : Math.floor(rand() * 15);
      const got = deriveTestAccounts(seed, countRaw);
      const count = Number(countRaw);
      if (!Number.isInteger(count) || count < 1 || count > 12) {
        assert.deepEqual(got, { ok: false, reason: 'data-count-invalid:' + String(countRaw) });
        continue;
      }
      assert.equal(got.ok, true);
      const slugRaw = seed.replace(/[^a-z0-9]/g, '');
      const slug = slugRaw.length > 0 ? slugRaw.slice(0, 12) : 'session';
      assert.equal(got.accounts?.length, count);
      for (let i = 0; i < count; i++) {
        const account = got.accounts?.[i];
        const username = 'forge-' + slug + '-' + (i + 1);
        assert.equal(account?.username, username);
        assert.equal(account?.email, username + '@' + FIXTURE_DOMAIN);
        assert.equal(account?.role, ['shopper', 'editor', 'viewer', 'admin'][i % 4]);
        const password = account?.password ?? '';
        assert.equal(password.length, 12);
        let lower = 0;
        let upper = 0;
        let digits = 0;
        for (const ch of password) {
          if (LOWER.includes(ch)) lower++;
          else if (UPPER.includes(ch)) upper++;
          else if (DIGITS.includes(ch)) digits++;
        }
        assert.deepEqual([lower, upper, digits], [5, 4, 3]);
      }
      assert.deepEqual(got, deriveTestAccounts(seed, countRaw));
    }
  });
});
