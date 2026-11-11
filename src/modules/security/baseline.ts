import { existsSync, readFileSync } from 'node:fs';
import type { Finding } from './findings.ts';

/**
 * A baseline lists findings the owner has looked at and accepted (for example, old test data), so the gate can
 * stay strict about anything new. It stores hashes and a reason, never a secret.
 */
export interface BaselineEntry {
  fingerprint: string;
  ruleId: string;
  file: string;
  note: string;
}

export interface Baseline {
  version: 1;
  accepted: BaselineEntry[];
}

export class BaselineError extends Error {
  constructor(message: string) {
    super(`Invalid baseline file: ${message}`);
    this.name = 'BaselineError';
  }
}

export function parseBaseline(raw: unknown): Baseline {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BaselineError('it must be a JSON object');
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) throw new BaselineError('"version" must be 1');
  if (!Array.isArray(o.accepted)) throw new BaselineError('"accepted" must be a list');
  const accepted = o.accepted.map((e, i) => {
    const entry = e as Record<string, unknown>;
    if (
      typeof e !== 'object' || e === null ||
      typeof entry.fingerprint !== 'string' || !/^[0-9a-f]{32}$/.test(entry.fingerprint) ||
      typeof entry.ruleId !== 'string' || typeof entry.file !== 'string' ||
      typeof entry.note !== 'string' || entry.note.trim().length < 5
    ) {
      throw new BaselineError(`entry ${i + 1} needs a 32-character fingerprint, a rule, a file, and a written reason`);
    }
    return { fingerprint: entry.fingerprint, ruleId: entry.ruleId, file: entry.file, note: entry.note };
  });
  return { version: 1, accepted };
}

export function loadBaseline(path: string): Baseline | null {
  if (!existsSync(path)) return null;
  try {
    return parseBaseline(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    if (err instanceof BaselineError) throw err;
    throw new BaselineError('the file is not valid JSON');
  }
}

export function applyBaseline(findings: Finding[], baseline: Baseline | null): { remaining: Finding[]; suppressed: Finding[] } {
  if (!baseline) return { remaining: findings, suppressed: [] };
  const accepted = new Set(baseline.accepted.map((e) => e.fingerprint));
  return { remaining: findings.filter((f) => !accepted.has(f.fingerprint)), suppressed: findings.filter((f) => accepted.has(f.fingerprint)) };
}

/** Builds a baseline from current findings. A written reason is required, so nothing is accepted silently. */
export function makeBaseline(findings: Finding[], note: string): Baseline {
  if (note.trim().length < 5) throw new BaselineError('a written reason of at least 5 characters is required');
  return { version: 1, accepted: findings.map((f) => ({ fingerprint: f.fingerprint, ruleId: f.ruleId, file: f.file, note: note.trim() })) };
}
