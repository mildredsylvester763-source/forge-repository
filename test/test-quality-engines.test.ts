import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { MATRIX_BROWSERS, MATRIX_PLATFORMS, MATRIX_VIEWPORTS, planMatrix, scoreMatrix, type MatrixCombo } from '../src/modules/test-quality/engine/browser-matrix.ts';
import { buildPact, verifyContract } from '../src/modules/test-quality/engine/contract-testing.ts';
import { MUTATION_OPERATORS, planMutants, scoreMutants, type Mutant } from '../src/modules/test-quality/engine/mutation-testing.ts';
import { SNAPSHOT_MODES, SNAPSHOT_NAME_RE, manageSnapshot, serializeSnapshot } from '../src/modules/test-quality/engine/snapshot-testing.ts';
import { diffImages } from '../src/modules/test-quality/engine/visual-regression.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('mutation-testing engine (FORGE TQ-036)', () => {
  it('plans one mutant per line per operator with the pinned vector', () => {
    const plan = planMutants({ source: ['const a = 1 + 2;', 'if (a > 3) { return true; }'] });
    assert.equal(plan.ok, true);
    assert.equal(plan.count, 5);
    assert.deepEqual(plan.mutants?.map((m) => m.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
    assert.deepEqual(plan.mutants?.map((m) => m.operator), [
      'arith-swap',
      'number-zero',
      'flip-boolean',
      'comparison-shift',
      'number-zero',
    ]);
    assert.equal(plan.mutants?.[0]?.mutated, 'const a = 1 - 2;');
    assert.equal(plan.mutants?.[1]?.mutated, 'const a = 0 + 2;');
    assert.equal(plan.mutants?.[2]?.mutated, 'if (a > 3) { return false; }');
    assert.equal(plan.mutants?.[3]?.mutated, 'if (a >= 3) { return true; }');
    assert.equal(plan.mutants?.[4]?.mutated, 'if (a > 0) { return true; }');
  });

  it('scores detected over total against the threshold', () => {
    const plan = planMutants({ source: ['const a = 1 + 2;', 'if (a > 3) { return true; }'] });
    const mutants = (plan.mutants ?? []) as Mutant[];
    const report = scoreMutants({
      mutants,
      results: { m1: 'killed', m2: 'survived', m3: 'timeout', m4: 'killed', m5: 'survived' },
    });
    assert.equal(report.score, 60);
    assert.equal(report.detected, 3);
    assert.equal(report.passed, false);
    const tight = scoreMutants({
      mutants,
      results: { m1: 'killed', m2: 'killed', m3: 'killed', m4: 'killed', m5: 'survived' },
      threshold: 60,
    });
    assert.equal(tight.score, 80);
    assert.equal(tight.passed, true);
  });

  it('refuses invalid inputs with named reasons', () => {
    assert.equal(planMutants({ source: [] }).reason, 'mutation-source-empty');
    assert.equal(planMutants({ source: ['ok = 1;', 42] }).reason, 'mutation-line-missing:2');
    assert.equal(planMutants({ source: ['ok = 1;'], operators: ['dance'] }).reason, 'mutation-operator-unknown:dance');
    assert.equal(planMutants({ source: ['ok = 1;'], operators: 'flip-boolean' }).reason, 'mutation-operators-invalid');
    assert.equal(scoreMutants({ mutants: [], results: {} }).reason, 'mutation-mutants-empty');
    assert.equal(scoreMutants({ mutants: [{ id: 'm1' }], results: ['killed'] }).reason, 'mutation-results-invalid');
    assert.equal(scoreMutants({ mutants: [{ id: 'm1' }], results: { m9: 'killed' } }).reason, 'mutation-mutant-unknown:m9');
    assert.equal(scoreMutants({ mutants: [{ id: 'm1' }], results: {} }).reason, 'mutation-result-missing:m1');
    assert.equal(scoreMutants({ mutants: [{ id: 'm1' }], results: { m1: 'zombie' } }).reason, 'mutation-state-invalid:zombie:m1');
    assert.equal(scoreMutants({ mutants: [{ id: 'm1' }], results: { m1: 'killed' }, threshold: 101 }).reason, 'mutation-threshold-invalid:101');
  });

  it('matches an independent split-based oracle on 500 mulberry32(42) cases', () => {
    const rand = mulberry32(42);
    const vars = ['a', 'b', 'count', 'total', 'x'];
    const nums = ['0', '1', '2', '10', '42', '100'];
    const strs = ["'hello'", "'world'", '"done"', ''];
    const oracleGuardedIdx = (line: string, ch: string): number => {
      const parts = line.split(ch);
      for (let i = 0; i < parts.length - 1; i++) {
        const before = parts[i]!;
        const after = parts[i + 1]!;
        const prev = before.length > 0 ? before[before.length - 1] : '';
        const next = after.length > 0 ? after[0] : '';
        if (prev === ch || next === ch || next === '=') continue;
        return before.length;
      }
      return -1;
    };
    const oracleApply = (line: string, op: string): string | null => {
      if (op === 'flip-boolean') {
        if (line.includes('true')) {
          const i = line.indexOf('true');
          return line.slice(0, i) + 'false' + line.slice(i + 4);
        }
        if (line.includes('false')) {
          const i = line.indexOf('false');
          return line.slice(0, i) + 'true' + line.slice(i + 5);
        }
        return null;
      }
      if (op === 'arith-swap') {
        const swaps: Array<[string, string]> = [
          ['+', '-'],
          ['-', '+'],
          ['*', '/'],
          ['/', '*'],
        ];
        for (const [from, to] of swaps) {
          const idx = oracleGuardedIdx(line, from);
          if (idx >= 0) return line.slice(0, idx) + to + line.slice(idx + 1);
        }
        return null;
      }
      if (op === 'comparison-shift') {
        if (line.includes('<=')) {
          const i = line.indexOf('<=');
          return line.slice(0, i) + '<' + line.slice(i + 2);
        }
        if (line.includes('>=')) {
          const i = line.indexOf('>=');
          return line.slice(0, i) + '>' + line.slice(i + 2);
        }
        const lt = line.indexOf('<');
        if (lt >= 0 && line[lt + 1] !== '=') return line.slice(0, lt) + '<=' + line.slice(lt + 1);
        const gt = line.indexOf('>');
        if (gt >= 0 && line[gt + 1] !== '=') return line.slice(0, gt) + '>=' + line.slice(gt + 1);
        return null;
      }
      if (op === 'number-zero') {
        const re = /\d+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          if (/[1-9]/.test(m[0])) return line.slice(0, m.index) + '0' + line.slice(m.index + m[0].length);
        }
        return null;
      }
      if (op === 'string-empty') {
        if (/'[^']+'/.test(line)) return line.replace(/'[^']+'/, "''");
        if (/"[^"]+"/.test(line)) return line.replace(/"[^"]+"/, '""');
        return null;
      }
      if (op === 'logical-swap') {
        if (line.includes('&&')) {
          const i = line.indexOf('&&');
          return line.slice(0, i) + '||' + line.slice(i + 2);
        }
        if (line.includes('||')) {
          const i = line.indexOf('||');
          return line.slice(0, i) + '&&' + line.slice(i + 2);
        }
        return null;
      }
      return null;
    };
    for (let c = 0; c < 500; c++) {
      const lineCount = 1 + Math.floor(rand() * 3);
      const lines: string[] = [];
      for (let l = 0; l < lineCount; l++) {
        let s = 'const ' + vars[Math.floor(rand() * vars.length)] + ' = ';
        const kind = Math.floor(rand() * 7);
        if (kind === 0) s += nums[Math.floor(rand() * nums.length)] + ' + ' + nums[Math.floor(rand() * nums.length)] + ';';
        else if (kind === 1) s += nums[Math.floor(rand() * nums.length)] + ' - ' + nums[Math.floor(rand() * nums.length)] + ';';
        else if (kind === 2) s += nums[Math.floor(rand() * nums.length)] + ' * ' + nums[Math.floor(rand() * nums.length)] + ';';
        else if (kind === 3) s += nums[Math.floor(rand() * nums.length)] + ' / ' + nums[Math.floor(rand() * nums.length)] + ';';
        else if (kind === 4) {
          const st = strs[Math.floor(rand() * strs.length)]!;
          s += st.length > 0 ? st + ';' : "'';";
        } else if (kind === 5) s += (rand() < 0.5 ? 'true' : 'false') + ';';
        else s += nums[Math.floor(rand() * nums.length)] + ';';
        if (rand() < 0.4) {
          s =
            'if (' +
            vars[Math.floor(rand() * vars.length)] +
            ' ' +
            ['<', '>', '<=', '>='][Math.floor(rand() * 4)] +
            ' ' +
            nums[Math.floor(rand() * nums.length)] +
            ') { ' +
            s +
            ' }';
        }
        if (rand() < 0.3) s = 'if (flag && ' + (rand() < 0.5 ? 'ready || done' : 'ok') + ') { ' + s + ' }';
        lines.push(s);
      }
      const verdict = planMutants({ source: lines });
      assert.equal(verdict.ok, true);
      const expected: Mutant[] = [];
      for (let li = 0; li < lines.length; li++) {
        for (const op of MUTATION_OPERATORS) {
          const om = oracleApply(lines[li]!, op);
          if (om !== null && om !== lines[li]) {
            expected.push({
              id: 'm' + (expected.length + 1),
              line: li + 1,
              operator: op,
              original: lines[li]!,
              mutated: om,
            });
          }
        }
      }
      assert.deepEqual(verdict.mutants, expected);
      if (expected.length === 0) {
        assert.equal(scoreMutants({ mutants: verdict.mutants, results: {} }).reason, 'mutation-mutants-empty');
        continue;
      }
      const results: Record<string, string> = {};
      let ek = 0;
      let et = 0;
      for (const m of expected) {
        const r = rand();
        const state = r < 0.5 ? 'killed' : r < 0.8 ? 'survived' : 'timeout';
        results[m.id] = state;
        if (state === 'killed') ek++;
        else if (state === 'timeout') et++;
      }
      const threshold = Math.floor(rand() * 101);
      const report = scoreMutants({ mutants: expected, results, threshold });
      const expScore = Number((((ek + et) / expected.length) * 100).toFixed(2));
      assert.equal(report.score, expScore);
      assert.equal(report.passed, expScore >= threshold);
    }
  });
});

describe('contract-testing engine (FORGE TQ-037)', () => {
  it('builds a normalized pact from raw interactions', () => {
    const pact = buildPact({
      consumer: 'web-shop',
      provider: 'billing',
      interactions: [
        {
          description: 'get invoice',
          request: { method: 'GET', path: 'api/invoices/7' },
          response: { status: 200, body: { id: 7, total: 90 } },
        },
        {
          description: 'create payment',
          request: { method: 'post', path: '//api//payments' },
          response: { status: 201, body: { status: 'paid', tags: ['a'] } },
        },
      ],
    });
    assert.equal(pact.ok, true);
    assert.equal(pact.count, 2);
    assert.equal(pact.interactions?.[0]?.request.path, '/api/invoices/7');
    assert.equal(pact.interactions?.[1]?.request.method, 'POST');
    assert.equal(pact.interactions?.[1]?.request.path, '/api/payments');
  });

  it('verifies pacts against provider responses with subset bodies', () => {
    const verified = verifyContract({
      consumer: 'web-shop',
      provider: 'billing',
      interactions: [
        {
          description: 'get invoice',
          request: { method: 'GET', path: '/api/invoices/7' },
          response: { status: 200, body: { id: 7, total: 90 } },
        },
        {
          description: 'create payment',
          request: { method: 'POST', path: '/api/payments' },
          response: { status: 201, body: { status: 'paid', tags: ['a'] } },
        },
      ],
      providerResponses: [
        { method: 'get', path: '/api/invoices/7', status: 200, body: { id: 7, total: 90, currency: 'USD' } },
        { method: 'POST', path: '/api/payments', status: 201, body: { status: 'paid', tags: ['a'], fee: 3 } },
      ],
    });
    assert.equal(verified.ok, true);
    assert.equal(verified.verified, 2);
    assert.equal(
      verifyContract({
        consumer: 'c',
        provider: 'p',
        interactions: [
          { description: 'x', request: { method: 'GET', path: '/a' }, response: { status: 200, body: { total: 90 } } },
        ],
        providerResponses: [{ method: 'GET', path: '/a', status: 500, body: { total: 90 } }],
      }).reason,
      'contract-status-mismatch:1:200:500',
    );
    assert.equal(
      verifyContract({
        consumer: 'c',
        provider: 'p',
        interactions: [
          { description: 'x', request: { method: 'GET', path: '/a' }, response: { status: 200, body: { total: 90 } } },
        ],
        providerResponses: [{ method: 'GET', path: '/a', status: 200, body: { total: 91, extra: 1 } }],
      }).reason,
      'contract-body-mismatch:1:$.total',
    );
    assert.equal(
      verifyContract({
        consumer: 'c',
        provider: 'p',
        interactions: [
          { description: 'x', request: { method: 'GET', path: '/a' }, response: { status: 200, body: { list: ['a', 'b'] } } },
        ],
        providerResponses: [{ method: 'GET', path: '/a', status: 200, body: { list: ['a', 'x'] } }],
      }).reason,
      'contract-body-mismatch:1:$.list[1]',
    );
    assert.equal(
      verifyContract({
        consumer: 'c',
        provider: 'p',
        interactions: [
          { description: 'x', request: { method: 'POST', path: '/api/orders' }, response: { status: 201 } },
        ],
        providerResponses: [{ method: 'GET', path: '/a', status: 200 }],
      }).reason,
      'contract-route-missing:1:POST:/api/orders',
    );
  });

  it('refuses invalid pacts and responses with named reasons', () => {
    assert.equal(
      buildPact({
        consumer: '',
        provider: 'p',
        interactions: [{ description: 'x', request: { method: 'GET', path: '/a' }, response: { status: 200 } }],
      }).reason,
      'contract-consumer-missing',
    );
    assert.equal(buildPact({ consumer: 'c', provider: 'p', interactions: [] }).reason, 'contract-interactions-empty');
    assert.equal(
      buildPact({
        consumer: 'c',
        provider: 'p',
        interactions: [{ description: '', request: { method: 'GET', path: '/a' }, response: { status: 200 } }],
      }).reason,
      'contract-description-missing:1',
    );
    assert.equal(
      buildPact({
        consumer: 'c',
        provider: 'p',
        interactions: [{ description: 'x', request: { method: '', path: '/a' }, response: { status: 200 } }],
      }).reason,
      'contract-method-missing:1',
    );
    assert.equal(
      buildPact({
        consumer: 'c',
        provider: 'p',
        interactions: [{ description: 'x', request: { method: 'GET', path: '' }, response: { status: 200 } }],
      }).reason,
      'contract-path-missing:1',
    );
    assert.equal(
      buildPact({
        consumer: 'c',
        provider: 'p',
        interactions: [{ description: 'x', request: { method: 'GET', path: '/a' }, response: { status: 99 } }],
      }).reason,
      'contract-status-invalid:1:99',
    );
    assert.equal(
      buildPact({
        consumer: 'c',
        provider: 'p',
        interactions: [{ description: 'x', request: { method: 'GET', path: '/a' } }],
      }).reason,
      'contract-status-missing:1',
    );
    assert.equal(
      verifyContract({
        consumer: 'c',
        provider: 'p',
        interactions: [{ description: 'x', request: { method: 'GET', path: '/a' }, response: { status: 200 } }],
        providerResponses: [],
      }).reason,
      'contract-responses-missing',
    );
    assert.equal(
      verifyContract({
        consumer: 'c',
        provider: 'p',
        interactions: [{ description: 'x', request: { method: 'GET', path: '/a' }, response: { status: 200 } }],
        providerResponses: [{ method: '', path: '/a', status: 200 }],
      }).reason,
      'contract-response-method-missing:1',
    );
    assert.equal(
      verifyContract({
        consumer: 'c',
        provider: 'p',
        interactions: [{ description: 'x', request: { method: 'GET', path: '/a' }, response: { status: 200 } }],
        providerResponses: [{ method: 'GET', path: '/a' }],
      }).reason,
      'contract-response-status-missing:1',
    );
  });

  it('matches an independent queue oracle on 500 mulberry32(42) cases', () => {
    const rand = mulberry32(42);
    const methods = ['GET', 'POST', 'PUT', 'DELETE'];
    const segs = ['users', 'orders', 'items', 'invoices', 'payments'];
    const statuses = [200, 201, 404, 500];
    const oracleSubset = (expected: unknown, actual: unknown): string | null => {
      if (expected === undefined) return null;
      const queue: Array<{ e: unknown; a: unknown; p: string }> = [{ e: expected, a: actual, p: '$' }];
      while (queue.length > 0) {
        const item = queue.shift() as { e: unknown; a: unknown; p: string };
        const e = item.e;
        const a = item.a;
        const p = item.p;
        if (e === undefined) continue;
        if (a === undefined) return p;
        if (Array.isArray(e)) {
          if (!Array.isArray(a) || a.length !== e.length) return p;
          for (let i = 0; i < e.length; i++) queue.push({ e: e[i], a: a[i], p: p + '[' + i + ']' });
        } else if (e !== null && typeof e === 'object') {
          if (a === null || typeof a !== 'object' || Array.isArray(a)) return p;
          const eo = e as Record<string, unknown>;
          const ao = a as Record<string, unknown>;
          for (const k of Object.keys(eo)) {
            const child = p === '$' ? '$.' + k : p + '.' + k;
            if (!(k in ao)) return child;
            queue.push({ e: eo[k], a: ao[k], p: child });
          }
        } else if (e !== a) return p;
      }
      return null;
    };
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rand() * 3);
      const interactions: Array<{
        description: string;
        request: { method: string; path: string };
        response: { status: number; body?: unknown };
      }> = [];
      for (let i = 0; i < n; i++) {
        const method = methods[Math.floor(rand() * methods.length)]!;
        const path =
          (rand() < 0.3 ? '' : '/') +
          'api/' +
          segs[Math.floor(rand() * segs.length)] +
          (rand() < 0.3 ? '/' + String(1 + Math.floor(rand() * 9)) : '');
        const status = statuses[Math.floor(rand() * statuses.length)]!;
        const bodyKind = Math.floor(rand() * 4);
        let body: unknown;
        if (bodyKind === 0) body = { id: Math.floor(rand() * 100), name: 'n' + Math.floor(rand() * 10) };
        else if (bodyKind === 1)
          body = { list: ['a', 'b', 'c'].slice(0, 1 + Math.floor(rand() * 3)), ok: rand() < 0.5 };
        else if (bodyKind === 2) body = { nested: { deep: { value: Math.floor(rand() * 50) } } };
        interactions.push({
          description: 'd' + i,
          request: { method, path },
          response: { status, body },
        });
      }
      const providerResponses: Array<{ method: string; path: string; status: number; body?: unknown }> = [];
      const perturb = Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        const inter = interactions[i]!;
        let method = inter.request.method;
        let path = inter.request.path;
        if (rand() < 0.25) path = '/' + path;
        if (rand() < 0.15) method = method.toLowerCase();
        let body: unknown = inter.response.body;
        if (i === perturb) {
          const kind = Math.floor(rand() * 4);
          if (kind === 0) {
            providerResponses.push({
              method,
              path,
              status: statuses[Math.floor(rand() * statuses.length)]!,
              body,
            });
            continue;
          }
          if (kind === 1 && body !== undefined) body = JSON.parse(JSON.stringify(body).replace(/"value":\d+/, '"value":99999'));
          else if (kind === 2) path = '/api/nowhere';
          else if (kind === 3) body = undefined;
        } else if (body !== undefined) {
          const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
          copy.extraKey = 'x';
          body = copy;
        }
        providerResponses.push({ method, path, status: inter.response.status, body });
      }
      const verdict = verifyContract({
        consumer: 'c' + c,
        provider: 'p' + c,
        interactions,
        providerResponses,
      });
      let expOk = true;
      let expReason = '';
      for (let i = 0; i < n; i++) {
        const inter = interactions[i]!;
        const nm = inter.request.method.toUpperCase();
        let np = inter.request.path.replace(/\/{2,}/g, '/');
        if (!np.startsWith('/')) np = '/' + np;
        const route = providerResponses.find((r) => {
          let rp = r.path.replace(/\/{2,}/g, '/');
          if (!rp.startsWith('/')) rp = '/' + rp;
          return r.method.toUpperCase() === nm && rp === np;
        });
        if (!route) {
          expOk = false;
          expReason = 'contract-route-missing:' + (i + 1) + ':' + nm + ':' + np;
          break;
        }
        if (route.status !== inter.response.status) {
          expOk = false;
          expReason = 'contract-status-mismatch:' + (i + 1) + ':' + inter.response.status + ':' + route.status;
          break;
        }
        const mm = oracleSubset(inter.response.body, route.body);
        if (mm !== null) {
          expOk = false;
          expReason = 'contract-body-mismatch:' + (i + 1) + ':' + mm;
          break;
        }
      }
      assert.equal(verdict.ok, expOk);
      if (!expOk) assert.equal(verdict.reason ?? '', expReason);
    }
  });
});

describe('snapshot-testing engine (FORGE TQ-038)', () => {
  it('writes canonical snapshots with checksums', () => {
    const written = manageSnapshot({ name: 'order-summary', mode: 'write', value: { b: 2, a: [1, 2] } });
    assert.equal(written.ok, true);
    assert.equal(written.status, 'written');
    assert.equal(written.serialized, '{\n  "a": [\n    1,\n    2\n  ],\n  "b": 2\n}');
    assert.equal(written.lines, 7);
    assert.equal(written.checksum, '25b2a167');
    assert.deepEqual(SNAPSHOT_MODES, ['write', 'verify', 'update']);
    assert.equal(SNAPSHOT_NAME_RE.test('order-summary'), true);
    assert.equal(SNAPSHOT_NAME_RE.test('Bad Name!'), false);
  });

  it('verifies stored snapshots and reports the first differing line', () => {
    const written = manageSnapshot({ name: 'order-summary', mode: 'write', value: { b: 2, a: [1, 2] } });
    const serialized = written.serialized ?? '';
    const match = manageSnapshot({ name: 'order-summary', mode: 'verify', value: { b: 2, a: [1, 2] }, stored: serialized });
    assert.equal(match.ok, true);
    assert.equal(match.status, 'match');
    const changed = manageSnapshot({
      name: 'order-summary',
      mode: 'verify',
      value: { b: 2, a: [1, 3] },
      stored: serialized,
    });
    assert.equal(changed.ok, false);
    assert.equal(changed.reason, 'snapshot-mismatch:order-summary');
    assert.equal(changed.firstDiffLine, 4);
    const updated = manageSnapshot({
      name: 'order-summary',
      mode: 'update',
      value: { b: 3, a: [] },
      stored: serialized,
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.status, 'updated');
    assert.equal(updated.serialized, '{\n  "a": [],\n  "b": 3\n}');
  });

  it('refuses invalid snapshot operations with named reasons', () => {
    assert.equal(manageSnapshot({ mode: 'write', value: 1 }).reason, 'snapshot-name-missing');
    assert.equal(manageSnapshot({ name: 'Bad Name!', mode: 'write', value: 1 }).reason, 'snapshot-name-invalid:Bad Name!');
    assert.equal(manageSnapshot({ name: 'x', value: 1 }).reason, 'snapshot-mode-missing');
    assert.equal(manageSnapshot({ name: 'x', mode: 'delete', value: 1 }).reason, 'snapshot-mode-unknown:delete');
    assert.equal(manageSnapshot({ name: 'x', mode: 'write' }).reason, 'snapshot-value-missing');
    assert.equal(manageSnapshot({ name: 'x', mode: 'write', value: 1, stored: '{}' }).reason, 'snapshot-exists:x');
    assert.equal(manageSnapshot({ name: 'x', mode: 'verify', value: 1 }).reason, 'snapshot-missing:x');
    assert.equal(manageSnapshot({ name: 'x', mode: 'verify', value: 1, stored: 42 }).reason, 'snapshot-stored-invalid');
    assert.equal(manageSnapshot({ name: 'x', mode: 'update', value: 1 }).reason, 'snapshot-missing:x');
  });

  it('matches an independent checksum oracle on 500 mulberry32(42) cases', () => {
    const rand = mulberry32(42);
    const oracleFnv = (text: string): string => {
      const F = 16777619;
      const Fh = F >>> 16;
      const Fl = F & 0xffff;
      let h = 0x811c9dc5;
      for (const ch of text) {
        h = (h ^ ch.charCodeAt(0)) >>> 0;
        const low = h & 0xffff;
        const high = h >>> 16;
        const mid = (high * Fl + low * Fh) % 65536;
        h = (mid * 65536 + low * Fl) % 4294967296;
      }
      return h.toString(16).padStart(8, '0');
    };
    const oracleCanon = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(oracleCanon);
      if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v as Record<string, unknown>).sort()) {
          out[k] = oracleCanon((v as Record<string, unknown>)[k]);
        }
        return out;
      }
      return v;
    };
    const randValue = (depth: number): unknown => {
      const kind = Math.floor(rand() * (depth >= 2 ? 5 : 7));
      if (kind === 0) return Math.floor(rand() * 1000);
      if (kind === 1) return 's' + Math.floor(rand() * 100);
      if (kind === 2) return rand() < 0.5;
      if (kind === 3) return null;
      if (kind === 4) return 'n' + Math.floor(rand() * 20) + '-' + Math.floor(rand() * 20);
      if (kind === 5) {
        const arr: unknown[] = [];
        const n = Math.floor(rand() * 3);
        for (let i = 0; i < n; i++) arr.push(randValue(depth + 1));
        return arr;
      }
      const obj: Record<string, unknown> = {};
      const n = Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) obj['k' + Math.floor(rand() * 8)] = randValue(depth + 1);
      return obj;
    };
    for (let c = 0; c < 500; c++) {
      const value = randValue(0);
      const a = manageSnapshot({ name: 'case-' + c, mode: 'write', value });
      assert.equal(a.ok, true);
      const b = manageSnapshot({ name: 'case-' + c, mode: 'write', value });
      assert.equal(a.serialized, b.serialized);
      assert.equal(a.checksum, b.checksum);
      assert.equal(a.checksum, oracleFnv(a.serialized ?? ''));
      const reparsed: unknown = JSON.parse(a.serialized ?? 'null');
      assert.deepEqual(oracleCanon(reparsed), oracleCanon(value));
      const verify = manageSnapshot({ name: 'case-' + c, mode: 'verify', value, stored: a.serialized });
      assert.equal(verify.ok, true);
      const str = JSON.stringify(value);
      const numMatch = str.match(/\d+/);
      if (numMatch) {
        const altStr = str.replace(numMatch[0], String(Number(numMatch[0]) + 1));
        const altVal: unknown = JSON.parse(altStr);
        const m = manageSnapshot({ name: 'case-' + c, mode: 'verify', value: altVal, stored: a.serialized });
        assert.equal(m.ok, false);
        assert.equal(m.reason, 'snapshot-mismatch:case-' + c);
        const altSer = serializeSnapshot(altVal);
        const sLines = (a.serialized ?? '').split('\n');
        const nLines = altSer.split('\n');
        let fd = -1;
        for (let i = 0; i < Math.max(sLines.length, nLines.length); i++) {
          if (sLines[i] !== nLines[i]) {
            fd = i + 1;
            break;
          }
        }
        assert.equal(m.firstDiffLine, fd);
      }
      const updated = manageSnapshot({ name: 'case-' + c, mode: 'update', value, stored: a.serialized });
      assert.equal(updated.status, 'updated');
    }
  });
});

describe('visual-regression engine (FORGE TQ-039)', () => {
  it('diffs identical and differing images with perceptual weighting', () => {
    const base = { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] };
    const same = diffImages({ baseline: base, candidate: { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] } });
    assert.equal(same.ok, true);
    assert.equal(same.different, 0);
    assert.equal(same.identical, true);
    assert.equal(same.diffPercent, 0);
    const white = { width: 2, height: 2, pixels: ['#ffffff', '#000000', '#000000', '#000000'] };
    const big = diffImages({ baseline: base, candidate: white });
    assert.equal(big.different, 1);
    assert.equal(big.total, 4);
    assert.equal(big.diffPercent, 25);
    assert.equal(big.identical, false);
    const tolerant = diffImages({ baseline: base, candidate: white, threshold: 1 });
    assert.equal(tolerant.identical, true);
    assert.equal(tolerant.different, 0);
    const near = diffImages({
      baseline: { width: 1, height: 1, pixels: ['#646464'] },
      candidate: { width: 1, height: 1, pixels: ['#656464'] },
    });
    assert.equal(near.identical, true);
  });

  it('masks ignore regions out of the comparable set', () => {
    const base = { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] };
    const white = { width: 2, height: 2, pixels: ['#ffffff', '#000000', '#000000', '#000000'] };
    const masked = diffImages({ baseline: base, candidate: white, ignoreRegions: [{ x: 0, y: 0, width: 1, height: 1 }] });
    assert.equal(masked.different, 0);
    assert.equal(masked.ignored, 1);
    assert.equal(masked.diffPercent, 0);
    assert.equal(masked.identical, true);
  });

  it('refuses invalid images, thresholds and regions with named reasons', () => {
    assert.equal(diffImages({ baseline: null, candidate: null }).reason, 'visual-image-missing:baseline');
    assert.equal(
      diffImages({
        baseline: { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] },
        candidate: null,
      }).reason,
      'visual-image-missing:candidate',
    );
    assert.equal(diffImages({ baseline: { width: 0, height: 2, pixels: [] }, candidate: { width: 0, height: 2, pixels: [] } }).reason, 'visual-dimension-invalid:baseline:width');
    assert.equal(
      diffImages({
        baseline: { width: 2, height: 2.5, pixels: [] },
        candidate: { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] },
      }).reason,
      'visual-dimension-invalid:baseline:height',
    );
    assert.equal(
      diffImages({
        baseline: { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000'] },
        candidate: { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] },
      }).reason,
      'visual-pixels-invalid:baseline',
    );
    assert.equal(
      diffImages({
        baseline: { width: 2, height: 2, pixels: ['#000000', 'red', '#000000', '#000000'] },
        candidate: { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] },
      }).reason,
      'visual-pixel-invalid:baseline:2',
    );
    assert.equal(
      diffImages({
        baseline: { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] },
        candidate: { width: 3, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000', '#000000', '#000000'] },
      }).reason,
      'visual-size-mismatch:2x2:3x2',
    );
    assert.equal(
      diffImages({
        baseline: { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] },
        candidate: { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] },
        threshold: 1.5,
      }).reason,
      'visual-threshold-invalid:1.5',
    );
    assert.equal(
      diffImages({
        baseline: { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] },
        candidate: { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] },
        ignoreRegions: [{ x: 2, y: 0, width: 1, height: 1 }],
      }).reason,
      'visual-region-invalid:1',
    );
  });

  it('matches an independent reduce oracle on 500 mulberry32(42) cases', () => {
    const rand = mulberry32(42);
    const WEIGHTS = [0.299, 0.587, 0.114];
    const channels = (hex: string): number[] => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    const randPixel = (): string => {
      const r = Math.floor(rand() * 256).toString(16).padStart(2, '0');
      const g = Math.floor(rand() * 256).toString(16).padStart(2, '0');
      const b = Math.floor(rand() * 256).toString(16).padStart(2, '0');
      return '#' + r + g + b;
    };
    for (let c = 0; c < 500; c++) {
      const w = 1 + Math.floor(rand() * 6);
      const h = 1 + Math.floor(rand() * 6);
      const n = w * h;
      const basePixels: string[] = [];
      const candPixels: string[] = [];
      for (let i = 0; i < n; i++) {
        basePixels.push(randPixel());
        candPixels.push(rand() < 0.6 ? basePixels[i]! : randPixel());
      }
      const threshold = Math.round(rand() * 100) / 100;
      const regions: Array<{ x: number; y: number; width: number; height: number }> = [];
      if (rand() < 0.4 && w > 1 && h > 1) {
        const rx = Math.floor(rand() * w);
        const ry = Math.floor(rand() * h);
        regions.push({
          x: rx,
          y: ry,
          width: 1 + Math.floor(rand() * (w - rx)),
          height: 1 + Math.floor(rand() * (h - ry)),
        });
      }
      const verdict = diffImages({
        baseline: { width: w, height: h, pixels: basePixels },
        candidate: { width: w, height: h, pixels: candPixels },
        threshold,
        ignoreRegions: regions.length > 0 ? regions : undefined,
      });
      assert.equal(verdict.ok, true);
      const ignoreGrid: boolean[][] = [];
      for (let y = 0; y < h; y++) {
        const row: boolean[] = [];
        for (let x = 0; x < w; x++) row.push(false);
        ignoreGrid.push(row);
      }
      for (const r of regions) {
        for (let y = r.y; y < r.y + r.height; y++) {
          for (let x = r.x; x < r.x + r.width; x++) ignoreGrid[y]![x] = true;
        }
      }
      const limit = threshold * 255;
      let expDifferent = 0;
      let expIgnored = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const index = y * w + x;
          if (ignoreGrid[y]![x]) {
            expIgnored++;
            continue;
          }
          const ca = channels(basePixels[index]!);
          const cb = channels(candPixels[index]!);
          const delta = WEIGHTS.reduce((acc, weight, i) => acc + weight * Math.abs(ca[i]! - cb[i]!), 0);
          if (delta > limit) expDifferent++;
        }
      }
      const comparable = n - expIgnored;
      const expPercent = comparable === 0 ? 0 : Number(((expDifferent / comparable) * 100).toFixed(2));
      assert.equal(verdict.different, expDifferent);
      assert.equal(verdict.ignored, expIgnored);
      assert.equal(verdict.diffPercent, expPercent);
      assert.equal(verdict.identical, expDifferent === 0);
    }
  });
});

describe('browser-matrix engine (FORGE TQ-040)', () => {
  it('plans the full 44-combo market matrix', () => {
    const plan = planMatrix({});
    assert.equal(plan.ok, true);
    assert.equal(plan.count, 44);
    assert.equal(plan.unsupportedSkipped, 4);
    assert.deepEqual(plan.combos?.[0], { id: 'c1', browser: 'chrome', platform: 'desktop', viewport: '1280x720' });
    assert.deepEqual(MATRIX_BROWSERS, ['chrome', 'firefox', 'safari', 'edge']);
    assert.deepEqual(MATRIX_PLATFORMS, ['desktop', 'android', 'ios']);
    assert.deepEqual(MATRIX_VIEWPORTS, ['1280x720', '1920x1080', '375x667', '768x1024']);
  });

  it('scores coverage with the zero-failure requirement', () => {
    const plan = planMatrix({});
    const combos = (plan.combos ?? []) as MatrixCombo[];
    const results: Record<string, string> = {};
    for (const combo of combos) results[combo.id] = combo.id === 'c5' ? 'skip' : 'pass';
    const report = scoreMatrix({ combos, results });
    assert.equal(report.total, 44);
    assert.equal(report.passed, 43);
    assert.equal(report.skipped, 1);
    assert.equal(report.coverage, 97.73);
    assert.equal(report.meets, false);
    const lenient = scoreMatrix({ combos, results, threshold: 97 });
    assert.equal(lenient.meets, true);
    const failing: Record<string, string> = {};
    for (const combo of combos) failing[combo.id] = combo.id === 'c9' ? 'fail' : 'pass';
    const bad = scoreMatrix({ combos, results: failing, threshold: 50 });
    assert.equal(bad.coverage, 100);
    assert.equal(bad.meets, false);
  });

  it('refuses invalid matrices with named reasons', () => {
    assert.equal(planMatrix({ browsers: [] }).reason, 'matrix-browsers-missing');
    assert.equal(planMatrix({ platforms: 'desktop' }).reason, 'matrix-platforms-missing');
    assert.equal(planMatrix({ viewports: [] }).reason, 'matrix-viewports-missing');
    assert.equal(planMatrix({ browsers: ['opera'] }).reason, 'matrix-browser-unknown:opera');
    assert.equal(planMatrix({ platforms: ['wp'] }).reason, 'matrix-platform-unknown:wp');
    assert.equal(planMatrix({ viewports: ['999x999'] }).reason, 'matrix-viewport-unknown:999x999');
    assert.equal(planMatrix({ browsers: ['safari'], platforms: ['android'], viewports: ['375x667'] }).reason, 'matrix-combos-empty');
    assert.equal(scoreMatrix({ combos: [], results: {} }).reason, 'matrix-combos-empty');
    assert.equal(scoreMatrix({ combos: [{ id: '' }], results: {} }).reason, 'matrix-combo-id-missing:1');
    assert.equal(scoreMatrix({ combos: [{ id: 'c1' }], results: 'pass' }).reason, 'matrix-results-invalid');
    assert.equal(scoreMatrix({ combos: [{ id: 'c1' }], results: { c9: 'pass' } }).reason, 'matrix-combo-unknown:c9');
    assert.equal(scoreMatrix({ combos: [{ id: 'c1' }], results: {} }).reason, 'matrix-result-missing:c1');
    assert.equal(scoreMatrix({ combos: [{ id: 'c1' }], results: { c1: 'borked' } }).reason, 'matrix-status-invalid:borked:c1');
    assert.equal(scoreMatrix({ combos: [{ id: 'c1' }], results: { c1: 'pass' }, threshold: 101 }).reason, 'matrix-threshold-invalid:101');
  });

  it('matches an independent triple-loop oracle on 500 mulberry32(42) cases', () => {
    const rand = mulberry32(42);
    const oraclePlan = (
      browsers: string[] | undefined,
      platforms: string[] | undefined,
      viewports: string[] | undefined,
    ): { refusal?: string; combos: MatrixCombo[]; skipped: number } => {
      if (browsers !== undefined && browsers.length === 0) return { refusal: 'matrix-browsers-missing', combos: [], skipped: 0 };
      if (platforms !== undefined && platforms.length === 0) return { refusal: 'matrix-platforms-missing', combos: [], skipped: 0 };
      if (viewports !== undefined && viewports.length === 0) return { refusal: 'matrix-viewports-missing', combos: [], skipped: 0 };
      const bs = browsers ?? [...MATRIX_BROWSERS];
      const ps = platforms ?? [...MATRIX_PLATFORMS];
      const vs = viewports ?? [...MATRIX_VIEWPORTS];
      const combos: MatrixCombo[] = [];
      let skipped = 0;
      let bi = 0;
      while (bi < bs.length) {
        let pi = 0;
        while (pi < ps.length) {
          if (bs[bi] === 'safari' && ps[pi] === 'android') {
            skipped += vs.length;
            pi++;
            continue;
          }
          let vi = 0;
          while (vi < vs.length) {
            combos.push({ id: 'c' + (combos.length + 1), browser: bs[bi]!, platform: ps[pi]!, viewport: vs[vi]! });
            vi++;
          }
          pi++;
        }
        bi++;
      }
      return { combos, skipped };
    };
    for (let c = 0; c < 500; c++) {
      let browsers: string[] | undefined;
      let platforms: string[] | undefined;
      let viewports: string[] | undefined;
      if (rand() < 0.7) browsers = MATRIX_BROWSERS.filter(() => rand() < 0.6);
      if (rand() < 0.7) platforms = MATRIX_PLATFORMS.filter(() => rand() < 0.6);
      if (rand() < 0.7) viewports = MATRIX_VIEWPORTS.filter(() => rand() < 0.6);
      const req: { browsers?: string[]; platforms?: string[]; viewports?: string[] } = {};
      if (browsers !== undefined) req.browsers = browsers;
      if (platforms !== undefined) req.platforms = platforms;
      if (viewports !== undefined) req.viewports = viewports;
      const verdict = planMatrix(req);
      const oracle = oraclePlan(browsers, platforms, viewports);
      if (oracle.refusal) {
        assert.equal(verdict.ok, false);
        assert.equal(verdict.reason, oracle.refusal);
        continue;
      }
      if (oracle.combos.length === 0) {
        assert.equal(verdict.ok, false);
        assert.equal(verdict.reason, 'matrix-combos-empty');
        continue;
      }
      assert.equal(verdict.ok, true);
      assert.equal(verdict.count, oracle.combos.length);
      assert.equal(verdict.unsupportedSkipped, oracle.skipped);
      assert.deepEqual(verdict.combos, oracle.combos);
      const results: Record<string, string> = {};
      let ep = 0;
      let ef = 0;
      let es = 0;
      for (const combo of oracle.combos) {
        const r = rand();
        const status = r < 0.7 ? 'pass' : r < 0.85 ? 'fail' : 'skip';
        results[combo.id] = status;
        if (status === 'pass') ep++;
        else if (status === 'fail') ef++;
        else es++;
      }
      const threshold = Math.floor(rand() * 101);
      const report = scoreMatrix({ combos: oracle.combos, results, threshold });
      const expCoverage = Number((((ep + ef) / oracle.combos.length) * 100).toFixed(2));
      assert.equal(report.coverage, expCoverage);
      assert.equal(report.passed, ep);
      assert.equal(report.failed, ef);
      assert.equal(report.skipped, es);
      assert.equal(report.meets, expCoverage >= threshold && ef === 0);
    }
  });
});
