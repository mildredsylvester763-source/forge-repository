// Pure fuzz testing engine for test generation (FORGE TQ-035).
// Market law (OWASP ZAP, RESTler): fuzzers either generate inputs from a
// grammar (typed fields, required always present, optional sometimes
// omitted) or mutate known-good samples (delete, insert, duplicate, flip).
// Campaigns are budgeted and seeded so every run is reproducible.

import { mulberry32 } from './property-based.ts';

export const FUZZ_KINDS = ['api', 'parser', 'format'];
export const FUZZ_FIELD_TYPES = ['string', 'int', 'bool', 'uuid'];
export const FUZZ_BUDGET_MIN = 1;
export const FUZZ_BUDGET_MAX = 1000;
export const FUZZ_BUDGET_DEFAULT = 100;
export const FUZZ_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const HEX = '0123456789abcdef';

export interface FuzzField {
  name: string;
  type: string;
  required?: boolean;
}

export interface FuzzCase {
  index: number;
  input: Record<string, unknown>;
  origin?: string;
  mutation?: string;
}

export interface FuzzVerdict {
  ok: boolean;
  reason?: string;
  kind?: string;
  budget?: number;
  seed?: number;
  cases?: FuzzCase[];
}

export function runFuzzCampaign(input: {
  kind?: unknown;
  fields?: unknown;
  samples?: unknown;
  budget?: unknown;
  seed?: unknown;
}): FuzzVerdict {
  const kindRaw = typeof input?.kind === 'string' ? input.kind.trim().toLowerCase() : '';
  if (kindRaw.length === 0) {
    return { ok: false, reason: 'fuzz-kind-missing' };
  }
  if (!FUZZ_KINDS.includes(kindRaw)) {
    return { ok: false, reason: 'fuzz-kind-unknown:' + kindRaw };
  }
  const budget = input?.budget === undefined ? FUZZ_BUDGET_DEFAULT : input.budget;
  if (
    typeof budget !== 'number' ||
    !Number.isInteger(budget) ||
    budget < FUZZ_BUDGET_MIN ||
    budget > FUZZ_BUDGET_MAX
  ) {
    return { ok: false, reason: 'fuzz-budget-invalid:' + String(budget) };
  }
  const seed = input?.seed === undefined ? 42 : input.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
    return { ok: false, reason: 'fuzz-seed-invalid:' + String(seed) };
  }
  const hasFields = Array.isArray(input?.fields);
  const hasSamples = Array.isArray(input?.samples);
  if (!hasFields && !hasSamples) {
    return { ok: false, reason: 'fuzz-input-missing' };
  }
  const rand = mulberry32(seed);
  if (hasFields) {
    const fields = input.fields as FuzzField[];
    if (fields.length === 0) {
      return { ok: false, reason: 'fuzz-fields-empty' };
    }
    const seen: string[] = [];
    for (const f of fields) {
      const fname = f && typeof f.name === 'string' ? f.name.trim() : '';
      if (fname.length === 0) {
        return { ok: false, reason: 'fuzz-field-name-missing' };
      }
      const ftype = typeof f?.type === 'string' ? f.type.trim().toLowerCase() : '';
      if (!FUZZ_FIELD_TYPES.includes(ftype)) {
        return { ok: false, reason: 'fuzz-field-type-unknown:' + ftype };
      }
      if (seen.includes(fname)) {
        return { ok: false, reason: 'fuzz-field-duplicate:' + fname };
      }
      seen.push(fname);
    }
    const cases: FuzzCase[] = [];
    for (let i = 0; i < budget; i++) {
      const body: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.required !== true && rand() < 0.3) {
          continue;
        }
        if (f.type === 'string') {
          const len = 1 + Math.floor(rand() * 12);
          let s = '';
          for (let j = 0; j < len; j++) {
            s += FUZZ_ALPHABET[Math.floor(rand() * FUZZ_ALPHABET.length)]!;
          }
          body[f.name] = s;
        } else if (f.type === 'int') {
          body[f.name] = Math.floor(rand() * 1000);
        } else if (f.type === 'bool') {
          body[f.name] = rand() < 0.5;
        } else {
          let u = '';
          for (let j = 0; j < 32; j++) {
            u += HEX[Math.floor(rand() * 16)]!;
            if (j === 7 || j === 11 || j === 15 || j === 19) {
              u += '-';
            }
          }
          body[f.name] = u;
        }
      }
      cases.push({ index: i, input: body });
    }
    return { ok: true, kind: kindRaw, budget, seed, cases };
  }
  const samples = input.samples as string[];
  if (samples.length === 0) {
    return { ok: false, reason: 'fuzz-samples-empty' };
  }
  for (const s of samples) {
    if (typeof s !== 'string' || s.length === 0) {
      return { ok: false, reason: 'fuzz-sample-invalid' };
    }
  }
  const cases: FuzzCase[] = [];
  for (let i = 0; i < budget; i++) {
    const origin = samples[Math.floor(rand() * samples.length)]!;
    const kindPick = Math.floor(rand() * 4);
    const pos = Math.floor(rand() * origin.length);
    let mutated = origin;
    let mutation = '';
    if (kindPick === 0) {
      mutated = origin.slice(0, pos) + origin.slice(pos + 1);
      mutation = 'delete:' + pos;
    } else if (kindPick === 1) {
      const ch = FUZZ_ALPHABET[Math.floor(rand() * FUZZ_ALPHABET.length)];
      mutated = origin.slice(0, pos) + ch + origin.slice(pos);
      mutation = 'insert:' + pos;
    } else if (kindPick === 2) {
      mutated = origin.slice(0, pos) + origin[pos]! + origin.slice(pos);
      mutation = 'duplicate:' + pos;
    } else {
      const ch =
        origin[pos]! === origin[pos]!.toUpperCase()
          ? origin[pos]!.toLowerCase()
          : origin[pos]!.toUpperCase();
      mutated = origin.slice(0, pos) + ch + origin.slice(pos + 1);
      mutation = 'flip:' + pos;
    }
    cases.push({ index: i, input: { mutated }, origin, mutation });
  }
  return { ok: true, kind: kindRaw, budget, seed, cases };
}
