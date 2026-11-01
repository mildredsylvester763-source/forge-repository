// Pure audio and video output engine for live agent testing (FORGE
// TQ-028). A media check answers two questions: does the platform decode
// the codec, and are audio and video in sync. Sync bands follow ITU-R
// BT.1359-1: a positive drift means audio leads video, drift is
// detectable past 45ms of lead or 125ms of lag, and unacceptable past
// 90ms of lead or 185ms of lag. The media player state machine is exact:
// an illegal transition or an unknown codec is refused by name.

export type Platform = 'web' | 'android' | 'ios' | 'desktop';
export type MediaKind = 'audio' | 'video';

const PLATFORMS: Platform[] = ['web', 'android', 'ios', 'desktop'];
const MEDIA_KINDS: MediaKind[] = ['audio', 'video'];

const VIDEO_CODECS: Record<Platform, string[]> = {
  web: ['h264', 'vp9', 'av1'],
  android: ['h264', 'hevc'],
  ios: ['h264', 'hevc'],
  desktop: ['h264', 'vp9', 'av1', 'hevc'],
};

const AUDIO_CODECS: Record<Platform, string[]> = {
  web: ['aac', 'opus', 'mp3'],
  android: ['aac', 'opus', 'amr'],
  ios: ['aac', 'opus'],
  desktop: ['aac', 'opus', 'mp3', 'flac'],
};

const ALL_VIDEO = ['h264', 'vp9', 'av1', 'hevc'];
const ALL_AUDIO = ['aac', 'opus', 'mp3', 'amr', 'flac'];

const MEDIA_STATES = ['idle', 'playing', 'paused', 'ended'];

const LEGAL_MEDIA_TRANSITIONS: Record<string, string[]> = {
  idle: ['playing'],
  playing: ['paused', 'ended'],
  paused: ['playing'],
  ended: [],
};

export interface PlaybackVerdict {
  ok: boolean;
  reason?: string;
  platform?: string;
  kind?: string;
  codec?: string;
  plays?: boolean;
  text?: string;
}

export interface PlaybackIntent {
  platform?: unknown;
  kind?: unknown;
  codec?: unknown;
}

export interface SyncVerdict {
  ok: boolean;
  reason?: string;
  driftMs?: number;
  sync?: string;
  detectable?: boolean;
  acceptable?: boolean;
  text?: string;
}

export interface MediaStateVerdict {
  ok: boolean;
  reason?: string;
  from?: string;
  to?: string;
  text?: string;
}

export interface AvCatalog {
  platform: string | null;
  video: string[];
  audio: string[];
}

function norm(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function avCatalog(platform?: unknown): AvCatalog {
  const p = norm(platform);
  if (p.length === 0) {
    return { platform: null, video: ALL_VIDEO, audio: ALL_AUDIO };
  }
  if (!PLATFORMS.includes(p as Platform)) {
    return { platform: null, video: [], audio: [] };
  }
  return {
    platform: p,
    video: VIDEO_CODECS[p as Platform],
    audio: AUDIO_CODECS[p as Platform],
  };
}

export function checkPlayback(input: PlaybackIntent): PlaybackVerdict {
  const p = norm(input?.platform);
  if (p.length === 0) {
    return { ok: false, reason: 'av-platform-missing' };
  }
  if (!PLATFORMS.includes(p as Platform)) {
    return { ok: false, reason: 'av-platform-unknown:' + p };
  }
  const k = norm(input?.kind);
  if (k.length === 0) {
    return { ok: false, reason: 'av-kind-missing' };
  }
  if (!MEDIA_KINDS.includes(k as MediaKind)) {
    return { ok: false, reason: 'av-kind-unknown:' + k };
  }
  const c = norm(input?.codec);
  if (c.length === 0) {
    return { ok: false, reason: 'av-codec-missing' };
  }
  const knownVideo = ALL_VIDEO.includes(c);
  const knownAudio = ALL_AUDIO.includes(c);
  if (!knownVideo && !knownAudio) {
    return { ok: false, reason: 'av-codec-unknown:' + c };
  }
  if (k === 'video' && !knownVideo) {
    return { ok: false, reason: 'av-codec-wrong-kind:' + c };
  }
  if (k === 'audio' && !knownAudio) {
    return { ok: false, reason: 'av-codec-wrong-kind:' + c };
  }
  const supported =
    k === 'video'
      ? VIDEO_CODECS[p as Platform].includes(c)
      : AUDIO_CODECS[p as Platform].includes(c);
  if (!supported) {
    return { ok: false, reason: 'av-codec-unsupported:' + c + ':' + p };
  }
  return {
    ok: true,
    platform: p,
    kind: k,
    codec: c,
    plays: true,
    text: 'Checking ' + c + ' ' + k + ' playback on ' + p,
  };
}

export function checkSync(driftMs: unknown): SyncVerdict {
  if (driftMs === undefined || driftMs === null) {
    return { ok: false, reason: 'av-drift-missing' };
  }
  const d = Number(driftMs);
  if (!Number.isFinite(d)) {
    return { ok: false, reason: 'av-drift-not-a-number:' + String(driftMs) };
  }
  let sync = 'in-sync';
  if (d > 45 || d < -125) {
    sync = 'drifting';
  }
  if (d > 90 || d < -185) {
    sync = 'out-of-sync';
  }
  return {
    ok: true,
    driftMs: d,
    sync,
    detectable: sync !== 'in-sync',
    acceptable: sync !== 'out-of-sync',
    text: 'Measuring audio and video drift of ' + d + 'ms',
  };
}

export function avStateTransition(from: unknown, to: unknown): MediaStateVerdict {
  const f = norm(from);
  if (f.length === 0) {
    return { ok: false, reason: 'av-state-missing' };
  }
  if (!MEDIA_STATES.includes(f)) {
    return { ok: false, reason: 'av-state-unknown:' + f };
  }
  const t = norm(to);
  if (t.length === 0) {
    return { ok: false, reason: 'av-state-missing' };
  }
  if (!MEDIA_STATES.includes(t)) {
    return { ok: false, reason: 'av-state-unknown:' + t };
  }
  if (!LEGAL_MEDIA_TRANSITIONS[f]!.includes(t)) {
    return { ok: false, reason: 'av-state-refused:' + f + ':' + t };
  }
  return { ok: true, from: f, to: t, text: 'Media moves from ' + f + ' to ' + t };
}
