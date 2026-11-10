// Pure gesture mechanics engine for live agent testing (FORGE TQ-026).
// The platform capability engine owns which gesture verbs exist on which
// platform; this engine owns the physics of each gesture: how many fingers
// touch the screen, which direction a swipe sweeps, how hard a stylus
// presses and how long a press is held. A gesture the platform cannot
// physically express, or a parameter the gesture does not accept, is
// refused by name, never guessed.

export type Platform = 'web' | 'android' | 'ios' | 'desktop';

const PLATFORMS: Platform[] = ['web', 'android', 'ios', 'desktop'];

const DIRECTIONS = ['up', 'down', 'left', 'right'];

export interface GestureSpec {
  gesture: string;
  name: string;
  platforms: Platform[];
  minContacts: number;
  maxContacts: number;
  requiresDirection: boolean;
  requiresPressure: boolean;
  allowsDuration: boolean;
}

export const GESTURE_MECHANICS: GestureSpec[] = [
  {
    gesture: 'tap',
    name: 'Tap',
    platforms: ['android', 'ios'],
    minContacts: 1,
    maxContacts: 1,
    requiresDirection: false,
    requiresPressure: false,
    allowsDuration: false,
  },
  {
    gesture: 'swipe',
    name: 'Swipe',
    platforms: ['android', 'ios'],
    minContacts: 1,
    maxContacts: 1,
    requiresDirection: true,
    requiresPressure: false,
    allowsDuration: false,
  },
  {
    gesture: 'long-press',
    name: 'Long press',
    platforms: ['android', 'ios'],
    minContacts: 1,
    maxContacts: 1,
    requiresDirection: false,
    requiresPressure: false,
    allowsDuration: true,
  },
  {
    gesture: 'pinch',
    name: 'Pinch',
    platforms: ['android', 'ios'],
    minContacts: 2,
    maxContacts: 2,
    requiresDirection: false,
    requiresPressure: false,
    allowsDuration: false,
  },
  {
    gesture: 'rotate',
    name: 'Rotate',
    platforms: ['android', 'ios'],
    minContacts: 2,
    maxContacts: 2,
    requiresDirection: false,
    requiresPressure: false,
    allowsDuration: false,
  },
  {
    gesture: 'multi-touch',
    name: 'Multi touch',
    platforms: ['android', 'ios'],
    minContacts: 2,
    maxContacts: 5,
    requiresDirection: false,
    requiresPressure: false,
    allowsDuration: false,
  },
  {
    gesture: 'stylus-pressure',
    name: 'Stylus pressure',
    platforms: ['ios'],
    minContacts: 1,
    maxContacts: 1,
    requiresDirection: false,
    requiresPressure: true,
    allowsDuration: false,
  },
];

export interface GestureVerdict {
  ok: boolean;
  reason?: string;
  gesture?: string;
  platform?: string;
  contacts?: number;
  direction?: string | null;
  pressure?: number | null;
  durationMs?: number | null;
  text?: string;
}

export interface GestureIntent {
  platform?: unknown;
  gesture?: unknown;
  contacts?: unknown;
  pressure?: unknown;
  direction?: unknown;
  durationMs?: unknown;
}

function norm(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function gestureCatalog(platform?: unknown): GestureSpec[] {
  const p = norm(platform);
  if (p.length === 0) {
    return GESTURE_MECHANICS;
  }
  if (!PLATFORMS.includes(p as Platform)) {
    return [];
  }
  return GESTURE_MECHANICS.filter((x) => x.platforms.includes(p as Platform));
}

export function checkGesture(input: GestureIntent): GestureVerdict {
  const p = norm(input?.platform);
  if (p.length === 0) {
    return { ok: false, reason: 'gesture-platform-missing' };
  }
  if (!PLATFORMS.includes(p as Platform)) {
    return { ok: false, reason: 'gesture-platform-unknown:' + p };
  }
  const g = norm(input?.gesture);
  if (g.length === 0) {
    return { ok: false, reason: 'gesture-missing' };
  }
  const spec = GESTURE_MECHANICS.find((x) => x.gesture === g);
  if (!spec) {
    return { ok: false, reason: 'gesture-unknown:' + g };
  }
  if (!spec.platforms.includes(p as Platform)) {
    return { ok: false, reason: 'gesture-platform-unsupported:' + g + ':' + p };
  }
  let contacts = spec.minContacts;
  if (input?.contacts !== undefined && input?.contacts !== null) {
    const c = Number(input.contacts);
    if (!Number.isInteger(c) || c < spec.minContacts || c > spec.maxContacts) {
      return { ok: false, reason: 'gesture-contacts-invalid:' + String(input.contacts) };
    }
    contacts = c;
  }
  let direction: string | null = null;
  if (spec.requiresDirection) {
    const d = norm(input?.direction);
    if (d.length === 0) {
      return { ok: false, reason: 'gesture-direction-missing' };
    }
    if (!DIRECTIONS.includes(d)) {
      return { ok: false, reason: 'gesture-direction-invalid:' + d };
    }
    direction = d;
  } else if (norm(input?.direction).length > 0) {
    return { ok: false, reason: 'gesture-direction-unexpected' };
  }
  let pressure: number | null = null;
  if (spec.requiresPressure) {
    if (input?.pressure === undefined || input?.pressure === null) {
      return { ok: false, reason: 'gesture-pressure-missing' };
    }
    const pr = Number(input.pressure);
    if (!Number.isFinite(pr) || pr <= 0 || pr > 1) {
      return { ok: false, reason: 'gesture-pressure-invalid:' + String(input.pressure) };
    }
    pressure = pr;
  } else if (input?.pressure !== undefined && input?.pressure !== null) {
    return { ok: false, reason: 'gesture-pressure-unexpected' };
  }
  let durationMs: number | null = null;
  if (spec.allowsDuration) {
    if (input?.durationMs !== undefined && input?.durationMs !== null) {
      const d = Number(input.durationMs);
      if (!Number.isInteger(d) || d < 100 || d > 10000) {
        return { ok: false, reason: 'gesture-duration-invalid:' + String(input.durationMs) };
      }
      durationMs = d;
    } else {
      durationMs = 500;
    }
  } else if (input?.durationMs !== undefined && input?.durationMs !== null) {
    return { ok: false, reason: 'gesture-duration-unexpected' };
  }
  const fingers = contacts === 1 ? ' finger' : ' fingers';
  const text =
    g === 'tap'
      ? 'Tapping with 1 finger'
      : g === 'swipe'
        ? 'Swiping ' + direction + ' with 1 finger'
        : g === 'long-press'
          ? 'Long pressing for ' + durationMs + 'ms'
          : g === 'pinch'
            ? 'Pinching with 2 fingers'
            : g === 'rotate'
              ? 'Rotating with 2 fingers'
              : g === 'multi-touch'
                ? 'Touching with ' + contacts + fingers
                : 'Drawing with stylus at ' + pressure + ' pressure';
  return { ok: true, gesture: g, platform: p, contacts, direction, pressure, durationMs, text };
}
