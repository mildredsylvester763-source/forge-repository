// Pure cross-device handoff engine for live agent testing (FORGE TQ-025).
// A live session moves between named devices out of the shared device
// catalog: the tester hands an acting session from the phone to the
// laptop, or stages the first device before the flow starts. Changing
// platform forces a manual resume because the persona re-orients; staying
// on the same platform resumes automatically. Goal tasks always carry
// over. Every refusal is named.

import { DEVICES } from './device-profile.ts';

export interface HandoffInfo {
  fromDevice: string | null;
  toDevice: string;
  toPlatform: string;
  initial: boolean;
  platformChanged: boolean;
  resume: 'automatic' | 'manual';
  goalPreserved: boolean;
}

export interface HandoffVerdict {
  ok: boolean;
  reason?: string;
  handoff?: HandoffInfo;
}

export function checkHandoff(input: {
  status?: unknown;
  fromDevice?: unknown;
  toDevice?: unknown;
  platform?: unknown;
}): HandoffVerdict {
  const status = typeof input?.status === 'string' ? input.status.trim().toLowerCase() : '';
  if (status.length === 0) {
    return { ok: false, reason: 'handoff-status-missing' };
  }
  if (status !== 'running' && status !== 'paused') {
    return { ok: false, reason: 'handoff-state-invalid:' + status };
  }
  const toName = typeof input?.toDevice === 'string' ? input.toDevice.trim().toLowerCase() : '';
  if (toName.length === 0) {
    return { ok: false, reason: 'handoff-to-missing' };
  }
  const to = DEVICES.find((d) => d.device === toName);
  if (!to) {
    return { ok: false, reason: 'handoff-device-unknown:' + toName };
  }
  const hasFrom = typeof input?.fromDevice === 'string' && input.fromDevice.trim().length > 0;
  let from: { device: string; platform: string } | null = null;
  if (hasFrom) {
    const fromName = (input.fromDevice as string).trim().toLowerCase();
    const found = DEVICES.find((d) => d.device === fromName);
    if (!found) {
      return { ok: false, reason: 'handoff-device-unknown:' + fromName };
    }
    if (found.device === to.device) {
      return { ok: false, reason: 'handoff-same-device' };
    }
    from = { device: found.device, platform: found.platform };
  }
  const platform = typeof input?.platform === 'string' ? input.platform.trim().toLowerCase() : '';
  if (!hasFrom && platform.length === 0) {
    return { ok: false, reason: 'handoff-platform-missing' };
  }
  const platformChanged = hasFrom
    ? from !== null && from.platform !== to.platform
    : platform !== to.platform;
  return {
    ok: true,
    handoff: {
      fromDevice: hasFrom && from ? from.device : null,
      toDevice: to.device,
      toPlatform: to.platform,
      initial: !hasFrom,
      platformChanged,
      resume: !hasFrom ? 'automatic' : platformChanged ? 'manual' : 'automatic',
      goalPreserved: true,
    },
  };
}
