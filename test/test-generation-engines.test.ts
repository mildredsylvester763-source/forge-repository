import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { E2E_ACTIONS, planE2eSuite } from '../src/modules/test-generation/engine/e2e-session-replay.ts';
import { FUZZ_FIELD_TYPES, FUZZ_KINDS, runFuzzCampaign } from '../src/modules/test-generation/engine/fuzz-testing.ts';
import { planIntegrationTests } from '../src/modules/test-generation/engine/integration-graph.ts';
import {
  PROPERTY_RUNS_DEFAULT,
  generateIntCases,
  generateStringCases,
  planPropertySuite,
  shrinkInt,
} from '../src/modules/test-generation/engine/property-based.ts';
import { UNIT_KINDS, UNIT_PARAM_TYPES, boundaryCountOf, planUnitTests } from '../src/modules/test-generation/engine/unit-test-generation.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('unit-test-generation engine (FORGE TQ-031)', () => {
  it('plans boundary and behavior cases for a function target', () => {
    const out = planUnitTests({
      target: { name: 'calcPrice', kind: 'function', params: [{ name: 'qty', type: 'number' }] },
      behaviors: [{ name: 'rejects negative qty' }],
    });
    assert.equal(out.ok, true);
    assert.equal(out.target, 'calcPrice');
    assert.equal(out.boundaryCount, 3);
    assert.equal(out.behaviorCount, 1);
    assert.deepEqual(out.cases?.map((c) => c.name), [
      'boundary:qty:number:0',
      'boundary:qty:number:1',
      'boundary:qty:number:2',
      'behavior:rejects negative qty',
    ]);
    assert.equal(out.cases?.[0]?.detail, 'qty = 0');
  });

  it('renders deterministic boundary details for every param type', () => {
    const s = planUnitTests({
      target: { name: 'fmt', kind: 'class', params: [{ name: 'label', type: 'string' }] },
      behaviors: [{ name: 'b' }],
    });
    assert.equal(s.cases?.[1]?.detail, 'label = str(1)');
    assert.equal(s.cases?.[2]?.detail, 'label = str(64)');
    const flags = planUnitTests({
      target: {
        name: 'flags',
        kind: 'function',
        params: [
          { name: 'on', type: 'boolean' },
          { name: 'opts', type: 'object' },
        ],
      },
      behaviors: [{ name: 'b' }],
    });
    assert.deepEqual(
      flags.cases?.filter((c) => c.kind === 'boundary').map((c) => c.name),
      ['boundary:on:boolean:0', 'boundary:on:boolean:1', 'boundary:opts:object:0', 'boundary:opts:object:1'],
    );
    const arr = planUnitTests({
      target: { name: 'f', kind: 'function', params: [{ name: 'items', type: 'array' }] },
      behaviors: [{ name: 'b' }],
    });
    assert.equal(arr.cases?.[2]?.detail, 'items = arr(3)');
  });

  it('exposes the catalogs and refuses bad targets, params and behaviors', () => {
    assert.deepEqual(UNIT_KINDS, ['function', 'class']);
    assert.deepEqual(UNIT_PARAM_TYPES, ['string', 'number', 'boolean', 'array', 'object']);
    assert.equal(planUnitTests({ behaviors: [] }).reason, 'unit-target-missing');
    assert.equal(planUnitTests({ target: { name: ' ', kind: 'function' }, behaviors: [{ name: 'x' }] }).reason, 'unit-target-name-missing');
    assert.equal(planUnitTests({ target: { name: 'f', kind: 'helper' }, behaviors: [{ name: 'x' }] }).reason, 'unit-target-kind-unknown:helper');
    assert.equal(
      planUnitTests({ target: { name: 'f', kind: 'function', params: [{ name: 'm', type: 'map' }] }, behaviors: [{ name: 'x' }] }).reason,
      'unit-param-type-unknown:map',
    );
    assert.equal(
      planUnitTests({
        target: {
          name: 'f',
          kind: 'function',
          params: [
            { name: 'a', type: 'string' },
            { name: 'a', type: 'number' },
          ],
        },
        behaviors: [{ name: 'x' }],
      }).reason,
      'unit-param-duplicate:a',
    );
    assert.equal(
      planUnitTests({
        target: {
          name: 'f',
          kind: 'function',
          params: Array.from({ length: 11 }, (_, i) => ({ name: 'p' + i, type: 'string' })),
        },
        behaviors: [{ name: 'x' }],
      }).reason,
      'unit-params-limit:11',
    );
    assert.equal(planUnitTests({ target: { name: 'f', kind: 'function' }, behaviors: [] }).reason, 'unit-behaviors-empty');
    assert.equal(
      planUnitTests({
        target: { name: 'f', kind: 'function' },
        behaviors: Array.from({ length: 21 }, (_, i) => ({ name: 'b' + i })),
      }).reason,
      'unit-behaviors-limit:21',
    );
    assert.equal(planUnitTests({ target: { name: 'f', kind: 'function' }, behaviors: [{ name: 'z' }, { name: 'z' }] }).reason, 'unit-behavior-duplicate:z');
    assert.equal(planUnitTests({ target: { name: 'f', kind: 'function' }, behaviors: [{ name: '  ' }] }).reason, 'unit-behavior-name-missing');
  });

  it('matches an independent oracle on 500 mulberry32(42) cases', () => {
    const rand = mulberry32(42);
    const TYPES = ['string', 'number', 'boolean', 'array', 'object'];
    for (let c = 0; c < 500; c++) {
      const pcount = Math.floor(rand() * 13);
      const params: Array<{ name: string; type: string }> = [];
      const pnames: string[] = [];
      let dupParam = false;
      for (let i = 0; i < pcount; i++) {
        const nm = 'p' + Math.floor(rand() * 5);
        if (pnames.includes(nm)) dupParam = true;
        pnames.push(nm);
        params.push({ name: nm, type: TYPES[Math.floor(rand() * TYPES.length)]! });
      }
      const bcount = 1 + Math.floor(rand() * 21);
      const behaviors: Array<{ name: string }> = [];
      let dupBeh = false;
      for (let i = 0; i < bcount; i++) {
        const nm = 'b' + Math.floor(rand() * 30);
        if (behaviors.some((b) => b.name === nm)) dupBeh = true;
        behaviors.push({ name: nm });
      }
      const got = planUnitTests({ target: { name: 't' + c, kind: 'function', params }, behaviors });
      let boundary = 0;
      for (const p of params) boundary += boundaryCountOf(p.type);
      let expectOk = true;
      let expectReason = '';
      if (params.length > 10) {
        expectOk = false;
        expectReason = 'unit-params-limit:' + params.length;
      } else if (dupParam) {
        expectOk = false;
        expectReason = 'unit-param-duplicate:';
      } else if (behaviors.length > 20) {
        expectOk = false;
        expectReason = 'unit-behaviors-limit:' + behaviors.length;
      } else if (dupBeh) {
        expectOk = false;
        expectReason = 'unit-behavior-duplicate:';
      }
      assert.equal(got.ok, expectOk);
      if (expectOk) {
        assert.equal(got.cases?.length, boundary + behaviors.length);
        assert.equal(got.boundaryCount, boundary);
      } else {
        assert.ok((got.reason ?? '').includes(expectReason));
      }
    }
  });
});

describe('integration-graph engine (FORGE TQ-032)', () => {
  it('plans a case per unique edge and a topological order', () => {
    const out = planIntegrationTests({
      services: ['billing', 'inventory', 'notify'],
      dependencies: [
        ['billing', 'inventory'],
        ['billing', 'notify'],
        ['inventory', 'notify'],
      ],
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.order, ['billing', 'inventory', 'notify']);
    assert.deepEqual(out.cases?.map((c) => c.name), [
      'integrates:billing->inventory',
      'integrates:billing->notify',
      'integrates:inventory->notify',
    ]);
  });

  it('accepts object services, dedupes edges, and refuses cycles by name', () => {
    const out = planIntegrationTests({
      services: [{ name: 'a' }, { name: 'b' }],
      dependencies: [
        ['a', 'b'],
        ['a', 'b'],
      ],
    });
    assert.equal(out.ok, true);
    assert.equal(out.cases?.length, 1);
    const cyc = planIntegrationTests({
      services: ['a', 'b'],
      dependencies: [
        ['a', 'b'],
        ['b', 'a'],
      ],
    });
    assert.equal(cyc.reason, 'integration-cycle-detected:a->b->a');
  });

  it('refuses empty lists, duplicates, and unknown nodes by name', () => {
    assert.equal(planIntegrationTests({ services: [], dependencies: [['a', 'b']] }).reason, 'integration-services-empty');
    assert.equal(planIntegrationTests({ services: ['a', 'a'], dependencies: [['a', 'a']] }).reason, 'integration-service-duplicate:a');
    assert.equal(planIntegrationTests({ services: ['a'], dependencies: [] }).reason, 'integration-dependencies-empty');
    assert.equal(planIntegrationTests({ services: ['billing'], dependencies: [['billing', 'ghost']] }).reason, 'integration-node-unknown:ghost');
    assert.equal(planIntegrationTests({ services: ['a', ' '], dependencies: [['a', 'a']] }).reason, 'integration-service-name-missing');
  });

  it('matches an independent oracle on 500 mulberry32(42) random graphs', () => {
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rand() * 5);
      const names: string[] = [];
      for (let i = 0; i < n; i++) names.push('s' + i);
      const deps: Array<[string, string]> = [];
      for (let i = 0; i < n * 2; i++) {
        deps.push([names[Math.floor(rand() * n)]!, names[Math.floor(rand() * n)]!]);
      }
      const got = planIntegrationTests({ services: names, dependencies: deps });
      const oracleCases = new Set(deps.map((d) => d[0] + '->' + d[1]));
      const selfLoop = deps.some((d) => d[0] === d[1]);
      if (selfLoop) {
        assert.equal(got.ok, false);
      }
      if (got.ok) {
        assert.equal(got.cases?.length, oracleCases.size);
        assert.ok((got.cases ?? []).every((k) => oracleCases.has(k.from + '->' + k.to)));
        assert.deepEqual([...(got.order ?? [])].sort(), [...names].sort());
      } else {
        assert.ok((got.reason ?? '').includes('integration-cycle-detected:'));
      }
    }
  });
});

describe('e2e-session-replay engine (FORGE TQ-033)', () => {
  it('replays a recorded checkout session with dedupe and assertions', () => {
    const out = planE2eSuite({
      session: { name: 'checkout' },
      steps: [
        { action: 'navigate', target: '/', value: '' },
        { action: 'click', target: 'add-to-cart', value: '' },
        { action: 'click', target: 'add-to-cart', value: '' },
        { action: 'type', target: '#email', value: 'a@b.c' },
        { action: 'assert', target: 'cart badge 1', value: '' },
        { action: 'click', target: 'buy', value: '', checkpoint: true },
      ],
    });
    assert.equal(out.ok, true);
    assert.equal(out.session, 'checkout');
    assert.equal(out.steps?.length, 5);
    assert.equal(out.deduped, 1);
    assert.deepEqual(out.assertions?.map((a) => a.name), ['assert:cart badge 1', 'checkpoint:after:click:5']);
    assert.deepEqual(out.assertions?.map((a) => a.kind), ['explicit', 'checkpoint']);
    assert.deepEqual(out.steps?.[2], { action: 'type', target: '#email', value: 'a@b.c' });
  });

  it('exposes the action catalog and refuses invalid sessions by name', () => {
    assert.deepEqual(E2E_ACTIONS, ['navigate', 'click', 'type', 'wait', 'assert']);
    assert.equal(planE2eSuite({ session: { name: ' ' }, steps: [{ action: 'click', target: 'x' }] }).reason, 'e2e-session-name-missing');
    assert.equal(planE2eSuite({ session: { name: 's' }, steps: [{ action: 'scroll', target: 'x' }] }).reason, 'e2e-action-unknown:scroll');
    assert.equal(planE2eSuite({ session: { name: 's' }, steps: [] }).reason, 'e2e-steps-empty');
    assert.equal(
      planE2eSuite({ session: { name: 's' }, steps: Array.from({ length: 201 }, () => ({ action: 'wait', target: 'x' })) }).reason,
      'e2e-steps-limit:201',
    );
  });

  it('matches an independent oracle on 500 mulberry32(42) random sessions', () => {
    const rand = mulberry32(42);
    const actions = ['navigate', 'click', 'type', 'wait', 'assert'];
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rand() * 12);
      const steps: Array<{ action: string; target: string; checkpoint?: boolean }> = [];
      for (let i = 0; i < n; i++) {
        const a = actions[Math.floor(rand() * actions.length)]!;
        steps.push({ action: a, target: 't' + Math.floor(rand() * 3), checkpoint: rand() < 0.2 && a !== 'assert' });
      }
      const got = planE2eSuite({ session: { name: 's' + c }, steps });
      const oracleSteps: Array<{ action: string; target: string; value: string }> = [];
      let dedupe = 0;
      for (const s of steps) {
        const norm = { action: s.action, target: s.target, value: '' };
        const prev = oracleSteps[oracleSteps.length - 1];
        if (prev && prev.action === norm.action && prev.target === norm.target && prev.value === norm.value) {
          dedupe++;
        } else {
          oracleSteps.push(norm);
        }
      }
      assert.equal(got.ok, true);
      assert.equal(got.steps?.length, oracleSteps.length);
      assert.equal(got.deduped, dedupe);
      let explicit = 0;
      for (const os of oracleSteps) {
        if (os.action === 'assert') explicit++;
      }
      let checkpoint = 0;
      for (let i = 0; i < steps.length; i++) {
        const step: { action: string; target: string; checkpoint?: boolean } = steps[i]!;
        if (step.checkpoint && step.action !== 'assert') {
          const prev = i > 0 ? steps[i - 1] : undefined;
          const wasDeduped = prev !== undefined && prev.action === step.action && prev.target === step.target;
          if (!wasDeduped) checkpoint++;
        }
      }
      assert.equal(got.assertions?.filter((a) => a.kind === 'explicit').length, explicit);
      assert.equal(got.assertions?.filter((a) => a.kind === 'checkpoint').length, checkpoint);
    }
  });
});

describe('property-based engine (FORGE TQ-034)', () => {
  it('plans reproducible property suites with defaults', () => {
    const out = planPropertySuite({ name: 'sorts idempotently' });
    assert.deepEqual(out, {
      ok: true,
      name: 'sorts idempotently',
      runs: PROPERTY_RUNS_DEFAULT,
      seed: 42,
      repro: 'property:sorts idempotently seed:42 runs:100',
    });
    const custom = planPropertySuite({ name: 'p', runs: 5, seed: 7 });
    assert.equal(custom.repro, 'property:p seed:7 runs:5');
    assert.equal(planPropertySuite({}).reason, 'property-name-missing');
    assert.equal(planPropertySuite({ name: 'x'.repeat(201) }).reason, 'property-name-too-long');
    assert.equal(planPropertySuite({ name: 'x', runs: 0 }).reason, 'property-runs-invalid:0');
    assert.equal(planPropertySuite({ name: 'x', runs: 1001 }).reason, 'property-runs-invalid:1001');
    assert.equal(planPropertySuite({ name: 'x', seed: -1 }).reason, 'property-seed-invalid:-1');
  });

  it('generates deterministic inclusive int cases', () => {
    const out = generateIntCases({ seed: 42, runs: 5, min: 0, max: 9 });
    assert.deepEqual(out.cases, [6, 4, 8, 6, 1]);
    const again = generateIntCases({ seed: 42, runs: 5, min: 0, max: 9 });
    assert.deepEqual(again.cases, out.cases);
    const offset = generateIntCases({ seed: 42, runs: 5, min: 10, max: 19 });
    assert.deepEqual(offset.cases, [16, 14, 18, 16, 11]);
    assert.equal(generateIntCases({ seed: 1, runs: 3, min: 5, max: 4 }).reason, 'property-range-invalid:5:4');
  });

  it('generates deterministic string cases with custom alphabets', () => {
    const out = generateStringCases({ seed: 42, runs: 3, alphabet: 'ab', maxLen: 4 });
    assert.deepEqual(out.cases, ['abb', 'b', 'bb']);
    const def = generateStringCases({ seed: 42, runs: 2, maxLen: 3 });
    assert.ok((def.cases ?? []).every((s) => /^[a-z]+$/.test(s) && s.length <= 3));
    assert.equal(generateStringCases({ seed: 1, runs: 2, maxLen: 0 }).reason, 'property-length-invalid:0');
    assert.equal(generateStringCases({ seed: 1, runs: 2, maxLen: 1001 }).reason, 'property-length-invalid:1001');
  });

  it('shrinks failures to the smallest failing input for upward-closed predicates', () => {
    assert.equal(shrinkInt((v) => v >= 10, 100), 10);
    assert.equal(shrinkInt((v) => v >= 0, 57), 0);
    assert.equal(shrinkInt(() => false, 100), 100);
    assert.equal(shrinkInt((v) => v >= 100, 100), 100);
  });

  it('matches an independent oracle on 500 mulberry32(42) case streams', () => {
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const isInt = rand() < 0.5;
      const runs = 1 + Math.floor(rand() * 10);
      const seed = Math.floor(rand() * 1000);
      if (isInt) {
        const min = Math.floor(rand() * 6);
        const max = min + Math.floor(rand() * 10);
        const got = generateIntCases({ seed, runs, min, max });
        const o = mulberry32(seed);
        const oracle: number[] = [];
        for (let i = 0; i < runs; i++) oracle.push(min + Math.floor(o() * (max - min + 1)));
        assert.equal(got.ok, true);
        assert.deepEqual(got.cases, oracle);
        assert.ok((got.cases ?? []).every((v) => v >= min && v <= max));
      } else {
        const maxLen = 1 + Math.floor(rand() * 10);
        const got = generateStringCases({ seed, runs, alphabet: 'abc', maxLen });
        const o = mulberry32(seed);
        const oracle: string[] = [];
        for (let i = 0; i < runs; i++) {
          const len = 1 + Math.floor(o() * maxLen);
          let s = '';
          for (let j = 0; j < len; j++) s += 'abc'.charAt(Math.floor(o() * 3));
          oracle.push(s);
        }
        assert.equal(got.ok, true);
        assert.deepEqual(got.cases, oracle);
        assert.ok((got.cases ?? []).every((s) => /^[abc]+$/.test(s) && s.length <= maxLen));
      }
    }
  });
});

describe('fuzz-testing engine (FORGE TQ-035)', () => {
  it('generates grammar cases with required fields always present', () => {
    const out = runFuzzCampaign({
      kind: 'api',
      fields: [
        { name: 'email', type: 'string', required: true },
        { name: 'age', type: 'int' },
      ],
      budget: 3,
      seed: 42,
    });
    assert.equal(out.ok, true);
    assert.equal(out.kind, 'api');
    assert.deepEqual(out.cases, [
      { index: 0, input: { email: 'lwrenhqw', age: 249 } },
      { index: 1, input: { email: 'thfnrpamvbp' } },
      { index: 2, input: { email: 'beun' } },
    ]);
    const again = runFuzzCampaign({
      kind: 'api',
      fields: [
        { name: 'email', type: 'string', required: true },
        { name: 'age', type: 'int' },
      ],
      budget: 3,
      seed: 42,
    });
    assert.deepEqual(again.cases, out.cases);
  });

  it('mutates known-good samples with named mutations', () => {
    const out = runFuzzCampaign({ kind: 'parser', samples: ['hello'], budget: 2, seed: 42 });
    assert.deepEqual(out.cases, [
      { index: 0, input: { mutated: 'hellro' }, origin: 'hello', mutation: 'insert:4' },
      { index: 1, input: { mutated: 'heello' }, origin: 'hello', mutation: 'duplicate:1' },
    ]);
    const dup = runFuzzCampaign({ kind: 'format', samples: ['hello'], budget: 2, seed: 42 });
    assert.deepEqual(dup.cases, out.cases);
  });

  it('exposes catalogs and refuses bad campaigns by name', () => {
    assert.deepEqual(FUZZ_KINDS, ['api', 'parser', 'format']);
    assert.deepEqual(FUZZ_FIELD_TYPES, ['string', 'int', 'bool', 'uuid']);
    assert.equal(runFuzzCampaign({}).reason, 'fuzz-kind-missing');
    assert.equal(runFuzzCampaign({ kind: 'ui', samples: ['x'] }).reason, 'fuzz-kind-unknown:ui');
    assert.equal(runFuzzCampaign({ kind: 'api', samples: ['x'], budget: 0 }).reason, 'fuzz-budget-invalid:0');
    assert.equal(runFuzzCampaign({ kind: 'api', samples: ['x'], budget: 1001 }).reason, 'fuzz-budget-invalid:1001');
    assert.equal(runFuzzCampaign({ kind: 'api', samples: ['x'], seed: -1 }).reason, 'fuzz-seed-invalid:-1');
    assert.equal(runFuzzCampaign({ kind: 'api' }).reason, 'fuzz-input-missing');
    assert.equal(runFuzzCampaign({ kind: 'api', fields: [] }).reason, 'fuzz-fields-empty');
    assert.equal(runFuzzCampaign({ kind: 'api', fields: [{ name: ' ', type: 'string' }] }).reason, 'fuzz-field-name-missing');
    assert.equal(runFuzzCampaign({ kind: 'api', fields: [{ name: 'a', type: 'float' }] }).reason, 'fuzz-field-type-unknown:float');
    assert.equal(
      runFuzzCampaign({
        kind: 'api',
        fields: [
          { name: 'a', type: 'string' },
          { name: 'a', type: 'int' },
        ],
      }).reason,
      'fuzz-field-duplicate:a',
    );
    assert.equal(runFuzzCampaign({ kind: 'parser', samples: [] }).reason, 'fuzz-samples-empty');
    assert.equal(runFuzzCampaign({ kind: 'parser', samples: [''] }).reason, 'fuzz-sample-invalid');
    assert.equal(runFuzzCampaign({ kind: 'parser', samples: [42] }).reason, 'fuzz-sample-invalid');
  });

  it('matches an independent oracle on 500 mulberry32(42) campaigns', () => {
    const rand = mulberry32(42);
    const types = ['string', 'int', 'bool', 'uuid'];
    for (let c = 0; c < 500; c++) {
      const seed = Math.floor(rand() * 1000);
      const budget = 1 + Math.floor(rand() * 12);
      const grammar = rand() < 0.5;
      if (grammar) {
        const fcount = 1 + Math.floor(rand() * 4);
        const fields: Array<{ name: string; type: string; required?: boolean }> = [];
        for (let i = 0; i < fcount; i++) {
          fields.push({
            name: 'f' + i,
            type: types[Math.floor(rand() * types.length)]!,
            required: rand() < 0.5,
          });
        }
        const got = runFuzzCampaign({ kind: 'api', fields, budget, seed });
        const rerun = runFuzzCampaign({ kind: 'api', fields, budget, seed });
        assert.equal(got.ok, true);
        assert.equal(got.cases?.length, budget);
        assert.deepEqual(got.cases, rerun.cases);
        for (const f of fields) {
          if (f.required) {
            assert.ok((got.cases ?? []).every((k) => k.input[f.name] !== undefined));
          }
        }
        for (const k of got.cases ?? []) {
          assert.ok(k.index < budget);
          if (k.input.f0 !== undefined && fields[0]!.type === 'string') {
            assert.equal(typeof k.input.f0, 'string');
          }
        }
      } else {
        const samples = ['abc', 'Hello', 'xy'];
        const got = runFuzzCampaign({ kind: 'parser', samples, budget, seed });
        const rerun = runFuzzCampaign({ kind: 'parser', samples, budget, seed });
        assert.equal(got.ok, true);
        assert.equal(got.cases?.length, budget);
        assert.deepEqual(got.cases, rerun.cases);
        for (const k of got.cases ?? []) {
          assert.ok(samples.includes(k.origin ?? ''));
          assert.equal(typeof k.input.mutated, 'string');
          assert.match(k.mutation ?? '', /^(delete|insert|duplicate|flip):\d+$/);
          const len = (k.input.mutated as string).length;
          const olen = (k.origin as string).length;
          assert.ok(len >= olen - 1 && len <= olen + 1);
        }
      }
    }
  });
});
