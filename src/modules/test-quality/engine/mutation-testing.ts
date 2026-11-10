/**
 * FORGE TQ-036 Mutation testing engine.
 *
 * Market laws (Stryker, PIT, mutmut):
 * - A mutation run applies ONE mutation at a time to the source. Each
 *   mutant is executed against the test suite and lands in exactly one
 *   of three states: killed, survived or timeout.
 * - Mutation score = detected mutants (killed + timeout) as a percentage
 *   of total mutants. The default breach threshold is 80.
 * - Operators mutate concrete source tokens: booleans, guarded
 *   arithmetic, comparisons, numeric literals, string literals and
 *   logical connectives. One mutation per line per operator; a mutant
 *   that reproduces the original line is skipped.
 *
 * Pure engine: no framework imports, no I/O, fully deterministic.
 */

export const MUTATION_OPERATORS: readonly string[] = [
  'flip-boolean',
  'arith-swap',
  'comparison-shift',
  'number-zero',
  'string-empty',
  'logical-swap',
];
export const MUTANT_STATES: readonly string[] = ['killed', 'survived', 'timeout'];
export const MUTATION_THRESHOLD_DEFAULT = 80;
export const MUTATION_SOURCE_LIMIT = 200;
export const MUTATION_MUTANT_LIMIT = 500;

export interface Mutant {
  id: string;
  line: number;
  operator: string;
  original: string;
  mutated: string;
}

export interface MutationPlanInput {
  source?: unknown;
  operators?: unknown;
}

export interface MutationPlanResult {
  ok: boolean;
  reason?: string;
  mutants?: Mutant[];
  count?: number;
  operators?: string[];
}

export interface MutationScoreInput {
  mutants?: unknown;
  results?: unknown;
  threshold?: unknown;
}

export interface MutationScoreResult {
  ok: boolean;
  reason?: string;
  total?: number;
  killed?: number;
  survived?: number;
  timeout?: number;
  detected?: number;
  score?: number;
  threshold?: number;
  passed?: boolean;
}

function replaceAt(line: string, idx: number, len: number, replacement: string): string {
  return line.slice(0, idx) + replacement + line.slice(idx + len);
}

function findGuarded(line: string, ch: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ch) continue;
    const prev = i > 0 ? line[i - 1] : '';
    const next = i < line.length - 1 ? line[i + 1] : '';
    if (prev === ch || next === ch || next === '=') continue;
    return i;
  }
  return -1;
}

function findQuoted(line: string, quote: string): { start: number; len: number } | null {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== quote) continue;
    const close = line.indexOf(quote, i + 1);
    if (close === -1) return null;
    return { start: i, len: close - i + 1 };
  }
  return null;
}

export function applyOperator(line: string, operator: string): string | null {
  if (operator === 'flip-boolean') {
    const t = line.indexOf('true');
    if (t >= 0) return replaceAt(line, t, 4, 'false');
    const f = line.indexOf('false');
    if (f >= 0) return replaceAt(line, f, 5, 'true');
    return null;
  }
  if (operator === 'arith-swap') {
    const plus = findGuarded(line, '+');
    if (plus >= 0) return replaceAt(line, plus, 1, '-');
    const minus = findGuarded(line, '-');
    if (minus >= 0) return replaceAt(line, minus, 1, '+');
    const star = findGuarded(line, '*');
    if (star >= 0) return replaceAt(line, star, 1, '/');
    const slash = findGuarded(line, '/');
    if (slash >= 0) return replaceAt(line, slash, 1, '*');
    return null;
  }
  if (operator === 'comparison-shift') {
    const le = line.indexOf('<=');
    if (le >= 0) return replaceAt(line, le, 2, '<');
    const ge = line.indexOf('>=');
    if (ge >= 0) return replaceAt(line, ge, 2, '>');
    const lt = line.indexOf('<');
    if (lt >= 0 && line[lt + 1] !== '=') return replaceAt(line, lt, 1, '<=');
    const gt = line.indexOf('>');
    if (gt >= 0 && line[gt + 1] !== '=') return replaceAt(line, gt, 1, '>=');
    return null;
  }
  if (operator === 'number-zero') {
    const re = /\d+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (/[1-9]/.test(m[0])) return replaceAt(line, m.index, m[0].length, '0');
    }
    return null;
  }
  if (operator === 'string-empty') {
    const sq = findQuoted(line, "'");
    if (sq) return replaceAt(line, sq.start, sq.len, "''");
    const dq = findQuoted(line, '"');
    if (dq) return replaceAt(line, dq.start, dq.len, '""');
    return null;
  }
  if (operator === 'logical-swap') {
    const and = line.indexOf('&&');
    if (and >= 0) return replaceAt(line, and, 2, '||');
    const or = line.indexOf('||');
    if (or >= 0) return replaceAt(line, or, 2, '&&');
    return null;
  }
  return null;
}

export function planMutants(input: MutationPlanInput): MutationPlanResult {
  const sourceRaw = Array.isArray(input?.source) ? (input.source as unknown[]) : [];
  if (sourceRaw.length === 0) return { ok: false, reason: 'mutation-source-empty' };
  if (sourceRaw.length > MUTATION_SOURCE_LIMIT) {
    return { ok: false, reason: 'mutation-source-limit:' + sourceRaw.length };
  }
  for (let i = 0; i < sourceRaw.length; i++) {
    const line = sourceRaw[i];
    if (typeof line !== 'string' || line.trim().length === 0) {
      return { ok: false, reason: 'mutation-line-missing:' + (i + 1) };
    }
  }
  let operators: string[];
  if (input?.operators === undefined) {
    operators = [...MUTATION_OPERATORS];
  } else {
    if (!Array.isArray(input.operators)) return { ok: false, reason: 'mutation-operators-invalid' };
    operators = [];
    for (const raw of input.operators as unknown[]) {
      const name = typeof raw === 'string' ? raw.trim().toLowerCase() : String(raw);
      if (!MUTATION_OPERATORS.includes(name)) {
        return { ok: false, reason: 'mutation-operator-unknown:' + name };
      }
      operators.push(name);
    }
    if (operators.length === 0) return { ok: false, reason: 'mutation-operators-invalid' };
  }
  const mutants: Mutant[] = [];
  for (let li = 0; li < sourceRaw.length; li++) {
    const line = sourceRaw[li] as string;
    for (const operator of operators) {
      const mutated = applyOperator(line, operator);
      if (mutated !== null && mutated !== line) {
        mutants.push({
          id: 'm' + (mutants.length + 1),
          line: li + 1,
          operator,
          original: line,
          mutated,
        });
      }
    }
  }
  if (mutants.length > MUTATION_MUTANT_LIMIT) {
    return { ok: false, reason: 'mutation-mutant-limit:' + mutants.length };
  }
  return { ok: true, mutants, count: mutants.length, operators };
}

export function scoreMutants(input: MutationScoreInput): MutationScoreResult {
  const mutantsRaw = Array.isArray(input?.mutants) ? (input.mutants as unknown[]) : [];
  if (mutantsRaw.length === 0) return { ok: false, reason: 'mutation-mutants-empty' };
  const ids: string[] = [];
  for (const m of mutantsRaw) {
    const id = m && typeof (m as Record<string, unknown>).id === 'string' ? String((m as Record<string, unknown>).id) : '';
    if (id.length === 0) return { ok: false, reason: 'mutation-mutant-id-missing' };
    ids.push(id);
  }
  const results: unknown = input?.results;
  if (typeof results !== 'object' || results === null || Array.isArray(results)) {
    return { ok: false, reason: 'mutation-results-invalid' };
  }
  const resultMap = results as Record<string, unknown>;
  for (const key of Object.keys(resultMap)) {
    if (!ids.includes(key)) return { ok: false, reason: 'mutation-mutant-unknown:' + key };
  }
  for (const id of ids) {
    if (resultMap[id] === undefined) return { ok: false, reason: 'mutation-result-missing:' + id };
  }
  const rawThreshold: unknown = input?.threshold;
  const threshold = rawThreshold === undefined ? MUTATION_THRESHOLD_DEFAULT : rawThreshold;
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
    return { ok: false, reason: 'mutation-threshold-invalid:' + String(threshold) };
  }
  let killed = 0;
  let survived = 0;
  let timedout = 0;
  for (const id of ids) {
    const state = resultMap[id];
    if (typeof state !== 'string' || !MUTANT_STATES.includes(state)) {
      return { ok: false, reason: 'mutation-state-invalid:' + String(state) + ':' + id };
    }
    if (state === 'killed') killed++;
    else if (state === 'survived') survived++;
    else timedout++;
  }
  const total = ids.length;
  const detected = killed + timedout;
  const score = Number(((detected / total) * 100).toFixed(2));
  return {
    ok: true,
    total,
    killed,
    survived,
    timeout: timedout,
    detected,
    score,
    threshold,
    passed: score >= threshold,
  };
}
