// Pure interruption scenario engine for live agent testing (FORGE TQ-022).
// Real apps get interrupted: calls, SMS banners, push notifications, low
// battery dialogs, network drops, backgrounding and system update prompts.
// Each scenario carries the platforms it applies to, whether the app is
// expected to resume immediately or needs manual attention, whether
// unsaved state is at risk and the expectation the app must meet. Every
// refusal is named.

import { isPlatform } from './platform-capability.ts';

export interface InterruptionSpec {
  scenario: string;
  name: string;
  platforms: string[];
  resume: 'immediate' | 'manual';
  dataLossRisk: boolean;
  expectation: string;
}

export const INTERRUPTIONS: InterruptionSpec[] = [
  {
    scenario: 'incoming-call',
    name: 'Incoming call',
    platforms: ['android', 'ios'],
    resume: 'manual',
    dataLossRisk: true,
    expectation: 'The app pauses mid-flow and restores full state when the call ends',
  },
  {
    scenario: 'incoming-sms',
    name: 'Incoming SMS',
    platforms: ['android', 'ios'],
    resume: 'immediate',
    dataLossRisk: false,
    expectation: 'A notification banner appears while the flow continues underneath',
  },
  {
    scenario: 'push-notification',
    name: 'Push notification',
    platforms: ['web', 'android', 'ios', 'desktop'],
    resume: 'immediate',
    dataLossRisk: false,
    expectation: 'The notification renders without disrupting the active flow',
  },
  {
    scenario: 'low-battery',
    name: 'Low battery warning',
    platforms: ['android', 'ios', 'desktop'],
    resume: 'immediate',
    dataLossRisk: true,
    expectation: 'A low battery dialog appears and unsaved state survives it',
  },
  {
    scenario: 'network-drop',
    name: 'Network drop',
    platforms: ['web', 'android', 'ios', 'desktop'],
    resume: 'manual',
    dataLossRisk: true,
    expectation: 'The app surfaces its offline state and preserves queued work',
  },
  {
    scenario: 'app-background',
    name: 'App backgrounded',
    platforms: ['android', 'ios'],
    resume: 'manual',
    dataLossRisk: true,
    expectation: 'The app backgrounds mid-flow and restores its exact state on foreground',
  },
  {
    scenario: 'system-update',
    name: 'System update prompt',
    platforms: ['android', 'ios', 'desktop'],
    resume: 'immediate',
    dataLossRisk: false,
    expectation: 'An update prompt appears and the flow continues after dismissal',
  },
];

export interface InterruptionVerdict {
  ok: boolean;
  reason?: string;
  scenario?: string;
  name?: string;
  resume?: string;
  dataLossRisk?: boolean;
  expectation?: string;
}

export function interruptionCatalog(platform?: unknown): InterruptionSpec[] {
  if (typeof platform !== 'string' || platform.trim().length === 0) {
    return INTERRUPTIONS.slice();
  }
  const p = platform.trim().toLowerCase();
  return INTERRUPTIONS.filter((s) => s.platforms.includes(p));
}

export function checkInterruption(input: {
  platform?: unknown;
  scenario?: unknown;
  status?: unknown;
}): InterruptionVerdict {
  const platform = typeof input?.platform === 'string' ? input.platform.trim().toLowerCase() : '';
  if (platform.length === 0) {
    return { ok: false, reason: 'interruption-platform-missing' };
  }
  if (!isPlatform(platform)) {
    return { ok: false, reason: 'interruption-platform-unknown:' + platform };
  }
  const scenario = typeof input?.scenario === 'string' ? input.scenario.trim().toLowerCase() : '';
  if (scenario.length === 0) {
    return { ok: false, reason: 'interruption-scenario-missing' };
  }
  const spec = INTERRUPTIONS.find((s) => s.scenario === scenario);
  if (!spec) {
    return { ok: false, reason: 'interruption-unknown:' + scenario };
  }
  if (!spec.platforms.includes(platform)) {
    return { ok: false, reason: 'interruption-platform-unsupported:' + scenario + ':' + platform };
  }
  const status = typeof input?.status === 'string' ? input.status.trim().toLowerCase() : '';
  if (status.length === 0) {
    return { ok: false, reason: 'interruption-status-missing' };
  }
  if (status !== 'running') {
    return { ok: false, reason: 'interruption-session-not-running:' + status };
  }
  return {
    ok: true,
    scenario: spec.scenario,
    name: spec.name,
    resume: spec.resume,
    dataLossRisk: spec.dataLossRisk,
    expectation: spec.expectation,
  };
}
