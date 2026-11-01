import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  validateStep,
  STEP_CHECK_TYPES,
  type StepFailure,
  type StepValidationInput,
  type StepValidationResult,
} from '../src/modules/task-runtime/engine/step-validation.ts';
import {
  planApproval,
  resolveApproval,
  type ApprovalPolicyInput,
  type PlanApprovalInput,
  type PlanApprovalResult,
} from '../src/modules/task-runtime/engine/approval-gates.ts';
import {
  applyTaskCommand,
  isTaskTerminal,
  TASK_STATES,
  TASK_COMMANDS,
  TASK_TERMINAL_STATES,
  type TaskCommandInput,
  type TaskCommandResult,
} from '../src/modules/task-runtime/engine/task-control.ts';
import {
  appendTaskEvent,
  replayTask,
  TASK_EVENT_TYPES,
  type AppendTaskEventInput,
  type ReplayTaskInput,
  type ReplayTaskResult,
} from '../src/modules/task-runtime/engine/task-history.ts';
import {
  detectParallelConflicts,
  type DetectParallelConflictsInput,
  type DetectParallelConflictsResult,
  type ParallelConflict,
} from '../src/modules/task-runtime/engine/parallel-agents.ts';

// Engine specs for the task runtime (FORGE AI-079..083). Pinned vectors
// first, then a 500-case mulberry32(42) sweep against an independent
// oracle for each engine.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable((value as Record<string, unknown>)[k])).join(',') + '}';
}

describe('step validation engine (FORGE AI-079)', () => {
  it('passes a step whose every check succeeds', () => {
    const verdict = validateStep({
      stepId: 's1',
      output: { exitCode: 0, title: 'Report', body: 'final text' },
      checks: [
        { type: 'exit-code' },
        { type: 'field', path: 'title' },
        { type: 'contains', text: 'final' },
        { type: 'equals', value: { body: 'final text', title: 'Report', exitCode: 0 } },
      ],
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.stepId, 's1');
    assert.equal(verdict.passed, 4);
    assert.equal(verdict.failed, 0);
    assert.deepEqual(verdict.failures, []);
  });

  it('collects named failure details in check order', () => {
    const verdict = validateStep({
      stepId: 's2',
      output: { exitCode: 1, title: '' },
      checks: [{ type: 'exit-code' }, { type: 'field', path: 'title' }, { type: 'field', path: 'body' }],
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.failed, 3);
    assert.equal(verdict.passed, 0);
    assert.deepEqual(verdict.failures, [
      { index: 1, check: 'exit-code', detail: 'exit:1' },
      { index: 2, check: 'field', detail: 'field-empty:title' },
      { index: 3, check: 'field', detail: 'field-missing:body' },
    ]);
  });

  it('enforces max-length with missing, type and bound laws', () => {
    const over = validateStep({ stepId: 's3', output: { notes: 'abcde' }, checks: [{ type: 'max-length', path: 'notes', limit: 4 }] });
    assert.equal(over.failures[0]?.detail, 'max-length:notes:5>4');
    const within = validateStep({ stepId: 's3', output: { notes: 'abcde' }, checks: [{ type: 'max-length', path: 'notes', limit: 5 }] });
    assert.equal(within.ok, true);
    const missing = validateStep({ stepId: 's3', output: {}, checks: [{ type: 'max-length', path: 'notes', limit: 4 }] });
    assert.equal(missing.failures[0]?.detail, 'max-length-missing:notes');
    const wrongType = validateStep({ stepId: 's3', output: { notes: 42 }, checks: [{ type: 'max-length', path: 'notes', limit: 4 }] });
    assert.equal(wrongType.failures[0]?.detail, 'max-length-type:notes');
  });

  it('contains and equals evaluate against stable serialization', () => {
    const hit = validateStep({ stepId: 's4', output: { body: 'the final answer' }, checks: [{ type: 'contains', text: 'final' }] });
    assert.equal(hit.ok, true);
    const miss = validateStep({ stepId: 's4', output: { body: 'draft only' }, checks: [{ type: 'contains', text: 'final' }] });
    assert.deepEqual(miss.failures[0], { index: 1, check: 'contains', detail: 'contains:final' });
    const same = validateStep({ stepId: 's4', output: { b: 2, a: [1, 2] }, checks: [{ type: 'equals', value: { a: [1, 2], b: 2 } }] });
    assert.equal(same.ok, true);
    const differ = validateStep({ stepId: 's4', output: { b: 3 }, checks: [{ type: 'equals', value: { b: 2 } }] });
    assert.equal(differ.failures[0]?.detail, 'equals-mismatch');
  });

  it('refuses malformed inputs with named reasons', () => {
    assert.equal(validateStep({ checks: [{ type: 'exit-code' }] }).reason, 'stepv-step-id-missing');
    assert.equal(validateStep({ stepId: 's', checks: [] }).reason, 'stepv-checks-empty');
    assert.equal(validateStep({ stepId: 's' }).reason, 'stepv-checks-missing');
    assert.equal(validateStep({ stepId: 's', checks: [{ type: 'exit-code' }, null] }).reason, 'stepv-check-missing:2');
    assert.equal(validateStep({ stepId: 's', checks: [{}] }).reason, 'stepv-check-type-missing:1');
    assert.equal(validateStep({ stepId: 's', checks: [{ type: 'digest' }] }).reason, 'stepv-check-type-unknown:digest');
    assert.equal(validateStep({ stepId: 's', checks: [{ type: 'field' }] }).reason, 'stepv-path-missing:1');
    assert.equal(validateStep({ stepId: 's', checks: [{ type: 'max-length', path: 'n' }] }).reason, 'stepv-limit-missing:1');
    assert.equal(validateStep({ stepId: 's', checks: [{ type: 'max-length', path: 'n', limit: -1 }] }).reason, 'stepv-limit-invalid:1');
    assert.equal(validateStep({ stepId: 's', checks: [{ type: 'contains' }] }).reason, 'stepv-text-missing:1');
    assert.equal(validateStep({ stepId: 's', checks: [{ type: 'equals' }] }).reason, 'stepv-value-missing:1');
    const tooMany: unknown[] = [];
    for (let i = 0; i < 51; i++) tooMany.push({ type: 'exit-code' });
    assert.equal(validateStep({ stepId: 's', checks: tooMany }).reason, 'stepv-checks-limit:51');
  });

  it('matches an independent oracle across 500 random cases', () => {
    function oracleValidateStep(input: { stepId?: unknown; checks?: unknown; output?: unknown }): StepValidationResult {
      const sid = typeof input.stepId === 'string' ? input.stepId.trim() : '';
      const bad = (reason: string): StepValidationResult => ({ ok: false, reason, stepId: sid, passed: 0, failed: 0, failures: [] });
      if (sid === '') return bad('stepv-step-id-missing');
      if (sid.length > 100) return bad('stepv-step-id-too-long');
      const checks = input.checks;
      if (!Array.isArray(checks)) return bad('stepv-checks-missing');
      if (checks.length === 0) return bad('stepv-checks-empty');
      if (checks.length > 50) return bad('stepv-checks-limit:' + checks.length);
      const out = input.output;
      const fails: StepFailure[] = [];
      let idx = 0;
      while (idx < checks.length) {
        const c = checks[idx] as Record<string, unknown>;
        const n = idx + 1;
        const isObj = c !== null && typeof c === 'object' && !Array.isArray(c);
        if (!isObj) return bad('stepv-check-missing:' + n);
        const ctype = c.type;
        const type = typeof ctype === 'string' ? ctype.trim().toLowerCase() : '';
        const known = ['exit-code', 'field', 'max-length', 'contains', 'equals'];
        if (type === '') return bad('stepv-check-type-missing:' + n);
        if (known.indexOf(type) === -1) return bad('stepv-check-type-unknown:' + type);
        const objOut = out !== null && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : null;
        if (type === 'exit-code') {
          const ec = objOut ? objOut['exitCode'] : undefined;
          if (ec === undefined) fails.push({ index: n, check: type, detail: 'exit-missing' });
          else if (ec !== 0) fails.push({ index: n, check: type, detail: 'exit:' + String(ec) });
        } else if (type === 'field') {
          const p = typeof c.path === 'string' ? (c.path as string).trim() : '';
          if (p === '') return bad('stepv-path-missing:' + n);
          const v = objOut ? objOut[p] : undefined;
          if (v === undefined) fails.push({ index: n, check: type, detail: 'field-missing:' + p });
          else if (v === null || v === '') fails.push({ index: n, check: type, detail: 'field-empty:' + p });
        } else if (type === 'max-length') {
          const p = typeof c.path === 'string' ? (c.path as string).trim() : '';
          if (p === '') return bad('stepv-path-missing:' + n);
          const lim = c.limit;
          if (lim === undefined) return bad('stepv-limit-missing:' + n);
          if (typeof lim !== 'number' || !Number.isInteger(lim) || lim < 0) return bad('stepv-limit-invalid:' + n);
          const v = objOut ? objOut[p] : undefined;
          if (v === undefined) fails.push({ index: n, check: type, detail: 'max-length-missing:' + p });
          else if (typeof v !== 'string') fails.push({ index: n, check: type, detail: 'max-length-type:' + p });
          else if (v.length > lim) fails.push({ index: n, check: type, detail: 'max-length:' + p + ':' + v.length + '>' + lim });
        } else if (type === 'contains') {
          const t = typeof c.text === 'string' ? (c.text as string).trim() : '';
          if (t === '') return bad('stepv-text-missing:' + n);
          if (out === undefined) fails.push({ index: n, check: type, detail: 'contains-missing' });
          else {
            const subj = typeof out === 'string' ? out : stable(out);
            if (subj.indexOf(t) === -1) fails.push({ index: n, check: type, detail: 'contains:' + t });
          }
        } else {
          if (c.value === undefined) return bad('stepv-value-missing:' + n);
          if (out === undefined) fails.push({ index: n, check: type, detail: 'equals-missing' });
          else if (stable(out) !== stable(c.value)) fails.push({ index: n, check: type, detail: 'equals-mismatch' });
        }
        idx++;
      }
      const failed = fails.length;
      return { ok: failed === 0, stepId: sid, passed: checks.length - failed, failed, failures: fails };
    }
    const rand = mulberry32(42);
    const paths = ['title', 'body', 'notes', ''];
    const texts = ['final', 'missing', ''];
    const outputs: unknown[] = [
      undefined,
      'the final text',
      { exitCode: 0, title: 'Report', body: 'final text' },
      { exitCode: 1, title: '', notes: 'abcdef' },
      { title: 'Report', notes: 42 },
      {},
      'plain draft string',
      { exitCode: 2, body: null },
    ];
    let mismatches = 0;
    const reasonsSeen = new Set<string>();
    let okCount = 0;
    for (let c = 0; c < 500; c++) {
      const stepIdRoll = rand();
      const stepId = stepIdRoll < 0.08 ? '' : stepIdRoll < 0.12 ? (undefined as unknown) : 'step-' + Math.floor(rand() * 5);
      const checkCount = Math.floor(rand() * 7);
      const checks: unknown[] = [];
      for (let k = 0; k < checkCount; k++) {
        const roll = Math.floor(rand() * 6);
        const type = roll === 5 ? 'digest' : STEP_CHECK_TYPES[roll];
        const check: Record<string, unknown> = { type };
        if (type === 'field' || type === 'max-length') check.path = paths[Math.floor(rand() * paths.length)];
        if (type === 'max-length') check.limit = Math.floor(rand() * 12) - 1;
        if (type === 'contains') check.text = texts[Math.floor(rand() * texts.length)];
        if (type === 'equals' && rand() < 0.5) check.value = outputs[Math.floor(rand() * outputs.length)];
        if (rand() < 0.05) delete check.type;
        checks.push(check);
      }
      const output = outputs[Math.floor(rand() * outputs.length)];
      const input: Record<string, unknown> =
        checkCount === 0 && rand() < 0.5 ? { stepId } : { stepId, checks, output };
      if (rand() < 0.03) delete input.checks;
      const mine = validateStep(input as StepValidationInput);
      const oracle = oracleValidateStep(input as StepValidationInput);
      if (stable(mine) !== stable(oracle)) mismatches++;
      if (mine.reason) reasonsSeen.add(mine.reason);
      if (mine.ok) okCount++;
    }
    assert.equal(mismatches, 0);
    assert.ok(reasonsSeen.size > 8);
    assert.ok(okCount > 5);
  });
});

describe('approval gates engine (FORGE AI-080)', () => {
  it('gates high risk, sensitive tools and over-budget cost', () => {
    const high = planApproval({ risk: 'high', toolClass: 'read', cost: 10 });
    assert.equal(high.requiresApproval, true);
    assert.deepEqual(high.triggers, ['risk:high']);
    const write = planApproval({ risk: 'low', toolClass: 'write', cost: 10 });
    assert.deepEqual(write.triggers, ['tool:write']);
    const costly = planApproval({ risk: 'low', toolClass: 'read', cost: 1500 });
    assert.deepEqual(costly.triggers, ['cost:1500>1000']);
    const all = planApproval({ risk: 'high', toolClass: 'write', cost: 5000 });
    assert.deepEqual(all.triggers, ['risk:high', 'tool:write', 'cost:5000>1000']);
  });

  it('auto-approves low risk read steps within budget', () => {
    const verdict = planApproval({ risk: 'low', toolClass: 'read', cost: 10 });
    assert.equal(verdict.requiresApproval, false);
    assert.deepEqual(verdict.triggers, []);
  });

  it('normalizes case and trims whitespace before matching', () => {
    const verdict = planApproval({ risk: 'LOW', toolClass: 'Read', cost: 10 });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.requiresApproval, false);
  });

  it('honors custom policies and their trigger ordering', () => {
    const raised = planApproval({ risk: 'medium', toolClass: 'read', cost: 10, policy: { riskLevels: ['medium'] } });
    assert.deepEqual(raised.triggers, ['risk:medium']);
    const lifted = planApproval({ risk: 'low', toolClass: 'read', cost: 1200, policy: { maxAutoCost: 2000 } });
    assert.equal(lifted.requiresApproval, false);
    const strict = planApproval({ risk: 'low', toolClass: 'read', cost: 10, policy: { toolClasses: ['read'] } });
    assert.deepEqual(strict.triggers, ['tool:read']);
    const empty = planApproval({ risk: 'high', toolClass: 'write', cost: 5000, policy: {} });
    assert.deepEqual(empty.triggers, ['risk:high', 'tool:write', 'cost:5000>1000']);
  });

  it('resolves approvals and enforces the reject reason rule', () => {
    const approved = resolveApproval({ gateId: 'g1', decision: 'approve' });
    assert.deepEqual(approved, { ok: true, gateId: 'g1', decision: 'approve' });
    const rejected = resolveApproval({ gateId: 'g2', decision: 'REJECT', reason: ' budget over limit ' });
    assert.equal(rejected.decision, 'reject');
    assert.equal(rejected.reasonText, 'budget over limit');
  });

  it('refuses malformed inputs with named reasons', () => {
    assert.equal(planApproval({ toolClass: 'read', cost: 10 }).reason, 'approval-risk-invalid');
    assert.equal(planApproval({ risk: 'low', cost: 10 }).reason, 'approval-tool-class-invalid');
    assert.equal(planApproval({ risk: 'low', toolClass: 'read', cost: -5 }).reason, 'approval-cost-invalid');
    assert.equal(planApproval({ risk: 'low', toolClass: 'read', cost: 10, policy: null }).reason, 'approval-policy-invalid');
    assert.equal(planApproval({ risk: 'low', toolClass: 'read', cost: 10, policy: { riskLevels: [] } }).reason, 'approval-policy-invalid');
    assert.equal(planApproval({ risk: 'low', toolClass: 'read', cost: 10, policy: { toolClasses: ['delete'] } }).reason, 'approval-policy-invalid');
    assert.equal(planApproval({ risk: 'low', toolClass: 'read', cost: 10, policy: { maxAutoCost: 'low' } }).reason, 'approval-policy-invalid');
    assert.equal(resolveApproval({ decision: 'approve' }).reason, 'approval-gate-missing');
    assert.equal(resolveApproval({ gateId: 'g4', decision: 'defer' }).reason, 'approval-decision-unknown:defer');
    assert.equal(resolveApproval({ gateId: 'g3', decision: 'reject' }).reason, 'approval-reject-reason-missing');
    assert.equal(resolveApproval({ gateId: 'g3', decision: 'reject', reason: '   ' }).reason, 'approval-reject-reason-missing');
  });

  it('matches an independent oracle across 500 random cases', () => {
    function normalizeListOracle(raw: unknown, catalog: string[]): string[] | null {
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const out: string[] = [];
      for (const item of raw) {
        if (typeof item !== 'string') return null;
        const value = item.trim().toLowerCase();
        if (catalog.indexOf(value) === -1) return null;
        out.push(value);
      }
      return out;
    }
    function oraclePlan(inp: PlanApprovalInput): PlanApprovalResult {
      const risk = typeof inp?.risk === 'string' ? (inp.risk as string).trim().toLowerCase() : '';
      const RISKS = ['low', 'medium', 'high'];
      const TOOLS = ['read', 'write', 'exec', 'network'];
      if (RISKS.indexOf(risk) === -1) return { ok: false, reason: 'approval-risk-invalid' };
      const tc = typeof inp?.toolClass === 'string' ? (inp.toolClass as string).trim().toLowerCase() : '';
      if (TOOLS.indexOf(tc) === -1) return { ok: false, reason: 'approval-tool-class-invalid' };
      const cost = inp?.cost;
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return { ok: false, reason: 'approval-cost-invalid' };
      let rl = ['high'];
      let tcs = ['write', 'exec', 'network'];
      let mac = 1000;
      const p = inp?.policy as ApprovalPolicyInput | undefined;
      if (p !== undefined) {
        if (p === null || typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: 'approval-policy-invalid' };
        if (p.riskLevels !== undefined) {
          const n = normalizeListOracle(p.riskLevels, RISKS);
          if (n === null) return { ok: false, reason: 'approval-policy-invalid' };
          rl = n;
        }
        if (p.toolClasses !== undefined) {
          const n = normalizeListOracle(p.toolClasses, TOOLS);
          if (n === null) return { ok: false, reason: 'approval-policy-invalid' };
          tcs = n;
        }
        if (p.maxAutoCost !== undefined) {
          const m = p.maxAutoCost;
          if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) return { ok: false, reason: 'approval-policy-invalid' };
          mac = m;
        }
      }
      const trig: string[] = [];
      if (rl.indexOf(risk) !== -1) trig.push('risk:' + risk);
      if (tcs.indexOf(tc) !== -1) trig.push('tool:' + tc);
      if (cost > mac) trig.push('cost:' + cost + '>' + mac);
      return { ok: true, risk, toolClass: tc, cost, requiresApproval: trig.length > 0, triggers: trig };
    }
    const rand = mulberry32(42);
    let mismatches = 0;
    const reasonsSeen = new Set<string>();
    let autoApproved = 0;
    for (let c = 0; c < 500; c++) {
      const riskRoll = rand();
      const risk = riskRoll < 0.05 ? 'urgent' : riskRoll < 0.1 ? 7 : ['low', 'medium', 'high'][Math.floor(rand() * 3)];
      const tcRoll = rand();
      const toolClass = tcRoll < 0.05 ? 'delete' : tcRoll < 0.1 ? null : ['read', 'write', 'exec', 'network'][Math.floor(rand() * 4)];
      const costRoll = rand();
      const cost = costRoll < 0.05 ? '500' : costRoll < 0.1 ? -5 : Math.floor(rand() * 3000);
      const polRoll = rand();
      let policy: unknown;
      if (polRoll < 0.25) policy = undefined;
      else if (polRoll < 0.35) policy = null;
      else if (polRoll < 0.45) policy = { maxAutoCost: Math.floor(rand() * 2000) };
      else if (polRoll < 0.55) policy = { riskLevels: [['low', 'medium', 'high'][Math.floor(rand() * 3)]] };
      else if (polRoll < 0.65) policy = { toolClasses: [['read', 'write', 'exec', 'network'][Math.floor(rand() * 4)]] };
      else if (polRoll < 0.72) policy = { riskLevels: ['high'], toolClasses: ['write', 'exec', 'network'], maxAutoCost: 1000 };
      else if (polRoll < 0.78) policy = { maxAutoCost: 'low' };
      else policy = { riskLevels: [['low', 'medium', 'high'][Math.floor(rand() * 3)]], toolClasses: [['read', 'write', 'exec', 'network'][Math.floor(rand() * 4)]], maxAutoCost: Math.floor(rand() * 2500) };
      const input: Record<string, unknown> = { risk, toolClass, cost };
      if (policy !== undefined) input.policy = policy;
      const mine = planApproval(input as PlanApprovalInput);
      const oracle = oraclePlan(input as PlanApprovalInput);
      if (stable(mine) !== stable(oracle)) mismatches++;
      if (mine.reason) reasonsSeen.add(mine.reason);
      if (mine.ok && mine.requiresApproval === false) autoApproved++;
    }
    assert.equal(mismatches, 0);
    assert.ok(reasonsSeen.size >= 4);
    assert.ok(autoApproved > 20);
  });
});

describe('task control engine (FORGE AI-081)', () => {
  it('walks the legal pause, resume, cancel and takeover transitions', () => {
    const paused = applyTaskCommand({ state: 'running', command: 'pause' });
    assert.deepEqual(paused, { ok: true, from: 'running', command: 'pause', to: 'paused', terminal: false });
    const resumed = applyTaskCommand({ state: 'paused', command: 'resume' });
    assert.equal(resumed.to, 'running');
    assert.equal(resumed.terminal, false);
    const cancelled = applyTaskCommand({ state: 'running', command: 'cancel' });
    assert.equal(cancelled.to, 'cancelled');
    assert.equal(cancelled.terminal, true);
    const taken = applyTaskCommand({ state: 'paused', command: 'takeover' });
    assert.equal(taken.to, 'overtaken');
    assert.equal(taken.terminal, true);
    const fromPaused = applyTaskCommand({ state: 'paused', command: 'cancel' });
    assert.equal(fromPaused.to, 'cancelled');
  });

  it('normalizes case and trims whitespace before matching', () => {
    const verdict = applyTaskCommand({ state: 'PAUSED', command: ' RESUME ' });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.to, 'running');
  });

  it('rejects illegal live-state transitions by name', () => {
    assert.equal(applyTaskCommand({ state: 'running', command: 'resume' }).reason, 'task-invalid-transition:running:resume');
    assert.equal(applyTaskCommand({ state: 'paused', command: 'pause' }).reason, 'task-invalid-transition:paused:pause');
  });

  it('accepts no commands from any terminal state', () => {
    for (const state of ['cancelled', 'completed', 'failed', 'overtaken']) {
      for (const command of ['pause', 'resume', 'cancel', 'takeover']) {
        const verdict = applyTaskCommand({ state, command });
        assert.equal(verdict.ok, false);
        assert.equal(verdict.reason, 'task-invalid-transition:' + state + ':' + command);
      }
    }
  });

  it('exposes terminality for downstream guards', () => {
    assert.equal(isTaskTerminal('running'), false);
    assert.equal(isTaskTerminal('paused'), false);
    assert.equal(isTaskTerminal('overtaken'), true);
    assert.equal(isTaskTerminal('Completed'), true);
  });

  it('refuses malformed inputs with named reasons', () => {
    assert.equal(applyTaskCommand({ command: 'pause' }).reason, 'task-state-missing');
    assert.equal(applyTaskCommand({ state: 'zombie', command: 'pause' }).reason, 'task-state-unknown:zombie');
    assert.equal(applyTaskCommand({ state: 'running' }).reason, 'task-command-missing');
    assert.equal(applyTaskCommand({ state: 'running', command: 'rewind' }).reason, 'task-command-unknown:rewind');
  });

  it('matches an independent oracle across 500 random cases', () => {
    function oracleApply(inp: TaskCommandInput): TaskCommandResult {
      const state = typeof inp?.state === 'string' ? (inp.state as string).trim().toLowerCase() : '';
      if (state === '') return { ok: false, reason: 'task-state-missing' };
      if (TASK_STATES.indexOf(state) === -1) return { ok: false, reason: 'task-state-unknown:' + state };
      const command = typeof inp?.command === 'string' ? (inp.command as string).trim().toLowerCase() : '';
      if (command === '') return { ok: false, reason: 'task-command-missing' };
      if (TASK_COMMANDS.indexOf(command) === -1) return { ok: false, reason: 'task-command-unknown:' + command };
      let next: string | undefined;
      if (state === 'running') {
        if (command === 'pause') next = 'paused';
        else if (command === 'cancel') next = 'cancelled';
        else if (command === 'takeover') next = 'overtaken';
      } else if (state === 'paused') {
        if (command === 'resume') next = 'running';
        else if (command === 'cancel') next = 'cancelled';
        else if (command === 'takeover') next = 'overtaken';
      }
      if (next === undefined) return { ok: false, reason: 'task-invalid-transition:' + state + ':' + command };
      return { ok: true, from: state, command, to: next, terminal: TASK_TERMINAL_STATES.indexOf(next) !== -1 };
    }
    const rand = mulberry32(42);
    let mismatches = 0;
    const reasonsSeen = new Set<string>();
    let okCount = 0;
    const targets = new Set<string>();
    for (let c = 0; c < 500; c++) {
      const state = rand() < 0.1 ? ['zombie', 'RUNNING', ''][Math.floor(rand() * 3)] : TASK_STATES[Math.floor(rand() * 6)];
      const command = rand() < 0.1 ? ['rewind', 'PAUSE', ''][Math.floor(rand() * 3)] : TASK_COMMANDS[Math.floor(rand() * 4)];
      const input = rand() < 0.05 ? { state } : { state, command };
      const mine = applyTaskCommand(input as TaskCommandInput);
      const oracle = oracleApply(input as TaskCommandInput);
      if (stable(mine) !== stable(oracle)) mismatches++;
      if (mine.reason) reasonsSeen.add(mine.reason);
      if (mine.ok) {
        okCount++;
        targets.add((mine.from as string) + '>' + (mine.to as string));
      }
    }
    assert.equal(mismatches, 0);
    assert.ok(reasonsSeen.size > 10);
    assert.ok(okCount > 50);
    assert.equal(targets.size, 6);
  });
});

describe('task history engine (FORGE AI-082)', () => {
  const journal = [
    { seq: 1, type: 'task-created' },
    { seq: 2, type: 'step-started', stepId: 's1' },
    { seq: 3, type: 'step-validated', stepId: 's1' },
    { seq: 4, type: 'gate-requested', gateId: 'g1' },
    { seq: 5, type: 'gate-resolved', gateId: 'g1' },
    { seq: 6, type: 'task-paused' },
    { seq: 7, type: 'task-resumed' },
    { seq: 8, type: 'step-completed', stepId: 's1' },
    { seq: 9, type: 'task-completed' },
  ];

  it('appends events with contiguous sequence numbers', () => {
    const first = appendTaskEvent({ events: [], event: { type: 'task-created' } });
    assert.equal(first.ok, true);
    assert.equal(first.seq, 1);
    assert.deepEqual(first.events, [{ type: 'task-created', seq: 1 }]);
    const second = appendTaskEvent({ events: first.events, event: { type: 'step-started', stepId: 's1' } });
    assert.equal(second.ok, true);
    assert.equal(second.seq, 2);
    assert.equal(second.events?.[1]?.stepId, 's1');
  });

  it('replays a full journal to its final state', () => {
    const verdict = replayTask({ events: journal });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.seq, 9);
    assert.equal(verdict.applied, 9);
    assert.equal(verdict.state, 'completed');
    assert.deepEqual(verdict.steps, [{ stepId: 's1', status: 'completed' }]);
    assert.deepEqual(verdict.gates, [{ gateId: 'g1', status: 'resolved' }]);
  });

  it('replays to any midpoint with partial ledgers', () => {
    const paused = replayTask({ events: journal, toSeq: 6 });
    assert.equal(paused.state, 'paused');
    assert.deepEqual(paused.steps, [{ stepId: 's1', status: 'validated' }]);
    assert.deepEqual(paused.gates, [{ gateId: 'g1', status: 'resolved' }]);
    const gateOpen = replayTask({ events: journal, toSeq: 4 });
    assert.equal(gateOpen.state, 'running');
    assert.deepEqual(gateOpen.gates, [{ gateId: 'g1', status: 'requested' }]);
    assert.deepEqual(gateOpen.steps, [{ stepId: 's1', status: 'validated' }]);
  });

  it('treats an empty journal as a created task that applied nothing', () => {
    const verdict = replayTask({ events: [] });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.state, 'created');
    assert.equal(verdict.applied, 0);
    assert.deepEqual(verdict.steps, []);
    assert.deepEqual(verdict.gates, []);
  });

  it('tracks multiple steps and terminal failure or takeover', () => {
    const failed = replayTask({
      events: [
        { seq: 1, type: 'task-created' },
        { seq: 2, type: 'step-started', stepId: 's1' },
        { seq: 3, type: 'step-failed', stepId: 's1' },
        { seq: 4, type: 'task-failed' },
      ],
    });
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.steps, [{ stepId: 's1', status: 'failed' }]);
    const taken = replayTask({ events: [{ seq: 1, type: 'task-created' }, { seq: 2, type: 'takeover' }] });
    assert.equal(taken.state, 'overtaken');
    const multi = replayTask({
      events: [
        { seq: 1, type: 'step-started', stepId: 's2' },
        { seq: 2, type: 'step-started', stepId: 's1' },
        { seq: 3, type: 'step-completed', stepId: 's2' },
      ],
    });
    assert.deepEqual(multi.steps, [
      { stepId: 's2', status: 'completed' },
      { stepId: 's1', status: 'started' },
    ]);
  });

  it('refuses broken journals and out-of-bounds replays with named reasons', () => {
    assert.equal(appendTaskEvent({ events: 'x' }).reason, 'history-events-invalid');
    assert.equal(appendTaskEvent({ events: [{ seq: 1, type: 'task-created' }], event: 'nope' }).reason, 'history-event-missing');
    assert.equal(appendTaskEvent({ events: [], event: {} }).reason, 'history-type-missing:0');
    assert.equal(appendTaskEvent({ events: [], event: { type: 'magic' } }).reason, 'history-type-unknown:magic');
    assert.equal(replayTask({ events: [{ seq: 2, type: 'task-created' }] }).reason, 'history-seq-gap:1:2');
    assert.equal(replayTask({ events: [{ seq: 1, type: 'task-created' }, null] }).reason, 'history-event-invalid:2');
    assert.equal(replayTask({ events: [{ type: 'task-created' }] }).reason, 'history-seq-missing:1');
    assert.equal(replayTask({ events: [{ seq: '1', type: 'task-created' }] }).reason, 'history-seq-invalid:1');
    assert.equal(replayTask({ events: [{ seq: 1 }] }).reason, 'history-type-missing:1');
    assert.equal(replayTask({ events: [{ seq: 1, type: 'teleported' }] }).reason, 'history-type-unknown:teleported');
    assert.equal(replayTask({ events: journal, toSeq: 0 }).reason, 'history-to-seq-invalid:0');
    assert.equal(replayTask({ events: journal, toSeq: 10 }).reason, 'history-to-seq-invalid:10');
    assert.equal(replayTask({ events: journal, toSeq: 2.5 }).reason, 'history-to-seq-invalid:2.5');
  });

  it('matches an independent oracle across 500 random cases', () => {
    function oracleReplay(inp: ReplayTaskInput): ReplayTaskResult {
      const evts = inp.events;
      if (!Array.isArray(evts)) return { ok: false, reason: 'history-events-invalid' };
      let idx = 0;
      while (idx < evts.length) {
        const e = evts[idx] as Record<string, unknown>;
        if (!(typeof e === 'object' && e !== null && !Array.isArray(e))) return { ok: false, reason: 'history-event-invalid:' + (idx + 1) };
        if (e.seq === undefined || e.seq === null) return { ok: false, reason: 'history-seq-missing:' + (idx + 1) };
        if (typeof e.seq !== 'number' || !Number.isInteger(e.seq)) return { ok: false, reason: 'history-seq-invalid:' + (idx + 1) };
        if (e.seq !== idx + 1) return { ok: false, reason: 'history-seq-gap:' + (idx + 1) + ':' + e.seq };
        const t = typeof e.type === 'string' ? (e.type as string).trim() : '';
        if (t === '') return { ok: false, reason: 'history-type-missing:' + (idx + 1) };
        if (TASK_EVENT_TYPES.indexOf(t) === -1) return { ok: false, reason: 'history-type-unknown:' + t };
        idx++;
      }
      const list = evts as Record<string, unknown>[];
      let target = list.length;
      const ts = inp.toSeq;
      if (ts !== undefined) {
        if (typeof ts !== 'number' || !Number.isInteger(ts) || ts < 1 || ts > list.length) {
          return { ok: false, reason: 'history-to-seq-invalid:' + (typeof ts === 'number' ? ts : 'missing') };
        }
        target = ts;
      }
      let state = 'created';
      const steps: { stepId: string; status: string }[] = [];
      const gates: { gateId: string; status: string }[] = [];
      let k = 0;
      while (k < target) {
        const e = list[k];
        const t = e.type as string;
        if (t === 'task-created') state = 'running';
        else if (t === 'task-paused') state = 'paused';
        else if (t === 'task-resumed') state = 'running';
        else if (t === 'task-cancelled') state = 'cancelled';
        else if (t === 'task-completed') state = 'completed';
        else if (t === 'task-failed') state = 'failed';
        else if (t === 'takeover') state = 'overtaken';
        else if (t === 'step-started' || t === 'step-validated' || t === 'step-completed' || t === 'step-failed') {
          const sid = typeof e.stepId === 'string' ? (e.stepId as string) : '?';
          const st = t === 'step-started' ? 'started' : t === 'step-validated' ? 'validated' : t === 'step-completed' ? 'completed' : 'failed';
          let f = -1;
          let q = 0;
          while (q < steps.length) {
            if (steps[q].stepId === sid) {
              f = q;
              break;
            }
            q++;
          }
          if (f === -1) steps.push({ stepId: sid, status: st });
          else steps[f] = { stepId: sid, status: st };
        } else {
          const gid = typeof e.gateId === 'string' ? (e.gateId as string) : '?';
          const st = t === 'gate-requested' ? 'requested' : 'resolved';
          let f = -1;
          let q = 0;
          while (q < gates.length) {
            if (gates[q].gateId === gid) {
              f = q;
              break;
            }
            q++;
          }
          if (f === -1) gates.push({ gateId: gid, status: st });
          else gates[f] = { gateId: gid, status: st };
        }
        k++;
      }
      return { ok: true, seq: target, applied: target, state, steps, gates };
    }
    const rand = mulberry32(42);
    let mismatches = 0;
    const reasonsSeen = new Set<string>();
    let replayOk = 0;
    for (let c = 0; c < 500; c++) {
      const len = Math.floor(rand() * 6);
      const events: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const roll = rand();
        if (roll < 0.04) {
          events.push(null);
          break;
        }
        if (roll < 0.08) {
          events.push({ seq: i + 2, type: TASK_EVENT_TYPES[Math.floor(rand() * 13)] });
          break;
        }
        if (roll < 0.11) {
          events.push({ type: TASK_EVENT_TYPES[Math.floor(rand() * 13)] });
          break;
        }
        if (roll < 0.13) {
          events.push({ seq: i + 1, type: 'teleported' });
          break;
        }
        const type = TASK_EVENT_TYPES[Math.floor(rand() * 13)];
        const event: Record<string, unknown> = { seq: i + 1, type };
        if (type.startsWith('step-')) event.stepId = 's' + Math.floor(rand() * 3);
        if (type.startsWith('gate-')) event.gateId = 'g' + Math.floor(rand() * 2);
        events.push(event);
      }
      let toSeq: unknown;
      const toRoll = rand();
      if (toRoll < 0.3) toSeq = undefined;
      else if (toRoll < 0.5) toSeq = 1 + Math.floor(rand() * Math.max(1, len));
      else if (toRoll < 0.6) toSeq = len + 1;
      else toSeq = Math.floor(rand() * 2);
      const input = { events, toSeq } as ReplayTaskInput;
      const mine = replayTask(input);
      const oracle = oracleReplay(input);
      if (stable(mine) !== stable(oracle)) mismatches++;
      if (mine.reason) reasonsSeen.add(mine.reason);
      if (mine.ok) replayOk++;
      if (rand() < 0.3 && events.length < 6) {
        const evType = TASK_EVENT_TYPES[Math.floor(rand() * 13)];
        const appendInput = { events, event: { type: evType, stepId: 's9' } } as AppendTaskEventInput;
        const mineAppend = appendTaskEvent(appendInput);
        const journalValid = events.length === 0 ? true : oracleReplay({ events, toSeq: events.length } as ReplayTaskInput).ok;
        if (mineAppend.ok !== journalValid) mismatches++;
        if (mineAppend.ok && (mineAppend.seq !== events.length + 1 || mineAppend.events!.length !== events.length + 1)) mismatches++;
        if (mineAppend.reason) reasonsSeen.add(mineAppend.reason);
      }
    }
    assert.equal(mismatches, 0);
    assert.ok(reasonsSeen.size > 15);
    assert.ok(replayOk > 150);
  });
});

describe('parallel agents engine (FORGE AI-083)', () => {
  it('detects write-write conflicts in relaxed mode', () => {
    const verdict = detectParallelConflicts({
      agents: [
        { agentId: 'a1', writes: ['db.users', 'file.log'] },
        { agentId: 'a2', writes: ['db.users'] },
      ],
      mode: 'relaxed',
    });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.conflicts, [{ a: 'a1', b: 'a2', resource: 'db.users', kind: 'write-write' }]);
  });

  it('detects read-write conflicts only in strict mode', () => {
    const strict = detectParallelConflicts({
      agents: [
        { agentId: 'a1', reads: ['db.users'] },
        { agentId: 'a2', writes: ['db.users'] },
      ],
    });
    assert.deepEqual(strict.conflicts, [{ a: 'a2', b: 'a1', resource: 'db.users', kind: 'read-write' }]);
    const relaxed = detectParallelConflicts({
      agents: [
        { agentId: 'a1', reads: ['db.users'] },
        { agentId: 'a2', writes: ['db.users'] },
      ],
      mode: 'relaxed',
    });
    assert.equal(relaxed.hasConflicts, false);
  });

  it('reports the writer as the read-write conflict owner across pairs', () => {
    const verdict = detectParallelConflicts({
      agents: [
        { agentId: 'alpha', reads: ['db.users'], writes: ['cache.a'] },
        { agentId: 'beta', reads: ['cache.a'], writes: ['db.users'] },
      ],
    });
    assert.deepEqual(verdict.conflicts, [
      { a: 'alpha', b: 'beta', resource: 'cache.a', kind: 'read-write' },
      { a: 'beta', b: 'alpha', resource: 'db.users', kind: 'read-write' },
    ]);
  });

  it('emits both conflict kinds when a pair reads and writes the same resource', () => {
    const verdict = detectParallelConflicts({
      agents: [
        { agentId: 'writer', reads: [], writes: ['q'] },
        { agentId: 'reader', reads: ['q'], writes: ['q'] },
      ],
    });
    assert.deepEqual(verdict.conflicts, [
      { a: 'writer', b: 'reader', resource: 'q', kind: 'read-write' },
      { a: 'writer', b: 'reader', resource: 'q', kind: 'write-write' },
    ]);
  });

  it('defaults reads and writes to empty and dedupes repeated resources', () => {
    const solo = detectParallelConflicts({ agents: [{ agentId: 'solo', reads: ['x'], writes: ['y'] }] });
    assert.equal(solo.ok, true);
    assert.equal(solo.agentCount, 1);
    assert.equal(solo.hasConflicts, false);
    const bare = detectParallelConflicts({ agents: [{ agentId: 'a' }] });
    assert.equal(bare.ok, true);
    const dupes = detectParallelConflicts({
      agents: [
        { agentId: 'a1', writes: ['r2', 'r1', 'r2'] },
        { agentId: 'a2', writes: ['r1', 'r2'] },
      ],
    });
    assert.deepEqual(dupes.conflicts, [
      { a: 'a1', b: 'a2', resource: 'r1', kind: 'write-write' },
      { a: 'a1', b: 'a2', resource: 'r2', kind: 'write-write' },
    ]);
  });

  it('refuses malformed inputs with named reasons', () => {
    assert.equal(detectParallelConflicts({ agents: [] }).reason, 'parallel-agents-empty');
    assert.equal(detectParallelConflicts({}).reason, 'parallel-agents-empty');
    assert.equal(detectParallelConflicts({ agents: [null] }).reason, 'parallel-agent-missing:1');
    assert.equal(detectParallelConflicts({ agents: [{ reads: [] }] }).reason, 'parallel-agent-id-missing:1');
    assert.equal(detectParallelConflicts({ agents: [{ agentId: 'a' }, { agentId: 'a' }] }).reason, 'parallel-agent-id-duplicate:a');
    assert.equal(detectParallelConflicts({ agents: [{ agentId: 'a', reads: 'x' }] }).reason, 'parallel-reads-invalid:a');
    assert.equal(detectParallelConflicts({ agents: [{ agentId: 'a', writes: [1] }] }).reason, 'parallel-writes-invalid:a');
    assert.equal(detectParallelConflicts({ agents: [{ agentId: 'a' }], mode: 'loose' }).reason, 'parallel-mode-unknown:loose');
  });

  it('matches an independent oracle across 500 random cases', () => {
    function oracleDetect(inp: DetectParallelConflictsInput): DetectParallelConflictsResult {
      const ag = inp.agents;
      if (!Array.isArray(ag) || ag.length === 0) return { ok: false, reason: 'parallel-agents-empty' };
      const mRaw = inp.mode;
      const m = mRaw === undefined ? 'strict' : typeof mRaw === 'string' ? (mRaw as string).trim().toLowerCase() : '';
      if (m !== 'strict' && m !== 'relaxed') return { ok: false, reason: 'parallel-mode-unknown:' + (m.length === 0 ? 'missing' : m) };
      const list: { agentId: string; reads: string[]; writes: string[] }[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < ag.length; i++) {
        const a = ag[i] as Record<string, unknown>;
        if (!(typeof a === 'object' && a !== null && !Array.isArray(a))) return { ok: false, reason: 'parallel-agent-missing:' + (i + 1) };
        const id = typeof a.agentId === 'string' ? (a.agentId as string).trim() : '';
        if (id === '') return { ok: false, reason: 'parallel-agent-id-missing:' + (i + 1) };
        if (seen.has(id)) return { ok: false, reason: 'parallel-agent-id-duplicate:' + id };
        seen.add(id);
        if (a.reads !== undefined && !(Array.isArray(a.reads) && (a.reads as unknown[]).every((x) => typeof x === 'string'))) return { ok: false, reason: 'parallel-reads-invalid:' + id };
        if (a.writes !== undefined && !(Array.isArray(a.writes) && (a.writes as unknown[]).every((x) => typeof x === 'string'))) return { ok: false, reason: 'parallel-writes-invalid:' + id };
        list.push({
          agentId: id,
          reads: a.reads === undefined ? [] : (a.reads as string[]).slice(),
          writes: a.writes === undefined ? [] : (a.writes as string[]).slice(),
        });
      }
      const out: ParallelConflict[] = [];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const A = list[i];
          const B = list[j];
          const ww: string[] = [];
          for (const r of A.writes) {
            if (B.writes.indexOf(r) !== -1 && ww.indexOf(r) === -1) ww.push(r);
          }
          ww.sort();
          for (const r of ww) out.push({ a: A.agentId, b: B.agentId, resource: r, kind: 'write-write' });
          if (m === 'strict') {
            const awbr: string[] = [];
            for (const r of A.writes) {
              if (B.reads.indexOf(r) !== -1 && awbr.indexOf(r) === -1) awbr.push(r);
            }
            awbr.sort();
            for (const r of awbr) out.push({ a: A.agentId, b: B.agentId, resource: r, kind: 'read-write' });
            const arbw: string[] = [];
            for (const r of A.reads) {
              if (B.writes.indexOf(r) !== -1 && arbw.indexOf(r) === -1) arbw.push(r);
            }
            arbw.sort();
            for (const r of arbw) out.push({ a: B.agentId, b: A.agentId, resource: r, kind: 'read-write' });
          }
        }
      }
      out.sort((x, y) => (x.a + '|' + x.b + '|' + x.resource + '|' + x.kind < y.a + '|' + y.b + '|' + y.resource + '|' + y.kind ? -1 : 1));
      return { ok: true, mode: m, agentCount: list.length, conflicts: out, hasConflicts: out.length > 0 };
    }
    const rand = mulberry32(42);
    const resources = ['r1', 'r2', 'r3', 'db', 'cache'];
    let mismatches = 0;
    const reasonsSeen = new Set<string>();
    let okCount = 0;
    let conflictTotal = 0;
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rand() * 4);
      const agents: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const roll = rand();
        if (roll < 0.02) {
          agents.push(null);
          break;
        }
        if (roll < 0.05) {
          agents.push({ reads: [] });
          break;
        }
        const agent: Record<string, unknown> = { agentId: rand() < 0.05 ? 'dup' : 'ag' + i };
        const makeList = () => {
          const count = Math.floor(rand() * 3);
          const list: unknown[] = [];
          for (let q = 0; q < count; q++) list.push(resources[Math.floor(rand() * resources.length)]);
          return list;
        };
        if (rand() < 0.9) agent.reads = rand() < 0.05 ? 'bad' : makeList();
        if (rand() < 0.9) agent.writes = rand() < 0.05 ? [7] : makeList();
        if (rand() < 0.02) delete agent.agentId;
        agents.push(agent);
      }
      const mode = rand() < 0.5 ? 'strict' : rand() < 0.9 ? 'relaxed' : 'loose';
      const input = { agents, mode } as DetectParallelConflictsInput;
      const mine = detectParallelConflicts(input);
      const oracle = oracleDetect(input);
      if (stable(mine) !== stable(oracle)) mismatches++;
      if (mine.reason) reasonsSeen.add(mine.reason);
      if (mine.ok) {
        okCount++;
        conflictTotal += mine.conflicts!.length;
      }
    }
    assert.equal(mismatches, 0);
    assert.ok(reasonsSeen.size > 8);
    assert.ok(okCount > 200);
    assert.ok(conflictTotal > 100);
  });
});
