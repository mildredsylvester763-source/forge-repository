// Pure platform capability engine for live agent testing (FORGE TQ-002
// through TQ-005, TQ-026). Each platform supports an exact action
// vocabulary: web drives a real browser, android and ios drive real device
// sessions, desktop drives windows, menus and file dialogs. A step the
// platform cannot perform is refused by name, never guessed. Device
// profiles (class, network, screen) are validated with the same
// discipline.

export type Platform = 'web' | 'android' | 'ios' | 'desktop';

export const PLATFORMS: Platform[] = ['web', 'android', 'ios', 'desktop'];

const ACTIONS: Record<Platform, string[]> = {
  web: ['click', 'type', 'scroll', 'drag', 'hover', 'key', 'upload', 'navigate', 'wait', 'assert'],
  android: ['tap', 'swipe', 'long-press', 'type', 'scroll', 'back', 'home', 'rotate', 'install', 'assert'],
  ios: ['tap', 'swipe', 'long-press', 'type', 'scroll', 'rotate', 'terminate', 'assert'],
  desktop: ['click', 'type', 'key', 'hover', 'drag', 'menu', 'window-resize', 'file-dialog', 'assert'],
};

// Gestures (FORGE TQ-026): pinch and multi-touch exist on touch platforms,
// stylus pressure only on ios tablets.
const GESTURES: Record<Platform, string[]> = {
  web: [],
  android: ['pinch', 'multi-touch'],
  ios: ['pinch', 'multi-touch', 'stylus-pressure'],
  desktop: [],
};

export type DeviceClass = 'low-end' | 'standard' | 'high-end';
export type NetworkProfile = '3g' | '4g' | 'wifi' | 'offline';

export interface DeviceProfile {
  platform: Platform;
  deviceClass: DeviceClass;
  network: NetworkProfile;
  screenWidth: number | null;
  screenHeight: number | null;
}

export interface ActionVerdict {
  ok: boolean;
  reason?: string;
}

export interface ProfileVerdict {
  ok: boolean;
  reason?: string;
  profile?: DeviceProfile;
}

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as string[]).includes(value);
}

export function listActions(platform: Platform): string[] {
  return ACTIONS[platform].concat(GESTURES[platform]);
}

export function allKnownActions(): string[] {
  const set = new Set<string>();
  for (const p of PLATFORMS) {
    for (const a of ACTIONS[p]) set.add(a);
  }
  for (const p of PLATFORMS) {
    for (const g of GESTURES[p]) set.add(g);
  }
  return Array.from(set).sort();
}

export function supportsAction(platform: Platform, action: string): boolean {
  return ACTIONS[platform].includes(action) || GESTURES[platform].includes(action);
}

export function checkAction(platform: unknown, action: unknown): ActionVerdict {
  if (!isPlatform(platform)) {
    return { ok: false, reason: 'platform-unknown:' + String(platform) };
  }
  if (typeof action !== 'string' || action.length === 0) {
    return { ok: false, reason: 'platform-action-missing' };
  }
  if (!allKnownActions().includes(action)) {
    return { ok: false, reason: 'platform-action-unknown:' + action };
  }
  if (!supportsAction(platform, action)) {
    return { ok: false, reason: 'platform-action-unsupported:' + action + ':' + platform };
  }
  return { ok: true };
}

export function validateDeviceProfile(input: unknown): ProfileVerdict {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, reason: 'device-profile-not-an-object' };
  }
  const raw = input as Record<string, unknown>;
  if (!isPlatform(raw.platform)) {
    return { ok: false, reason: 'device-profile-missing-platform' };
  }
  let deviceClass: DeviceClass = 'standard';
  if (raw.deviceClass !== undefined && raw.deviceClass !== null) {
    if (
      raw.deviceClass !== 'low-end' &&
      raw.deviceClass !== 'standard' &&
      raw.deviceClass !== 'high-end'
    ) {
      return { ok: false, reason: 'device-class-invalid:' + String(raw.deviceClass) };
    }
    deviceClass = raw.deviceClass as DeviceClass;
  }
  let network: NetworkProfile = 'wifi';
  if (raw.network !== undefined && raw.network !== null) {
    const n = raw.network;
    if (n !== '3g' && n !== '4g' && n !== 'wifi' && n !== 'offline') {
      return { ok: false, reason: 'device-network-invalid:' + String(n) };
    }
    network = n as NetworkProfile;
  }
  let screenWidth: number | null = null;
  if (raw.screenWidth !== undefined && raw.screenWidth !== null) {
    if (!Number.isInteger(raw.screenWidth) || (raw.screenWidth as number) <= 0) {
      return { ok: false, reason: 'device-screen-invalid-width:' + String(raw.screenWidth) };
    }
    screenWidth = raw.screenWidth as number;
  }
  let screenHeight: number | null = null;
  if (raw.screenHeight !== undefined && raw.screenHeight !== null) {
    if (!Number.isInteger(raw.screenHeight) || (raw.screenHeight as number) <= 0) {
      return { ok: false, reason: 'device-screen-invalid-height:' + String(raw.screenHeight) };
    }
    screenHeight = raw.screenHeight as number;
  }
  return {
    ok: true,
    profile: { platform: raw.platform, deviceClass, network, screenWidth, screenHeight },
  };
}
