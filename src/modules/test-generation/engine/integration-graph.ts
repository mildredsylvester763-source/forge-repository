// Pure integration test planning engine for test generation (FORGE TQ-032).
// Market law (Pact contract testing, EvoSuite): every edge in the service
// dependency graph deserves a covering case; cycles are a planning failure
// surfaced by name, and a topological order gives suites a safe execution
// sequence. Edges dedupe while preserving first-seen order.

export interface IntegrationCase {
  name: string;
  from: string;
  to: string;
}

export interface IntegrationVerdict {
  ok: boolean;
  reason?: string;
  cases?: IntegrationCase[];
  order?: string[];
}

function asName(entry: unknown): string | null {
  if (typeof entry === 'string') {
    const s = entry.trim();
    return s.length > 0 ? s : null;
  }
  if (entry && typeof entry === 'object') {
    const n = (entry as { name?: unknown }).name;
    if (typeof n === 'string') {
      const s = n.trim();
      return s.length > 0 ? s : null;
    }
  }
  return null;
}

export function planIntegrationTests(input: {
  services?: unknown;
  dependencies?: unknown;
}): IntegrationVerdict {
  const servicesRaw = Array.isArray(input?.services) ? input.services : [];
  if (servicesRaw.length === 0) {
    return { ok: false, reason: 'integration-services-empty' };
  }
  const names: string[] = [];
  for (const s of servicesRaw) {
    const n = asName(s);
    if (!n) return { ok: false, reason: 'integration-service-name-missing' };
    if (n.length > 200) return { ok: false, reason: 'integration-service-name-too-long' };
    if (names.includes(n)) return { ok: false, reason: 'integration-service-duplicate:' + n };
    names.push(n);
  }
  const depsRaw = Array.isArray(input?.dependencies) ? input.dependencies : [];
  if (depsRaw.length === 0) {
    return { ok: false, reason: 'integration-dependencies-empty' };
  }
  const nameSet = new Set(names);
  const seen = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];
  for (const d of depsRaw) {
    const pair = Array.isArray(d) ? d : null;
    if (!pair || pair.length < 2) {
      return { ok: false, reason: 'integration-dependency-name-missing' };
    }
    const from = asName(pair[0]);
    const to = asName(pair[1]);
    if (!from || !to) return { ok: false, reason: 'integration-dependency-name-missing' };
    const key = from + '->' + to;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push({ from, to });
    }
  }
  for (const e of edges) {
    if (!nameSet.has(e.from) || !nameSet.has(e.to)) {
      return { ok: false, reason: 'integration-node-unknown:' + (nameSet.has(e.from) ? e.to : e.from) };
    }
  }
  const adj = new Map<string, string[]>();
  for (const n of names) adj.set(n, []);
  for (const e of edges) adj.get(e.from)?.push(e.to);
  const state = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let cycle: string | null = null;
  const visit = (m: string) => {
    if (cycle) return;
    if (onStack.has(m)) {
      const at = stack.indexOf(m);
      cycle = stack.slice(at).concat(m).join('->');
      return;
    }
    if (state.get(m) === 2) return;
    state.set(m, 1);
    stack.push(m);
    onStack.add(m);
    for (const t of adj.get(m) ?? []) visit(t);
    onStack.delete(m);
    stack.pop();
    state.set(m, 2);
  };
  for (const n of names) visit(n);
  if (cycle) {
    return { ok: false, reason: 'integration-cycle-detected:' + cycle };
  }
  const indeg = new Map<string, number>();
  for (const n of names) indeg.set(n, 0);
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = names.filter((n) => (indeg.get(n) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const m = queue.shift() as string;
    order.push(m);
    for (const t of adj.get(m) ?? []) {
      const left = (indeg.get(t) ?? 0) - 1;
      indeg.set(t, left);
      if (left === 0) queue.push(t);
    }
  }
  const cases: IntegrationCase[] = edges.map((e) => ({
    name: 'integrates:' + e.from + '->' + e.to,
    from: e.from,
    to: e.to,
  }));
  return { ok: true, cases, order };
}
