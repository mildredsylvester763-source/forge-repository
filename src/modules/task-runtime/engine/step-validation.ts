// Step validation engine (FORGE AI-079). Pure: no imports at all. Every
// refusal is named; evaluation failures are reported as verdict details,
// not thrown, so a step that fails validation is a result, not an error.
// Checks evaluate in order; a malformed check aborts with a named
// refusal before any verdict is produced.

export const STEP_CHECK_TYPES: readonly string[] = ['exit-code', 'field', 'max-length', 'contains', 'equals'];
export const STEP_CHECKS_LIMIT = 50;
export const STEP_ID_LIMIT = 100;

export interface StepCheckInput {
  type?: unknown;
  path?: unknown;
  limit?: unknown;
  text?: unknown;
  value?: unknown;
}

export interface StepValidationInput {
  stepId?: unknown;
  checks?: unknown;
  output?: unknown;
}

export interface StepFailure {
  index: number;
  check: string;
  detail: string;
}

export interface StepValidationResult {
  ok: boolean;
  reason?: string;
  stepId: string;
  passed: number;
  failed: number;
  failures: StepFailure[];
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refusal(reason: string, stepId: string): StepValidationResult {
  return { ok: false, reason, stepId, passed: 0, failed: 0, failures: [] };
}

export function validateStep(input: StepValidationInput): StepValidationResult {
  const stepId = typeof input?.stepId === 'string' ? input.stepId.trim() : '';
  if (stepId.length === 0) return refusal('stepv-step-id-missing', '');
  if (stepId.length > STEP_ID_LIMIT) return refusal('stepv-step-id-too-long', stepId);
  if (!Array.isArray(input?.checks)) return refusal('stepv-checks-missing', stepId);
  const checks = input.checks as unknown[];
  if (checks.length === 0) return refusal('stepv-checks-empty', stepId);
  if (checks.length > STEP_CHECKS_LIMIT) return refusal('stepv-checks-limit:' + checks.length, stepId);
  const output: unknown = input?.output;
  const failures: StepFailure[] = [];
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i];
    if (!isPlainObject(check)) return refusal('stepv-check-missing:' + (i + 1), stepId);
    const type = typeof check.type === 'string' ? check.type.trim().toLowerCase() : '';
    if (type.length === 0) return refusal('stepv-check-type-missing:' + (i + 1), stepId);
    if (!STEP_CHECK_TYPES.includes(type)) return refusal('stepv-check-type-unknown:' + type, stepId);
    if (type === 'exit-code') {
      if (!isPlainObject(output) || output.exitCode === undefined) {
        failures.push({ index: i + 1, check: type, detail: 'exit-missing' });
      } else if (output.exitCode !== 0) {
        failures.push({ index: i + 1, check: type, detail: 'exit:' + String(output.exitCode) });
      }
      continue;
    }
    if (type === 'field') {
      const path = typeof check.path === 'string' ? check.path.trim() : '';
      if (path.length === 0) return refusal('stepv-path-missing:' + (i + 1), stepId);
      if (!isPlainObject(output) || output[path] === undefined) {
        failures.push({ index: i + 1, check: type, detail: 'field-missing:' + path });
      } else if (output[path] === null || output[path] === '') {
        failures.push({ index: i + 1, check: type, detail: 'field-empty:' + path });
      }
      continue;
    }
    if (type === 'max-length') {
      const path = typeof check.path === 'string' ? check.path.trim() : '';
      if (path.length === 0) return refusal('stepv-path-missing:' + (i + 1), stepId);
      const limitRaw: unknown = check.limit;
      if (limitRaw === undefined) return refusal('stepv-limit-missing:' + (i + 1), stepId);
      if (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw < 0) {
        return refusal('stepv-limit-invalid:' + (i + 1), stepId);
      }
      if (!isPlainObject(output) || output[path] === undefined) {
        failures.push({ index: i + 1, check: type, detail: 'max-length-missing:' + path });
      } else if (typeof output[path] !== 'string') {
        failures.push({ index: i + 1, check: type, detail: 'max-length-type:' + path });
      } else if ((output[path] as string).length > limitRaw) {
        failures.push({ index: i + 1, check: type, detail: 'max-length:' + path + ':' + (output[path] as string).length + '>' + limitRaw });
      }
      continue;
    }
    if (type === 'contains') {
      const text = typeof check.text === 'string' ? check.text.trim() : '';
      if (text.length === 0) return refusal('stepv-text-missing:' + (i + 1), stepId);
      if (output === undefined) {
        failures.push({ index: i + 1, check: type, detail: 'contains-missing' });
      } else {
        const subject = typeof output === 'string' ? output : stableStringify(output);
        if (!subject.includes(text)) failures.push({ index: i + 1, check: type, detail: 'contains:' + text });
      }
      continue;
    }
    if (check.value === undefined) return refusal('stepv-value-missing:' + (i + 1), stepId);
    if (output === undefined) {
      failures.push({ index: i + 1, check: type, detail: 'equals-missing' });
    } else if (stableStringify(output) !== stableStringify(check.value)) {
      failures.push({ index: i + 1, check: type, detail: 'equals-mismatch' });
    }
  }
  const failed = failures.length;
  return { ok: failed === 0, stepId, passed: checks.length - failed, failed, failures };
}
