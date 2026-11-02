import { existsSync, readFileSync } from 'node:fs';
import type { Severity } from './findings.ts';

/** SC-044: the safety rules live in one reviewable file (forge-security.json) instead of in someone's head. */
export interface SecurityPolicy {
  version: 1;
  secrets: {
    /** Path prefixes (relative to the repo root, forward slashes) that are not scanned. */
    ignorePaths: string[];
    /** Findings at or above this severity block the gate. */
    failOn: Severity;
    /** Your own patterns, for credentials specific to your systems. */
    customRules: Array<{ id: string; description: string; pattern: string; severity: Severity }>;
  };
  dependencies: {
    requireLockfile: boolean;
    /** A package may only be downloaded from a registry whose address starts with one of these. */
    allowedRegistries: string[];
    failOn: Severity;
    /** Packages the owner has reviewed: silences the install-script, quarantine and look-alike checks for them. */
    approved: string[];
    /** Packages that must never be used. */
    deny: string[];
    /** Packages that need a human look before use (flagged until moved to `approved`). */
    quarantine: string[];
    deniedLicenses: string[];
  };
}

export const DEFAULT_POLICY: SecurityPolicy = {
  version: 1,
  secrets: { ignorePaths: [], failOn: 'medium', customRules: [] },
  dependencies: {
    requireLockfile: true,
    allowedRegistries: ['https://registry.npmjs.org/'],
    failOn: 'high',
    approved: [],
    deny: [],
    quarantine: [],
    deniedLicenses: ['AGPL-3.0', 'GPL-3.0', 'SSPL-1.0'],
  },
};

export class PolicyError extends Error {
  constructor(message: string) {
    super(`Invalid forge-security.json: ${message}`);
    this.name = 'PolicyError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new PolicyError(`unknown setting "${where}${key}"`);
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0 || v.length > 200)) {
    throw new PolicyError(`"${where}" must be a list of short text values`);
  }
  return [...(value as string[])];
}

const RESERVED_RULE_IDS = new Set([
  'private-key', 'aws-access-key', 'github-token', 'slack-token', 'google-api-key', 'stripe-key', 'anthropic-key', 'openai-key',
  'forge-token', 'database-url-password', 'json-web-token', 'secret-assignment', 'secret-env-line',
]);

function customRules(value: unknown): SecurityPolicy['secrets']['customRules'] {
  if (!Array.isArray(value) || value.length > 50) throw new PolicyError('"secrets.customRules" must be a list of at most 50 rules');
  const seen = new Set<string>();
  return value.map((raw, i) => {
    const where = `secrets.customRules[${i}]`;
    if (!isObject(raw)) throw new PolicyError(`"${where}" must be an object`);
    onlyKeys(raw, ['id', 'description', 'pattern', 'severity'], `${where}.`);
    const { id, description, pattern } = raw;
    if (typeof id !== 'string' || !/^[a-z0-9-]{3,40}$/.test(id) || RESERVED_RULE_IDS.has(id) || seen.has(id)) {
      throw new PolicyError(`"${where}.id" must be 3 to 40 lowercase letters, digits or dashes, unique, and not a built-in rule name`);
    }
    seen.add(id);
    if (typeof description !== 'string' || description.length < 3 || description.length > 120) throw new PolicyError(`"${where}.description" must be 3 to 120 characters`);
    if (typeof pattern !== 'string' || pattern.length < 4 || pattern.length > 300) throw new PolicyError(`"${where}.pattern" must be 4 to 300 characters`);
    let compiled: RegExp;
    try {
      compiled = new RegExp(pattern);
    } catch {
      throw new PolicyError(`"${where}.pattern" is not a valid pattern`);
    }
    if (compiled.test('')) throw new PolicyError(`"${where}.pattern" must not match empty text`);
    return { id, description, pattern, severity: severity(raw.severity, `${where}.severity`) };
  });
}

function severity(value: unknown, where: string): Severity {
  if (value !== 'low' && value !== 'medium' && value !== 'high') throw new PolicyError(`"${where}" must be low, medium or high`);
  return value;
}

/** Strict: an unknown or mistyped setting is an error, never silently ignored. Missing settings take the safe defaults. */
export function parsePolicy(raw: unknown): SecurityPolicy {
  if (!isObject(raw)) throw new PolicyError('the file must contain a JSON object');
  onlyKeys(raw, ['version', 'secrets', 'dependencies'], '');
  if (raw.version !== undefined && raw.version !== 1) throw new PolicyError('"version" must be 1');
  const policy: SecurityPolicy = structuredClone(DEFAULT_POLICY);

  if (raw.secrets !== undefined) {
    if (!isObject(raw.secrets)) throw new PolicyError('"secrets" must be an object');
    onlyKeys(raw.secrets, ['ignorePaths', 'failOn', 'customRules'], 'secrets.');
    if (raw.secrets.customRules !== undefined) policy.secrets.customRules = customRules(raw.secrets.customRules);
    if (raw.secrets.ignorePaths !== undefined) policy.secrets.ignorePaths = strings(raw.secrets.ignorePaths, 'secrets.ignorePaths');
    if (raw.secrets.failOn !== undefined) policy.secrets.failOn = severity(raw.secrets.failOn, 'secrets.failOn');
  }
  if (raw.dependencies !== undefined) {
    const d = raw.dependencies;
    if (!isObject(d)) throw new PolicyError('"dependencies" must be an object');
    onlyKeys(d, ['requireLockfile', 'allowedRegistries', 'failOn', 'approved', 'deny', 'quarantine', 'deniedLicenses'], 'dependencies.');
    if (d.requireLockfile !== undefined) {
      if (typeof d.requireLockfile !== 'boolean') throw new PolicyError('"dependencies.requireLockfile" must be true or false');
      policy.dependencies.requireLockfile = d.requireLockfile;
    }
    if (d.failOn !== undefined) policy.dependencies.failOn = severity(d.failOn, 'dependencies.failOn');
    for (const key of ['allowedRegistries', 'approved', 'deny', 'quarantine', 'deniedLicenses'] as const) {
      if (d[key] !== undefined) policy.dependencies[key] = strings(d[key], `dependencies.${key}`);
    }
    if (!policy.dependencies.allowedRegistries.every((r) => r.startsWith('https://'))) {
      throw new PolicyError('"dependencies.allowedRegistries" entries must start with https://');
    }
  }
  return policy;
}

export function loadPolicy(path: string): SecurityPolicy {
  if (!existsSync(path)) return structuredClone(DEFAULT_POLICY);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new PolicyError('the file is not valid JSON');
  }
  return parsePolicy(raw);
}
