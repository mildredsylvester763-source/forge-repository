// AI-010 codedata-engine - append-only registry of code and data contributions used for training.
//
// Catalog law (ALG-14d/e, ALG-15): every code or data contribution is registered with a kind,
// an author, and a content hash. A bug fix must reference the failing test that proves the bug
// ('codedata-fix-no-test' otherwise). A parent contribution must already exist, so chains are
// always well formed. Deploy contributions carry a state machine with terminal states; terminal
// states never transition again.
//
// Refusals:
//   codedata-no-input / codedata-no-kind / codedata-invalid-kind:<kind>
//   codedata-no-content-hash / codedata-no-author / codedata-no-now
//   codedata-fix-no-test
//   codedata-unknown-parent:<id>
//   codedata-no-code-id / codedata-no-state / codedata-unknown-code:<id>
//   codedata-not-deploy:<id> / codedata-terminal-state:<state>
//   codedata-invalid-transition:<from>:<to>

export type CodeDataKind = 'diff' | 'fix' | 'review' | 'test' | 'deploy';

export const CODE_DATA_KINDS: string[] = ['diff', 'fix', 'review', 'test', 'deploy'];
export const DEPLOY_TERMINAL_STATES: string[] = ['succeeded', 'failed', 'rolled-back', 'aborted'];
export const DEPLOY_TRANSITIONS: Record<string, string[]> = {
  pending: ['running', 'aborted', 'failed'],
  running: ['succeeded', 'failed', 'rolled-back', 'aborted'],
};

export interface CodeDataRecord {
  codeId: string;
  kind: CodeDataKind;
  contentHash: string;
  author: string;
  parentCode: string | null;
  failingTestId: string | null;
  state: string | null;
  fingerprint: string;
  createdAt: number;
}

export interface RegisterCodeDataInput {
  kind: string;
  contentHash: string;
  author: string;
  parentCode?: string;
  failingTestId?: string;
  now: number;
}

export interface UpdateDeployStateInput {
  codeId: string;
  toState: string;
  now: number;
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function fp(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h * 33 + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(-8);
}

// Register one code or data contribution. The registry is passed in and appended to by the
// caller on success; this function never mutates it. Duplicate identity wins: an identical
// manifest already registered returns the existing record with duplicate:true.
export function registerCodeData(
  input: RegisterCodeDataInput,
  registry: CodeDataRecord[]
): Verdict<CodeDataRecord & { duplicate: boolean }> {
  if (!input) return fail('codedata-no-input');
  if (!isNonEmptyString(input.kind)) return fail('codedata-no-kind');
  if (!CODE_DATA_KINDS.includes(input.kind)) return fail('codedata-invalid-kind:' + input.kind);
  if (!isNonEmptyString(input.contentHash)) return fail('codedata-no-content-hash');
  if (!isNonEmptyString(input.author)) return fail('codedata-no-author');
  if (!isNum(input.now)) return fail('codedata-no-now');
  // A fix must reference the failing test that proves the bug it fixes.
  if (input.kind === 'fix' && !isNonEmptyString(input.failingTestId)) return fail('codedata-fix-no-test');
  const parentCode = input.parentCode === undefined || input.parentCode === null ? null : input.parentCode;
  if (parentCode !== null && !registry.some((r) => r.codeId === parentCode)) {
    return fail('codedata-unknown-parent:' + parentCode);
  }
  const identity =
    input.kind + ':' + input.contentHash + ':' + input.author + ':' + (parentCode ?? '') + ':' + (input.kind === 'fix' ? input.failingTestId ?? '' : '');
  const fingerprint = 'cdfp_' + fp(identity);
  const dup = registry.find((r) => r.fingerprint === fingerprint);
  if (dup) return { ok: true, value: { ...dup, duplicate: true } };
  const record: CodeDataRecord = {
    codeId: 'cd_' + (registry.length + 1),
    kind: input.kind as CodeDataKind,
    contentHash: input.contentHash,
    author: input.author,
    parentCode,
    failingTestId: input.kind === 'fix' ? (input.failingTestId ?? null) : null,
    state: input.kind === 'deploy' ? 'pending' : null,
    fingerprint,
    createdAt: input.now,
  };
  return { ok: true, value: { ...record, duplicate: false } };
}

// Move a deploy contribution through its state machine. Terminal states never move again.
export function updateDeployState(input: UpdateDeployStateInput, registry: CodeDataRecord[]): Verdict<{ codeId: string; state: string }> {
  if (!input) return fail('codedata-no-input');
  if (!isNonEmptyString(input.codeId)) return fail('codedata-no-code-id');
  if (!isNonEmptyString(input.toState)) return fail('codedata-no-state');
  const rec = registry.find((r) => r.codeId === input.codeId);
  if (!rec) return fail('codedata-unknown-code:' + input.codeId);
  if (rec.kind !== 'deploy') return fail('codedata-not-deploy:' + rec.codeId);
  const current = rec.state ?? 'pending';
  if (DEPLOY_TERMINAL_STATES.includes(current)) return fail('codedata-terminal-state:' + current);
  const allowed = DEPLOY_TRANSITIONS[current] as string[];
  if (!allowed || !allowed.includes(input.toState)) {
    return fail('codedata-invalid-transition:' + current + ':' + input.toState);
  }
  rec.state = input.toState;
  return { ok: true, value: { codeId: rec.codeId, state: input.toState } };
}
