/**
 * FORGE TQ-038 Snapshot and golden-file testing engine.
 *
 * Market laws (Jest snapshot, approval tests, golden files):
 * - A snapshot is a human-readable canonical serialization of a value,
 *   recorded once and verified on every later run.
 * - Three modes: write (record, refuses if one exists), verify (compare,
 *   reports checksums and the first differing line) and update (explicit
 *   re-record, refuses if none exists).
 * - Canonical form: keys sorted, two-space indent, one array element per
 *   line. The checksum is FNV-1a 32-bit over the serialized text.
 *
 * Pure engine: no framework imports, no I/O, fully deterministic.
 */

export const SNAPSHOT_MODES: readonly string[] = ['write', 'verify', 'update'];
export const SNAPSHOT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export interface ManageSnapshotInput {
  name?: unknown;
  mode?: unknown;
  value?: unknown;
  stored?: unknown;
}

export interface SnapshotManageResult {
  ok: boolean;
  reason?: string;
  name?: string;
  mode?: string;
  status?: string;
  checksum?: string;
  storedChecksum?: string;
  serialized?: string;
  lines?: number;
  firstDiffLine?: number;
}

function pad(indent: number): string {
  let out = '';
  for (let i = 0; i < indent * 2; i++) out += ' ';
  return out;
}

function serializeValue(value: unknown, indent: number): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string') return JSON.stringify(value);
  if (kind === 'number' || kind === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const parts: string[] = [];
    for (const item of value) parts.push(pad(indent + 1) + serializeValue(item, indent + 1));
    return '[\n' + parts.join(',\n') + '\n' + pad(indent) + ']';
  }
  if (kind === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    if (keys.length === 0) return '{}';
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(
        pad(indent + 1) + JSON.stringify(key) + ': ' + serializeValue((value as Record<string, unknown>)[key], indent + 1),
      );
    }
    return '{\n' + parts.join(',\n') + '\n' + pad(indent) + '}';
  }
  return 'undefined';
}

export function serializeSnapshot(value: unknown): string {
  return serializeValue(value, 0);
}

export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function manageSnapshot(input: ManageSnapshotInput): SnapshotManageResult {
  const name = typeof input?.name === 'string' ? input.name : '';
  if (name.length === 0) return { ok: false, reason: 'snapshot-name-missing' };
  if (!SNAPSHOT_NAME_RE.test(name)) return { ok: false, reason: 'snapshot-name-invalid:' + name };
  const mode = typeof input?.mode === 'string' ? input.mode : '';
  if (mode.length === 0) return { ok: false, reason: 'snapshot-mode-missing' };
  if (!SNAPSHOT_MODES.includes(mode)) return { ok: false, reason: 'snapshot-mode-unknown:' + mode };
  const value: unknown = input?.value;
  if (value === undefined) return { ok: false, reason: 'snapshot-value-missing' };
  const stored: unknown = input?.stored;
  const serialized = serializeSnapshot(value);
  const checksum = fnv1a(serialized);
  const lines = serialized.split('\n').length;
  if (mode === 'write') {
    if (stored !== undefined) return { ok: false, reason: 'snapshot-exists:' + name };
    return { ok: true, name, mode, status: 'written', checksum, serialized, lines };
  }
  if (mode === 'update') {
    if (stored === undefined) return { ok: false, reason: 'snapshot-missing:' + name };
    return { ok: true, name, mode, status: 'updated', checksum, serialized, lines };
  }
  if (stored === undefined) return { ok: false, reason: 'snapshot-missing:' + name };
  if (typeof stored !== 'string') return { ok: false, reason: 'snapshot-stored-invalid' };
  if (serialized === stored) return { ok: true, name, mode, status: 'match', checksum, lines };
  const storedLines = stored.split('\n');
  const newLines = serialized.split('\n');
  let firstDiff = -1;
  for (let i = 0; i < Math.max(storedLines.length, newLines.length); i++) {
    if (storedLines[i] !== newLines[i]) {
      firstDiff = i + 1;
      break;
    }
  }
  return {
    ok: false,
    reason: 'snapshot-mismatch:' + name,
    storedChecksum: fnv1a(stored),
    checksum,
    firstDiffLine: firstDiff,
  };
}
