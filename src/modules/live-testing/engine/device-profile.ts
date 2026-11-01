// Pure device catalog and network profile engine for live agent testing
// (FORGE TQ-020, TQ-021). Named devices per platform, low-end tiers with
// CPU throttling, and pinned network profiles with bandwidth and latency
// numbers, normalized into one profile verdict. Every refusal is named.

export interface DeviceSpec {
  device: string;
  platform: string;
  lowEnd: boolean;
  cpuThrottle: number;
}

export const DEVICES: DeviceSpec[] = [
  { device: 'desktop-chrome', platform: 'web', lowEnd: false, cpuThrottle: 1 },
  { device: 'desktop-firefox', platform: 'web', lowEnd: false, cpuThrottle: 1 },
  { device: 'desktop-safari', platform: 'web', lowEnd: false, cpuThrottle: 1 },
  { device: 'pixel-5', platform: 'android', lowEnd: false, cpuThrottle: 1 },
  { device: 'galaxy-s21', platform: 'android', lowEnd: false, cpuThrottle: 1 },
  { device: 'low-end-android', platform: 'android', lowEnd: true, cpuThrottle: 4 },
  { device: 'iphone-13', platform: 'ios', lowEnd: false, cpuThrottle: 1 },
  { device: 'ipad-9', platform: 'ios', lowEnd: false, cpuThrottle: 1 },
  { device: 'low-end-iphone', platform: 'ios', lowEnd: true, cpuThrottle: 4 },
  { device: 'windows-10', platform: 'desktop', lowEnd: false, cpuThrottle: 1 },
  { device: 'macos-monterey', platform: 'desktop', lowEnd: false, cpuThrottle: 1 },
  { device: 'linux-ubuntu', platform: 'desktop', lowEnd: false, cpuThrottle: 1 },
];

export interface NetworkSpec {
  network: string;
  offline: boolean;
  downlinkKbps: number;
  latencyMs: number;
}

export const NETWORKS: NetworkSpec[] = [
  { network: 'offline', offline: true, downlinkKbps: 0, latencyMs: 0 },
  { network: 'slow-2g', offline: false, downlinkKbps: 50, latencyMs: 2000 },
  { network: 'slow-3g', offline: false, downlinkKbps: 400, latencyMs: 2000 },
  { network: 'fast-3g', offline: false, downlinkKbps: 1500, latencyMs: 150 },
  { network: '4g', offline: false, downlinkKbps: 9000, latencyMs: 100 },
  { network: 'wifi', offline: false, downlinkKbps: 30000, latencyMs: 40 },
];

export interface ProfileVerdict {
  ok: boolean;
  reason?: string;
  profile?: {
    device: string;
    network: string;
    platform: string;
    lowEnd: boolean;
    cpuThrottle: number;
    offline: boolean;
    downlinkKbps: number;
    latencyMs: number;
  };
}

export function normalizeDeviceProfile(input: unknown): ProfileVerdict {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'deviceprofile-not-object' };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.device !== 'string' || obj.device.trim().length === 0) {
    return { ok: false, reason: 'device-missing' };
  }
  const deviceName = obj.device.trim().toLowerCase();
  const device = DEVICES.find((d) => d.device === deviceName);
  if (!device) {
    return { ok: false, reason: 'device-unknown:' + deviceName };
  }
  if (typeof obj.network !== 'string' || obj.network.trim().length === 0) {
    return { ok: false, reason: 'network-missing' };
  }
  const networkName = obj.network.trim().toLowerCase();
  const network = NETWORKS.find((n) => n.network === networkName);
  if (!network) {
    return { ok: false, reason: 'network-unknown:' + networkName };
  }
  return {
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

export function deviceCatalog(): DeviceSpec[] {
  return DEVICES.slice();
}

export function networkCatalog(): NetworkSpec[] {
  return NETWORKS.slice();
}
