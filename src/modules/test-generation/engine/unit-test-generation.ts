// Pure unit test generation engine for test generation (FORGE TQ-031).
// Market law (Diffblue Cover, Qodo): generated tests are emitted in the
// users own framework from the target signature plus declared behaviors;
// the classic techniques are boundary value analysis and equivalence
// partitioning. This engine plans boundary cases per parameter (empty,
// single, many for collections; 0, 1, -1 for numbers; true, false for
// booleans) plus exactly one case per declared behavior. Every refusal
// is named.

export const UNIT_KINDS = ['function', 'class'];
export const UNIT_PARAM_TYPES = ['string', 'number', 'boolean', 'array', 'object'];
export const UNIT_PARAM_LIMIT = 10;
export const UNIT_BEHAVIOR_LIMIT = 20;

export interface UnitBoundaryCase {
  name: string;
  kind: 'boundary';
  detail: string;
}

export interface UnitBehaviorCase {
  name: string;
  kind: 'behavior';
  detail: string;
}

export type UnitCase = UnitBoundaryCase | UnitBehaviorCase;

export interface UnitVerdict {
  ok: boolean;
  reason?: string;
  target?: string;
  kind?: string;
  cases?: UnitCase[];
  boundaryCount?: number;
  behaviorCount?: number;
}

export function boundaryValues(type: string): unknown[] {
  switch (type) {
    case 'string':
      return ['', 'x', 'a'.repeat(64)];
    case 'number':
      return [0, 1, -1];
    case 'boolean':
      return [true, false];
    case 'array':
      return [[], [1], [1, 2, 3]];
    default:
      return [{}, { a: 1 }];
  }
}

export function boundaryCountOf(type: string): number {
  return type === 'boolean' || type === 'object' ? 2 : 3;
}

function boundaryDetail(name: string, type: string, value: unknown): string {
  if (type === 'string') return name + ' = str(' + String(value).length + ')';
  if (type === 'number') return name + ' = ' + String(value);
  if (type === 'boolean') return name + ' = ' + String(value);
  if (type === 'array') return name + ' = arr(' + String((value as unknown[]).length) + ')';
  return name + ' = obj(' + String(Object.keys(value as object).length) + ')';
}

export function planUnitTests(input: { target?: unknown; behaviors?: unknown }): UnitVerdict {
  const target = input && typeof input === 'object' ? input.target : undefined;
  if (!target || typeof target !== 'object') {
    return { ok: false, reason: 'unit-target-missing' };
  }
  const t = target as { name?: unknown; kind?: unknown; params?: unknown };
  const name = typeof t.name === 'string' ? t.name.trim() : '';
  if (name.length === 0) {
    return { ok: false, reason: 'unit-target-name-missing' };
  }
  if (name.length > 200) {
    return { ok: false, reason: 'unit-target-name-too-long' };
  }
  const kind = typeof t.kind === 'string' ? t.kind.trim().toLowerCase() : '';
  if (!UNIT_KINDS.includes(kind)) {
    return { ok: false, reason: 'unit-target-kind-unknown:' + kind };
  }
  const paramsRaw = Array.isArray(t.params) ? (t.params as Array<{ name?: unknown; type?: unknown }>) : [];
  if (paramsRaw.length > UNIT_PARAM_LIMIT) {
    return { ok: false, reason: 'unit-params-limit:' + paramsRaw.length };
  }
  const paramNames: string[] = [];
  for (const p of paramsRaw) {
    const pname = p && typeof p.name === 'string' ? p.name.trim() : '';
    if (pname.length === 0) {
      return { ok: false, reason: 'unit-param-name-missing' };
    }
    const ptype = typeof p?.type === 'string' ? p.type.trim().toLowerCase() : '';
    if (!UNIT_PARAM_TYPES.includes(ptype)) {
      return { ok: false, reason: 'unit-param-type-unknown:' + ptype };
    }
    if (paramNames.includes(pname)) {
      return { ok: false, reason: 'unit-param-duplicate:' + pname };
    }
    paramNames.push(pname);
  }
  const behaviorsRaw = Array.isArray(input?.behaviors)
    ? (input.behaviors as Array<{ name?: unknown }>)
    : [];
  if (behaviorsRaw.length === 0) {
    return { ok: false, reason: 'unit-behaviors-empty' };
  }
  if (behaviorsRaw.length > UNIT_BEHAVIOR_LIMIT) {
    return { ok: false, reason: 'unit-behaviors-limit:' + behaviorsRaw.length };
  }
  const behaviorNames: string[] = [];
  for (const b of behaviorsRaw) {
    const bname = b && typeof b.name === 'string' ? b.name.trim() : '';
    if (bname.length === 0) {
      return { ok: false, reason: 'unit-behavior-name-missing' };
    }
    if (behaviorNames.includes(bname)) {
      return { ok: false, reason: 'unit-behavior-duplicate:' + bname };
    }
    behaviorNames.push(bname);
  }
  const cases: UnitCase[] = [];
  for (const p of paramsRaw) {
    const pname = (p.name as string).trim();
    const ptype = (p.type as string).trim().toLowerCase();
    const vals = boundaryValues(ptype);
    for (let i = 0; i < vals.length; i++) {
      cases.push({
        name: 'boundary:' + pname + ':' + ptype + ':' + i,
        kind: 'boundary',
        detail: boundaryDetail(pname, ptype, vals[i]),
      });
    }
  }
  for (const b of behaviorsRaw) {
    const bname = (b.name as string).trim();
    cases.push({ name: 'behavior:' + bname, kind: 'behavior', detail: 'behavior ' + bname });
  }
  return {
    ok: true,
    target: name,
    kind,
    cases,
    boundaryCount: cases.length - behaviorsRaw.length,
    behaviorCount: behaviorsRaw.length,
  };
}
