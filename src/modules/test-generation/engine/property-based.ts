// Pure property-based testing engine for test generation (FORGE TQ-034).
// Market law (fast-check, JSVerify, QuickCheck, Hypothesis): properties are
// checked over seeded random cases, failures shrink to a minimal reproducer,
// and every run is reproducible from its seed. This engine plans property
// suites, generates seeded int and string case streams, and binary-searches
// the smallest failing input for upward-closed predicates.

export const PROPERTY_RUNS_MIN = 1;
export const PROPERTY_RUNS_MAX = 1000;
export const PROPERTY_RUNS_DEFAULT = 100;
export const PROPERTY_ALPHABET_DEFAULT = 'abcdefghijklmnopqrstuvwxyz';

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PropertySuiteVerdict {
  ok: boolean;
  reason?: string;
  name?: string;
  runs?: number;
  seed?: number;
  repro?: string;
}

export function planPropertySuite(input: {
  name?: unknown;
  runs?: unknown;
  seed?: unknown;
}): PropertySuiteVerdict {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) {
    return { ok: false, reason: 'property-name-missing' };
  }
  if (name.length > 200) {
    return { ok: false, reason: 'property-name-too-long' };
  }
  const runs =
    input?.runs === undefined ? PROPERTY_RUNS_DEFAULT : input.runs;
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < PROPERTY_RUNS_MIN || runs > PROPERTY_RUNS_MAX) {
    return { ok: false, reason: 'property-runs-invalid:' + String(runs) };
  }
  const seed = input?.seed === undefined ? 42 : input.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
    return { ok: false, reason: 'property-seed-invalid:' + String(seed) };
  }
  return {
    ok: true,
    name,
    runs,
    seed,
    repro: 'property:' + name + ' seed:' + seed + ' runs:' + runs,
  };
}

export interface IntCasesVerdict {
  ok: boolean;
  reason?: string;
  cases?: number[];
}

export function generateIntCases(input: {
  seed: number;
  runs: number;
  min: number;
  max: number;
}): IntCasesVerdict {
  const min = input?.min;
  const max = input?.max;
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isInteger(min) || !Number.isInteger(max) || min > max) {
    return { ok: false, reason: 'property-range-invalid:' + String(min) + ':' + String(max) };
  }
  const rand = mulberry32(input.seed);
  const cases: number[] = [];
  for (let i = 0; i < input.runs; i++) {
    cases.push(min + Math.floor(rand() * (max - min + 1)));
  }
  return { ok: true, cases };
}

export interface StringCasesVerdict {
  ok: boolean;
  reason?: string;
  cases?: string[];
}

export function generateStringCases(input: {
  seed: number;
  runs: number;
  alphabet?: unknown;
  maxLen: number;
}): StringCasesVerdict {
  const maxLen = input?.maxLen;
  if (typeof maxLen !== 'number' || !Number.isInteger(maxLen) || maxLen < 1 || maxLen > 1000) {
    return { ok: false, reason: 'property-length-invalid:' + String(maxLen) };
  }
  const alphabet =
    typeof input?.alphabet === 'string' && input.alphabet.length > 0
      ? input.alphabet
      : PROPERTY_ALPHABET_DEFAULT;
  const rand = mulberry32(input.seed);
  const cases: string[] = [];
  for (let i = 0; i < input.runs; i++) {
    const len = 1 + Math.floor(rand() * maxLen);
    let s = '';
    for (let j = 0; j < len; j++) {
      s += alphabet[Math.floor(rand() * alphabet.length)]!;
    }
    cases.push(s);
  }
  return { ok: true, cases };
}

export function shrinkInt(fails: (value: number) => boolean, n: number): number {
  if (!fails(n)) {
    return n;
  }
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fails(mid)) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}
