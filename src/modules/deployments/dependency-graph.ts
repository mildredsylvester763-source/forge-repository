/**
 * DP-015 — deterministic deployment dependency planning.
 *
 * The planner accepts a caller-supplied service DAG and returns dependency-first,
 * parallelizable release waves. It deliberately does not trigger deployments: provider
 * execution and persisted service discovery remain separate, owner-authorized work.
 */

export interface DeploymentDependencyNode {
  readonly id: string;
  readonly dependsOn?: readonly string[];
}

export interface DeploymentDependencyPlan {
  readonly ok: true;
  readonly order: readonly string[];
  readonly waves: readonly (readonly string[])[];
  readonly serviceCount: number;
  readonly dependencyCount: number;
}

export interface DeploymentDependencyFailure {
  readonly ok: false;
  readonly reason: string;
  readonly cycle?: readonly string[];
}

export type DeploymentDependencyResult = DeploymentDependencyPlan | DeploymentDependencyFailure;

const MAX_SERVICES = 256;
const MAX_DEPENDENCIES = 4_096;
const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function findCycle(
  dependencies: ReadonlyMap<string, readonly string[]>,
  remaining: ReadonlyMap<string, number>,
): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (service: string): string[] | null => {
    state.set(service, 1);
    stack.push(service);
    const edges = [...(dependencies.get(service) ?? [])]
      .filter((dependency) => (remaining.get(dependency) ?? 0) > 0)
      .sort();
    for (const dependency of edges) {
      const current = state.get(dependency) ?? 0;
      if (current === 0) {
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      } else if (current === 1) {
        const start = stack.indexOf(dependency);
        return [...stack.slice(start), dependency];
      }
    }
    stack.pop();
    state.set(service, 2);
    return null;
  };

  for (const service of [...dependencies.keys()].sort()) {
    if ((remaining.get(service) ?? 0) > 0 && (state.get(service) ?? 0) === 0) {
      const cycle = visit(service);
      if (cycle !== null) return cycle;
    }
  }
  return null;
}

/**
 * Validate a directed acyclic service graph and produce a deterministic deployment order.
 * A wave contains services whose dependencies were all satisfied by earlier waves.
 */
export function planDeploymentDependencies(input: unknown): DeploymentDependencyResult {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, reason: 'dependency_graph_empty' };
  }
  if (input.length > MAX_SERVICES) {
    return { ok: false, reason: 'dependency_graph_too_many_services' };
  }

  const dependencies = new Map<string, readonly string[]>();
  let dependencyCount = 0;

  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: 'dependency_graph_invalid_service' };
    }
    const node = raw as Record<string, unknown>;
    if (Object.keys(node).some((key) => key !== 'id' && key !== 'dependsOn')) {
      return { ok: false, reason: 'dependency_graph_unknown_service_field' };
    }
    if (typeof node.id !== 'string' || !SERVICE_ID.test(node.id)) {
      return { ok: false, reason: 'dependency_graph_invalid_service_id' };
    }
    if (dependencies.has(node.id)) {
      return { ok: false, reason: 'dependency_graph_duplicate_service' };
    }

    const rawDependencies = node.dependsOn ?? [];
    if (!Array.isArray(rawDependencies) || rawDependencies.length > MAX_SERVICES) {
      return { ok: false, reason: 'dependency_graph_invalid_dependencies' };
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const dependency of rawDependencies) {
      if (typeof dependency !== 'string' || !SERVICE_ID.test(dependency)) {
        return { ok: false, reason: 'dependency_graph_invalid_dependency_id' };
      }
      if (dependency === node.id) {
        return { ok: false, reason: 'dependency_graph_self_dependency' };
      }
      if (seen.has(dependency)) {
        return { ok: false, reason: 'dependency_graph_duplicate_dependency' };
      }
      seen.add(dependency);
      normalized.push(dependency);
    }
    dependencyCount += normalized.length;
    if (dependencyCount > MAX_DEPENDENCIES) {
      return { ok: false, reason: 'dependency_graph_too_many_edges' };
    }
    dependencies.set(node.id, normalized.sort());
  }

  for (const [service, edges] of dependencies) {
    for (const dependency of edges) {
      if (!dependencies.has(dependency)) {
        return { ok: false, reason: 'dependency_graph_unknown_dependency:' + service + ':' + dependency };
      }
    }
  }

  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const service of dependencies.keys()) {
    dependents.set(service, []);
    remaining.set(service, dependencies.get(service)?.length ?? 0);
  }
  for (const [service, edges] of dependencies) {
    for (const dependency of edges) dependents.get(dependency)?.push(service);
  }
  for (const values of dependents.values()) values.sort();

  const waves: string[][] = [];
  let ready = [...dependencies.keys()].filter((service) => remaining.get(service) === 0).sort();
  let processed = 0;

  while (ready.length > 0) {
    const wave = ready;
    waves.push(wave);
    processed += wave.length;
    const next: string[] = [];
    for (const service of wave) {
      for (const dependent of dependents.get(service) ?? []) {
        const count = (remaining.get(dependent) ?? 0) - 1;
        remaining.set(dependent, count);
        if (count === 0) next.push(dependent);
      }
    }
    ready = [...new Set(next)].sort();
  }

  if (processed !== dependencies.size) {
    const cycle = findCycle(dependencies, remaining);
    return {
      ok: false,
      reason: 'dependency_graph_cycle',
      ...(cycle === null ? {} : { cycle }),
    };
  }

  return {
    ok: true,
    order: waves.flat(),
    waves,
    serviceCount: dependencies.size,
    dependencyCount,
  };
}
