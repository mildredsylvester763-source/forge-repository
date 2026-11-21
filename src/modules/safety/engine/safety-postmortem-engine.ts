export type SafetyFailureKind = 'missed_harm' | 'wrongful_block';

export interface SafetyPostmortemFix {
  readonly fixId: string;
  readonly description: string;
  readonly ownerUserId: string;
  readonly dueAt: number;
}

export interface SafetyPostmortemDraft {
  readonly postmortemId: string;
  readonly incidentId: string;
  readonly failureKind: SafetyFailureKind;
  readonly occurredAt: number;
  readonly summary: string;
  readonly impact: string;
  readonly timeline: readonly string[];
  readonly contributingFactors: readonly string[];
  readonly fixes: readonly SafetyPostmortemFix[];
  readonly blameless: true;
}

export type SafetyPostmortemResult =
  | { readonly ok: true; readonly value: SafetyPostmortemDraft }
  | { readonly ok: false; readonly reason: 'postmortem_invalid' };

const POSTMORTEM_KEYS = ['postmortemId', 'incidentId', 'failureKind', 'occurredAt', 'summary', 'impact', 'timeline', 'contributingFactors', 'fixes', 'blameless'];
const FIX_KEYS = ['fixId', 'description', 'ownerUserId', 'dueAt'];

/** Validates a blameless learning record; it does not infer fault, severity, or legal status. */
export function validateSafetyPostmortem(input: unknown): SafetyPostmortemResult {
  if (!isPlainRecord(input) || Object.keys(input).some((key) => !POSTMORTEM_KEYS.includes(key)) ||
      !isId(input.postmortemId) || !isId(input.incidentId) || (input.failureKind !== 'missed_harm' && input.failureKind !== 'wrongful_block') ||
      !isTimestamp(input.occurredAt) || !isText(input.summary, 4000) || !isText(input.impact, 4000) ||
      !isTextList(input.timeline, 1, 100) || !isTextList(input.contributingFactors, 1, 100) || !Array.isArray(input.fixes) ||
      input.fixes.length < 1 || input.fixes.length > 100 || input.blameless !== true) {
    return { ok: false, reason: 'postmortem_invalid' };
  }
  const fixIds = new Set<string>();
  const fixes: SafetyPostmortemFix[] = [];
  for (const fix of input.fixes) {
    if (!isPlainRecord(fix) || Object.keys(fix).some((key) => !FIX_KEYS.includes(key)) || !isId(fix.fixId) || fixIds.has(fix.fixId) ||
        !isText(fix.description, 2000) || !isId(fix.ownerUserId) || !isTimestamp(fix.dueAt)) {
      return { ok: false, reason: 'postmortem_invalid' };
    }
    fixIds.add(fix.fixId);
    fixes.push(Object.freeze({ fixId: fix.fixId, description: fix.description, ownerUserId: fix.ownerUserId, dueAt: fix.dueAt }));
  }
  return { ok: true, value: Object.freeze({
    postmortemId: input.postmortemId,
    incidentId: input.incidentId,
    failureKind: input.failureKind,
    occurredAt: input.occurredAt,
    summary: input.summary,
    impact: input.impact,
    timeline: Object.freeze([...input.timeline]),
    contributingFactors: Object.freeze([...input.contributingFactors]),
    fixes: Object.freeze(fixes),
    blameless: true,
  }) };
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function isTextList(value: unknown, min: number, max: number): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= max && value.every((item) => isText(item, 2000));
}
function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
