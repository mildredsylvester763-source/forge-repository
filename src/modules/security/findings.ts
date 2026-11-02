import { createHash } from 'node:crypto';

export type Severity = 'low' | 'medium' | 'high';
export const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

export type FindingCheck = 'secret' | 'dependency' | 'package';

/** One problem the safety kit found. `detail` never contains a full secret, only a short redacted hint. */
export interface Finding {
  check: FindingCheck;
  ruleId: string;
  severity: Severity;
  message: string;
  file: string;
  line: number;
  detail?: string;
  /** Set when the problem was found in an older commit rather than in the current files. */
  commit?: string;
  /** A stable hash that identifies this finding without containing the secret. Used by the baseline. */
  fingerprint: string;
  fix: string;
}

export const atLeast = (severity: Severity, threshold: Severity): boolean => SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];

/** Hash of the parts that make a finding what it is. Never reversible to a high-entropy secret in practice, and never printed. */
export const fingerprintOf = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
