export interface WrongfulBlockMeasurement {
  readonly releaseId: string;
  readonly measurementId: string;
  readonly wrongfulBlockCount: number;
  readonly denominatorCount: number;
  readonly denominatorDefinitionId: string;
  readonly measuredAt: number;
}

export type WrongfulBlockTaskDisposition = 'threshold_unconfigured' | 'within_limit' | 'limit_exceeded';

export interface WrongfulBlockReport {
  readonly releaseId: string;
  readonly measurementId: string;
  readonly wrongfulBlockCount: number;
  readonly denominatorCount: number;
  readonly denominatorDefinitionId: string;
  readonly measuredAt: number;
  readonly rate: number;
  readonly threshold: number | null;
  readonly taskDisposition: WrongfulBlockTaskDisposition;
  readonly reviewTaskId: string | null;
}

export type WrongfulBlockEngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'measurement_invalid' | 'threshold_invalid' };

/** Measures an already-adjudicated aggregate. It does not select the denominator definition or adjudicate raw content. */
export function evaluateWrongfulBlockRate(
  input: unknown,
  configuredThreshold: number | null,
): WrongfulBlockEngineResult<WrongfulBlockReport> {
  if (configuredThreshold !== null && (!Number.isFinite(configuredThreshold) || configuredThreshold < 0 || configuredThreshold > 1)) {
    return { ok: false, reason: 'threshold_invalid' };
  }
  if (!isPlainRecord(input) || !isText(input.releaseId) || input.releaseId.length > 128 || !isText(input.measurementId) || input.measurementId.length > 128 ||
      !isText(input.denominatorDefinitionId) || input.denominatorDefinitionId.length > 128 || !isNonNegativeCount(input.wrongfulBlockCount) ||
      !isPositiveCount(input.denominatorCount) || input.wrongfulBlockCount > input.denominatorCount || !isNonNegativeCount(input.measuredAt) ||
      Object.keys(input).some((key) => !['releaseId', 'measurementId', 'wrongfulBlockCount', 'denominatorCount', 'denominatorDefinitionId', 'measuredAt'].includes(key))) {
    return { ok: false, reason: 'measurement_invalid' };
  }
  const rate = input.wrongfulBlockCount / input.denominatorCount;
  const taskDisposition: WrongfulBlockTaskDisposition = configuredThreshold === null
    ? 'threshold_unconfigured'
    : rate > configuredThreshold ? 'limit_exceeded' : 'within_limit';
  return { ok: true, value: Object.freeze({
    releaseId: input.releaseId,
    measurementId: input.measurementId,
    wrongfulBlockCount: input.wrongfulBlockCount,
    denominatorCount: input.denominatorCount,
    denominatorDefinitionId: input.denominatorDefinitionId,
    measuredAt: input.measuredAt,
    rate,
    threshold: configuredThreshold,
    taskDisposition,
    reviewTaskId: null,
  }) };
}

function isNonNegativeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
