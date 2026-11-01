import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { AGENTS, planHandoffs, selectAgent } from '../src/modules/orchestrator/engine/agent-selection.ts';
import { checkToolPermission, toolsForPlan } from '../src/modules/orchestrator/engine/tool-registry.ts';
import { runSandboxed } from '../src/modules/orchestrator/engine/execution-sandbox.ts';
import { classifyIntent, INTENTS } from '../src/modules/orchestrator/engine/intent-classification.ts';
import { PLAN_ACTIONS, editPlan, planTask } from '../src/modules/orchestrator/engine/task-planner.ts';
import { previewPlan } from '../src/modules/orchestrator/engine/plan-preview.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('orchestrator engine: intent classification (AI-073)', () => {
  it('classifies pinned texts and refuses by name', () => {
    const ic1 = classifyIntent({ text: 'what is forge' });
    assert.ok(ic1.ok === true && ic1.intent === 'question' && ic1.score === 1 && ic1.confidence === 1);
    const ic2 = classifyIntent({ text: 'fix the bug and deploy it' });
    assert.ok(ic2.ok === true && ic2.intent === 'command' && ic2.score === 2);
    const ic3 = classifyIntent({ text: 'hello, please write a draft and review it' });
    assert.ok(ic3.ok === true && ic3.intent === 'creation' && ic3.score === 2 && ic3.confidence === 0.5);
    assert.equal(classifyIntent({ text: 'zzz qqq' }).reason, 'intent-no-match');
    assert.equal(classifyIntent({ text: '   ' }).reason, 'intent-text-missing');
    assert.equal(classifyIntent({ text: 'a'.repeat(2001) }).reason, 'intent-text-too-long');
    assert.equal(classifyIntent({ text: 'hello', allowed: ['command'] }).reason, 'intent-not-allowed:conversation');
    assert.ok(classifyIntent({ text: 'hello', allowed: ['conversation', 'command'] }).ok === true);
    assert.equal(classifyIntent({ text: 'hi', allowed: ['zzz'] }).reason, 'intent-allowlist-unknown:zzz');
    assert.equal(classifyIntent({ text: 'hi', allowed: 'hi' }).reason, 'intent-allowlist-invalid');
  });

  it('matches an independent token oracle over 500 generated texts', () => {
    const FILLER = ['please', 'the', 'report', 'quickly', 'again', 'app', 'also', 'then', 'just', 'very'];
    const SINGLES = ['what','why','how','when','where','who','which','fix','add','delete','update','deploy','run','make','configure','install','write','draft','design','compose','build','generate','create','analyze','review','audit','explain','summarize','evaluate','compare','versus','vs','difference','better','hi','hello','thanks','hey'];
    const ORACLE_PAIRS: Array<[string, string]> = [
      ['what','question'],['why','question'],['how','question'],['when','question'],['where','question'],['who','question'],['which','question'],['?','question'],
      ['fix','command'],['add','command'],['delete','command'],['update','command'],['deploy','command'],['run','command'],['make','command'],['configure','command'],['install','command'],
      ['write','creation'],['draft','creation'],['design','creation'],['compose','creation'],['build','creation'],['generate','creation'],['create','creation'],
      ['analyze','analysis'],['review','analysis'],['audit','analysis'],['explain','analysis'],['summarize','analysis'],['evaluate','analysis'],
      ['compare','comparison'],['versus','comparison'],['vs','comparison'],['difference','comparison'],['better','comparison'],
      ['hi','conversation'],['hello','conversation'],['thanks','conversation'],['hey','conversation'],
    ];
    const rng = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rng() * 12);
      const parts: string[] = [];
      for (let k = 0; k < n; k++) {
        if (rng() < 0.6) parts.push(SINGLES[Math.floor(rng() * SINGLES.length)]!);
        else parts.push(FILLER[Math.floor(rng() * FILLER.length)]!);
      }
      let text = parts.join(' ');
      if (rng() < 0.3) text += ' ?';
      const tokens = text.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 0);
      const oScores: Record<string, number> = {};
      for (const i of INTENTS) oScores[i] = 0;
      for (const p of ORACLE_PAIRS) {
        if (p[0] === '?') {
          for (const ch of text) {
            if (ch === '?') oScores[p[1]]!++;
          }
        } else {
          for (const t of tokens) {
            if (t === p[0]) oScores[p[1]]!++;
          }
        }
      }
      let oTotal = 0;
      for (const i of INTENTS) oTotal += oScores[i]!;
      let oBest = '';
      for (const i of INTENTS) {
        if (oBest === '' || oScores[i]! > oScores[oBest]!) oBest = i;
      }
      const v = classifyIntent({ text });
      if (oTotal === 0) {
        assert.ok(v.ok === false && v.reason === 'intent-no-match', 'case ' + c + ': ' + text);
      } else {
        assert.ok(v.ok === true && v.intent === oBest && v.score === oScores[oBest], 'case ' + c + ': ' + text);
        assert.equal(v.confidence, Number((oScores[oBest]! / oTotal).toFixed(2)), 'case ' + c + ': ' + text);
      }
    }
  });
});

describe('orchestrator engine: task planner (AI-074)', () => {
  it('builds a pinned step chain and refuses by name', () => {
    const tp1 = planTask({ goal: 'ship it', steps: [{ action: 'search' }, { action: 'write', detail: 'the report' }, { action: 'run' }] });
    assert.ok(tp1.ok === true && tp1.goal === 'ship it' && tp1.steps !== undefined && tp1.steps.length === 3);
    assert.deepEqual(tp1.steps[0], { id: 's1', action: 'search', detail: 'search', dependsOn: [] });
    assert.equal(tp1.steps[1]!.dependsOn[0], 's1');
    assert.equal(tp1.steps[2]!.dependsOn[0], 's2');
    assert.equal(tp1.steps[1]!.detail, 'the report');
    assert.equal(tp1.steps[2]!.detail, 'run');
    assert.equal(planTask({ steps: [{ action: 'search' }] }).reason, 'plan-goal-missing');
    assert.equal(planTask({ goal: 'g'.repeat(501), steps: [{ action: 'search' }] }).reason, 'plan-goal-too-long');
    assert.equal(planTask({ goal: 'g', steps: [] }).reason, 'plan-steps-empty');
    assert.equal(planTask({ goal: 'g', steps: Array.from({ length: 21 }, () => ({ action: 'search' })) }).reason, 'plan-steps-limit:21');
    assert.equal(planTask({ goal: 'g', steps: [{ action: 'teleport' }] }).reason, 'plan-step-action-unknown:teleport');
    assert.equal(planTask({ goal: 'g', steps: [{}] }).reason, 'plan-step-action-missing');
  });

  it('matches an independent chain oracle over 500 generated plans', () => {
    const rng = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rng() * 8);
      const steps: Array<{ action: string; detail?: string }> = [];
      for (let k = 0; k < n; k++) {
        const action = PLAN_ACTIONS[Math.floor(rng() * 5)]!;
        steps.push(rng() < 0.5 ? { action } : { action, detail: 'd' + k });
      }
      const v = planTask({ goal: 'goal ' + c, steps });
      assert.ok(v.ok === true && v.goal === 'goal ' + c && v.steps !== undefined && v.steps.length === n, 'case ' + c);
      for (let i = 0; i < n; i++) {
        const s = v.steps[i]!;
        const expectedDetail = steps[i]!.detail ?? steps[i]!.action;
        assert.ok(s.id === 's' + (i + 1) && s.action === steps[i]!.action && s.detail === expectedDetail, 'case ' + c + ' step ' + i);
        assert.deepEqual(s.dependsOn, i === 0 ? [] : ['s' + i]);
      }
    }
  });
});

describe('orchestrator engine: plan editing (AI-074)', () => {
  const base = [
    { id: 's1', action: 'search' },
    { id: 's2', action: 'write' },
    { id: 's3', action: 'run' },
  ];

  it('applies pinned edits and refuses by name', () => {
    const ep1 = editPlan({ steps: base, edits: [{ op: 'remove', id: 's2' }] });
    assert.ok(ep1.ok === true && ep1.steps !== undefined && ep1.steps.length === 2);
    assert.equal(ep1.steps[0]!.action, 'search');
    assert.equal(ep1.steps[1]!.action, 'run');
    assert.equal(ep1.steps[1]!.id, 's2');
    const ep2 = editPlan({ steps: base, edits: [{ op: 'insert', index: 1, step: { action: 'verify' } }, { op: 'move', id: 's1', toIndex: 2 }] });
    assert.ok(ep2.ok === true && ep2.steps !== undefined);
    assert.equal(ep2.steps.map((s) => s.action).join(','), 'verify,write,search,run');
    assert.equal(editPlan({ steps: base, edits: [{ op: 'remove', id: 's9' }] }).reason, 'plan-edit-id-unknown:s9');
    assert.equal(editPlan({ steps: base, edits: [{ op: 'copy', id: 's1' }] }).reason, 'plan-edit-op-unknown:copy');
    assert.equal(editPlan({ steps: [{ id: 's1', action: 'search' }], edits: [{ op: 'remove', id: 's1' }] }).reason, 'plan-edit-result-empty');
    assert.equal(editPlan({ steps: [{ id: 's1', action: 'search' }, { id: 's1', action: 'run' }], edits: [{ op: 'remove', id: 's1' }] }).reason, 'plan-edit-step-duplicate:s1');
    assert.equal(editPlan({ steps: base, edits: [] }).reason, 'plan-edits-empty');
  });

  it('matches an independent edit-model oracle over 500 generated edit sequences', () => {
    const rng = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rng() * 6);
      const modelIds: string[] = [];
      const modelActs: string[] = [];
      const modelDetails: string[] = [];
      const inSteps: Array<{ id: string; action: string }> = [];
      for (let k = 0; k < n; k++) {
        const action = PLAN_ACTIONS[Math.floor(rng() * 5)]!;
        modelIds.push('s' + (k + 1));
        modelActs.push(action);
        modelDetails.push(action);
        inSteps.push({ id: 's' + (k + 1), action });
      }
      const edits: Array<Record<string, unknown>> = [];
      let legal = true;
      const m = 1 + Math.floor(rng() * 3);
      for (let e = 0; e < m; e++) {
        const opR = rng();
        if (opR < 0.34 || modelIds.length === 0) {
          const index = Math.floor(rng() * (modelIds.length + 1));
          const action = PLAN_ACTIONS[Math.floor(rng() * 5)]!;
          const detail = rng() < 0.5 ? 'x' + e : undefined;
          edits.push({ op: 'insert', index, step: detail === undefined ? { action } : { action, detail } });
          modelIds.splice(index, 0, 'inserted');
          modelActs.splice(index, 0, action);
          modelDetails.splice(index, 0, detail ?? action);
        } else {
          const candidates = modelIds.filter((x) => x !== 'inserted');
          if (candidates.length === 0) {
            legal = false;
            break;
          }
          const id = candidates[Math.floor(rng() * candidates.length)]!;
          const pos = modelIds.indexOf(id);
          if (opR < 0.67) {
            edits.push({ op: 'remove', id });
            modelIds.splice(pos, 1);
            modelActs.splice(pos, 1);
            modelDetails.splice(pos, 1);
          } else {
            const toIndex = Math.floor(rng() * modelIds.length);
            edits.push({ op: 'move', id, toIndex });
            modelIds.splice(pos, 1);
            const act = modelActs.splice(pos, 1)[0]!;
            const det = modelDetails.splice(pos, 1)[0]!;
            modelIds.splice(toIndex, 0, id);
            modelActs.splice(toIndex, 0, act);
            modelDetails.splice(toIndex, 0, det);
          }
        }
      }
      if (!legal) continue;
      const v = editPlan({ steps: inSteps, edits });
      if (modelActs.length === 0) {
        assert.ok(v.ok === false && v.reason === 'plan-edit-result-empty', 'case ' + c);
      } else if (modelActs.length > 20) {
        assert.ok(v.ok === false && v.reason === 'plan-steps-limit:' + modelActs.length, 'case ' + c);
      } else {
        assert.ok(v.ok === true && v.steps !== undefined && v.steps.length === modelActs.length, 'case ' + c);
        for (let i = 0; i < modelActs.length; i++) {
          const s = v.steps[i]!;
          assert.ok(s.id === 's' + (i + 1) && s.action === modelActs[i] && s.detail === modelDetails[i], 'case ' + c + ' step ' + i);
          assert.deepEqual(s.dependsOn, i === 0 ? [] : ['s' + i]);
        }
      }
    }
  });
});

describe('orchestrator engine: plan preview (AI-075)', () => {
  it('previews pinned plans and refuses by name', () => {
    const pv1 = previewPlan({ steps: [{ action: 'search' }, { action: 'write', file: 'a.ts' }, { action: 'run' }, { action: 'write', file: 'a.ts' }] });
    assert.ok(pv1.ok === true && pv1.stepCount === 4 && pv1.risk === 'high' && pv1.estimatedCost === 3400 && pv1.requiresApproval === true);
    assert.deepEqual(pv1.filesTouched, ['a.ts']);
    const pv2 = previewPlan({ steps: [{ action: 'verify' }, { action: 'present' }] });
    assert.ok(pv2.ok === true && pv2.risk === 'low' && pv2.estimatedCost === 500 && pv2.requiresApproval === false);
    assert.equal(previewPlan({ steps: [] }).reason, 'preview-steps-empty');
    assert.equal(previewPlan({ steps: [{ action: 'zzz' }] }).reason, 'preview-step-action-unknown:zzz');
    assert.equal(previewPlan({ steps: [{}] }).reason, 'preview-step-action-missing');
  });

  it('matches an independent cost and risk oracle over 500 generated plans', () => {
    const oCost = (a: string): number => {
      switch (a) {
        case 'search': return 400;
        case 'write': return 1200;
        case 'run': return 600;
        case 'verify': return 300;
        default: return 200;
      }
    };
    const oRiskIdx = (a: string): number => {
      switch (a) {
        case 'write': return 1;
        case 'run': return 2;
        default: return 0;
      }
    };
    const rng = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rng() * 6);
      const steps: Array<{ action: string; file?: string }> = [];
      for (let k = 0; k < n; k++) {
        const action = PLAN_ACTIONS[Math.floor(rng() * 5)]!;
        const st: { action: string; file?: string } = { action };
        if (rng() < 0.6) st.file = '/workspace/f' + Math.floor(rng() * 3) + '.ts';
        steps.push(st);
      }
      const v = previewPlan({ steps });
      let cost = 0;
      let riskIdx = 0;
      const files: string[] = [];
      for (const s of steps) {
        cost += oCost(s.action);
        const r = oRiskIdx(s.action);
        if (r > riskIdx) riskIdx = r;
        if (s.file !== undefined && !files.includes(s.file)) files.push(s.file);
      }
      const RISKS = ['low', 'medium', 'high'];
      assert.ok(v.ok === true && v.stepCount === n && v.estimatedCost === cost, 'case ' + c);
      assert.equal(v.risk, RISKS[riskIdx], 'case ' + c);
      assert.equal(v.requiresApproval, RISKS[riskIdx] === 'high', 'case ' + c);
      assert.deepEqual(v.filesTouched, files);
    }
  });
});

describe('orchestrator engine: agent selection and handoffs (AI-076)', () => {
  it('selects agents and refuses bad rosters by name', () => {
    assert.equal(selectAgent({ action: 'search' }).agent, 'researcher');
    assert.equal(selectAgent({ action: 'SEARCH' }).agent, 'researcher');
    assert.equal(selectAgent({ action: 'search', roster: ['writer'] }).reason, 'handoff-no-capable-agent:search');
    assert.equal(selectAgent({ action: 'search', roster: [] }).reason, 'handoff-roster-empty');
    assert.equal(selectAgent({ action: 'search', roster: ['intern'] }).reason, 'handoff-agent-unknown:intern');
    assert.equal(selectAgent({ action: 'search', roster: ['writer', 'writer'] }).reason, 'handoff-agent-duplicate:writer');
  });

  it('plans pinned handoffs and refuses bounces by name', () => {
    const hb1 = planHandoffs({ steps: [{ action: 'search' }, { action: 'write' }, { action: 'run' }] });
    assert.ok(hb1.ok === true && hb1.assignments !== undefined && hb1.assignments.length === 3 && hb1.assignments[0]!.agent === 'researcher');
    assert.deepEqual(hb1.handoffs, [
      { from: 'researcher', to: 'writer', atStep: 2 },
      { from: 'writer', to: 'executor', atStep: 3 },
    ]);
    assert.equal(planHandoffs({ steps: [{ action: 'search' }, { action: 'write' }, { action: 'search' }] }).reason, 'handoff-bounce-detected:researcher->writer->researcher');
    assert.ok(planHandoffs({ steps: [{ action: 'search' }, { action: 'write' }, { action: 'run' }, { action: 'search' }] }).ok === true);
    assert.equal(planHandoffs({ steps: [] }).reason, 'handoff-steps-empty');
  });

  it('matches an independent handoff oracle over 500 generated plans', () => {
    const AGENT_FOR: Record<string, string> = { search: 'researcher', write: 'writer', run: 'executor', verify: 'reviewer', present: 'coordinator' };
    const rng = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rng() * 8);
      const actions: string[] = [];
      for (let k = 0; k < n; k++) actions.push(PLAN_ACTIONS[Math.floor(rng() * 5)]!);
      const steps = actions.map((a) => ({ action: a }));
      const v = planHandoffs({ steps });
      const agents = actions.map((a) => AGENT_FOR[a]!);
      let bounce: string | null = null;
      const oHandoffs: Array<{ from: string; to: string; atStep: number }> = [];
      for (let i = 1; i < agents.length; i++) {
        if (agents[i] !== agents[i - 1]) {
          const prev = oHandoffs[oHandoffs.length - 1];
          if (prev !== undefined && prev.from === agents[i]) {
            bounce = 'handoff-bounce-detected:' + agents[i] + '->' + agents[i - 1] + '->' + agents[i];
            break;
          }
          oHandoffs.push({ from: agents[i - 1]!, to: agents[i]!, atStep: i + 1 });
        }
      }
      if (bounce !== null) {
        assert.ok(v.ok === false && v.reason === bounce, 'case ' + c);
      } else {
        assert.ok(v.ok === true && v.assignments !== undefined && v.assignments.length === n, 'case ' + c);
        for (let i = 0; i < n; i++) {
          const a = v.assignments[i]!;
          assert.ok(a.step === i + 1 && a.action === actions[i] && a.agent === agents[i], 'case ' + c + ' step ' + i);
        }
        assert.deepEqual(v.handoffs, oHandoffs);
      }
    }
  });
});

describe('orchestrator engine: tool registry (AI-077)', () => {
  it('checks pinned permissions and refuses by name', () => {
    const tc1 = checkToolPermission({ agent: 'researcher', tool: 'web-search' });
    assert.ok(tc1.ok === true && tc1.agent === 'researcher' && tc1.tool === 'web-search' && tc1.cls === 'read');
    assert.equal(checkToolPermission({ agent: 'writer', tool: 'shell-exec' }).reason, 'tool-denied:writer:shell-exec');
    assert.equal(checkToolPermission({ agent: 'intern', tool: 'fs-read' }).reason, 'tool-agent-unknown:intern');
    assert.equal(checkToolPermission({ agent: 'writer', tool: 'time-machine' }).reason, 'tool-unknown:time-machine');
    assert.equal(checkToolPermission({ tool: 'fs-read' }).reason, 'tool-agent-missing');
    assert.equal(checkToolPermission({ agent: 'writer' }).reason, 'tool-name-missing');
  });

  it('plans pinned tool requirements and refuses by name', () => {
    const tp2 = toolsForPlan({ assignments: [{ agent: 'researcher', action: 'search' }, { agent: 'executor', action: 'run' }] });
    assert.ok(tp2.ok === true);
    assert.deepEqual(tp2.required, [
      { step: 1, agent: 'researcher', action: 'search', tool: 'web-search' },
      { step: 2, agent: 'executor', action: 'run', tool: 'shell-exec' },
    ]);
    assert.equal(toolsForPlan({ assignments: [{ agent: 'coordinator', action: 'search' }] }).reason, 'tool-denied:coordinator:web-search');
    assert.equal(toolsForPlan({ assignments: [] }).reason, 'tool-plan-empty');
  });

  it('matches an independent permission-table oracle over 500 generated checks', () => {
    const PERMS: Array<[string, string]> = [
      ['coordinator','mail-send'],['coordinator','fs-read'],
      ['researcher','web-search'],['researcher','web-fetch'],['researcher','fs-read'],
      ['writer','fs-read'],['writer','fs-write'],
      ['executor','shell-exec'],['executor','fs-read'],['executor','fs-write'],
      ['reviewer','fs-read'],['reviewer','db-query'],
    ];
    const AG_LIST = ['coordinator', 'researcher', 'writer', 'executor', 'reviewer'];
    const TOOL_NAMES = ['web-search', 'web-fetch', 'fs-read', 'fs-write', 'shell-exec', 'db-query', 'db-migrate', 'mail-send'];
    const ACTION_TOOL_O: Record<string, string> = { search: 'web-search', write: 'fs-write', run: 'shell-exec', verify: 'db-query', present: 'mail-send' };
    const rng = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const agent = AG_LIST[Math.floor(rng() * 5)]!;
      const tool = TOOL_NAMES[Math.floor(rng() * 8)]!;
      const v = checkToolPermission({ agent, tool });
      const allowed = PERMS.some((p) => p[0] === agent && p[1] === tool);
      if (allowed) {
        assert.ok(v.ok === true && v.agent === agent && v.tool === tool, 'case ' + c);
      } else {
        assert.ok(v.ok === false && v.reason === 'tool-denied:' + agent + ':' + tool, 'case ' + c);
      }
      if (c % 2 === 0) {
        const n2 = 1 + Math.floor(rng() * 5);
        const assignments: Array<{ agent: string; action: string }> = [];
        for (let k = 0; k < n2; k++) {
          assignments.push({ agent: AG_LIST[Math.floor(rng() * 5)]!, action: PLAN_ACTIONS[Math.floor(rng() * 5)]! });
        }
        const v2 = toolsForPlan({ assignments });
        const oRequired: Array<{ step: number; agent: string; action: string; tool: string }> = [];
        let denial: string | null = null;
        for (let i = 0; i < n2; i++) {
          const a = assignments[i]!;
          const tool2 = ACTION_TOOL_O[a.action]!;
          if (!PERMS.some((p) => p[0] === a.agent && p[1] === tool2)) {
            denial = 'tool-denied:' + a.agent + ':' + tool2;
            break;
          }
          oRequired.push({ step: i + 1, agent: a.agent, action: a.action, tool: tool2 });
        }
        if (denial !== null) {
          assert.ok(v2.ok === false && v2.reason === denial, 'case ' + c + ' plan');
        } else {
          assert.ok(v2.ok === true, 'case ' + c + ' plan');
          assert.deepEqual(v2.required, oRequired);
        }
      }
    }
  });
});

describe('orchestrator engine: execution sandbox (AI-078)', () => {
  it('runs pinned sandbox checks and refuses by name', () => {
    const sb1 = runSandboxed({ tool: 'fs-write', timeout: 60, fileWrites: ['/workspace/a.txt'] });
    assert.ok(sb1.ok === true && sb1.tool === 'fs-write' && sb1.timeout === 60);
    assert.deepEqual(sb1.restrictions, ['workspace-only-fs', 'no-network', 'timeout-60s']);
    const sb2 = runSandboxed({ tool: 'web-fetch', egress: { host: 'api.example.com' }, egressAllowlist: ['api.example.com'] });
    assert.ok(sb2.ok === true);
    assert.equal(sb2.restrictions![3], 'egress:api.example.com');
    assert.equal(runSandboxed({ tool: 'fs-read' }).timeout, 30);
    assert.equal(runSandboxed({ tool: 'fs-read', timeout: 0 }).reason, 'sandbox-timeout-invalid:0');
    assert.equal(runSandboxed({ tool: 'fs-read', timeout: 601 }).reason, 'sandbox-timeout-invalid:601');
    assert.equal(runSandboxed({ tool: 'fs-read', timeout: 2.5 }).reason, 'sandbox-timeout-invalid:2.5');
    assert.equal(runSandboxed({}).reason, 'sandbox-tool-missing');
    assert.equal(runSandboxed({ tool: 'time-machine' }).reason, 'sandbox-tool-unknown:time-machine');
    assert.equal(runSandboxed({ tool: 'shell-exec', command: 'sudo rm logs' }).reason, 'sandbox-command-forbidden:sudo');
    assert.equal(runSandboxed({ tool: 'shell-exec', command: 'nice rm -rf /' }).reason, 'sandbox-command-forbidden:rm -rf /');
    assert.equal(runSandboxed({ tool: 'shell-exec', command: '   ' }).reason, 'sandbox-command-missing');
    assert.equal(runSandboxed({ tool: 'web-fetch', egress: { host: 'evil.example.com' }, egressAllowlist: ['api.example.com'] }).reason, 'sandbox-egress-denied:evil.example.com');
    assert.equal(runSandboxed({ tool: 'web-fetch', egress: {} }).reason, 'sandbox-egress-host-missing');
    assert.equal(runSandboxed({ tool: 'fs-write', fileWrites: ['/etc/passwd'] }).reason, 'sandbox-path-outside-workspace:/etc/passwd');
    assert.equal(runSandboxed({ tool: 'fs-write', fileWrites: [''] }).reason, 'sandbox-path-missing');
  });

  it('matches an independent sandbox oracle over 500 generated runs', () => {
    const TOOL_NAMES = ['web-search', 'web-fetch', 'fs-read', 'fs-write', 'shell-exec', 'db-query', 'db-migrate', 'mail-send'];
    const SAFE_CMDS = ['ls -la', 'cat notes.txt', 'echo done', 'npm test', 'grep -r todo .'];
    const rng = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const tool = TOOL_NAMES[Math.floor(rng() * 8)]!;
      const timeoutRoll = rng();
      let timeout: number | string;
      let expected: string | null = null;
      if (timeoutRoll < 0.75) {
        timeout = 1 + Math.floor(rng() * 600);
      } else {
        const bads: Array<number | string> = [0, -3, 601, 2.5, 'x'];
        timeout = bads[Math.floor(rng() * 5)]!;
        expected = 'sandbox-timeout-invalid:' + String(timeout);
      }
      const input: Record<string, unknown> = { tool, timeout };
      if (expected === null) {
        if (rng() < 0.5) {
          if (rng() < 0.25) {
            const command = rng() < 0.5 ? 'sudo npm install' : 'nice rm -rf / all';
            input.command = command;
            expected = 'sandbox-command-forbidden:' + (command.indexOf('sudo') >= 0 ? 'sudo' : 'rm -rf /');
          } else {
            input.command = SAFE_CMDS[Math.floor(rng() * 5)]!;
          }
        }
        if (expected === null && rng() < 0.4) {
          const host = 'api.example.com';
          input.egress = { host };
          if (rng() < 0.5) input.egressAllowlist = [host];
          else expected = 'sandbox-egress-denied:' + host;
        }
        if (expected === null && rng() < 0.4) {
          if (rng() < 0.7) input.fileWrites = ['/workspace/out' + c + '.txt'];
          else {
            input.fileWrites = ['/etc/passwd'];
            expected = 'sandbox-path-outside-workspace:/etc/passwd';
          }
        }
      }
      const v = runSandboxed(input);
      if (expected !== null) {
        assert.ok(v.ok === false && v.reason === expected, 'case ' + c + ': expected ' + expected + ' got ' + String(v.reason));
      } else {
        assert.ok(v.ok === true && v.tool === tool && v.timeout === timeout, 'case ' + c);
        const oRestr = ['workspace-only-fs', 'no-network', 'timeout-' + timeout + 's'];
        const egress = input.egress as { host: string } | undefined;
        if (egress !== undefined) oRestr.push('egress:' + egress.host);
        assert.deepEqual(v.restrictions, oRestr);
      }
    }
  });
});

void AGENTS;
