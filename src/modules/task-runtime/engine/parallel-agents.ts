// Parallel agents engine (FORGE AI-083). Pure: no imports at all.
// Agents declare the resources they read and write. Strict mode (the
// default) flags write-write and read-write hazards; relaxed mode flags
// write-write hazards only. Conflicts are deduplicated per pair and
// resource, then sorted deterministically by writer, reader, resource
// and kind, so verdicts are stable across runs.

export const PARALLEL_MODES: readonly string[] = ['strict', 'relaxed'];

export interface ParallelAgentInput {
  agentId?: unknown;
  reads?: unknown;
  writes?: unknown;
}

export interface ParallelConflict {
  a: string;
  b: string;
  resource: string;
  kind: string;
}

export interface DetectParallelConflictsInput {
  agents?: unknown;
  mode?: unknown;
}

export interface DetectParallelConflictsResult {
  ok: boolean;
  reason?: string;
  mode?: string;
  agentCount?: number;
  conflicts?: ParallelConflict[];
  hasConflicts?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function conflictCompare(x: ParallelConflict, y: ParallelConflict): number {
  if (x.a !== y.a) return x.a < y.a ? -1 : 1;
  if (x.b !== y.b) return x.b < y.b ? -1 : 1;
  if (x.resource !== y.resource) return x.resource < y.resource ? -1 : 1;
  if (x.kind !== y.kind) return x.kind < y.kind ? -1 : 1;
  return 0;
}

export function detectParallelConflicts(input: DetectParallelConflictsInput): DetectParallelConflictsResult {
  const agentsRaw: unknown = input?.agents;
  if (!Array.isArray(agentsRaw) || agentsRaw.length === 0) return { ok: false, reason: 'parallel-agents-empty' };
  const modeRaw: unknown = input?.mode;
  const mode = modeRaw === undefined ? 'strict' : typeof modeRaw === 'string' ? modeRaw.trim().toLowerCase() : '';
  if (!PARALLEL_MODES.includes(mode)) return { ok: false, reason: 'parallel-mode-unknown:' + (mode.length === 0 ? 'missing' : mode) };
  const agents: { agentId: string; reads: string[]; writes: string[] }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < agentsRaw.length; i++) {
    const agent: unknown = agentsRaw[i];
    if (!isPlainObject(agent)) return { ok: false, reason: 'parallel-agent-missing:' + (i + 1) };
    const agentId = typeof agent.agentId === 'string' ? agent.agentId.trim() : '';
    if (agentId.length === 0) return { ok: false, reason: 'parallel-agent-id-missing:' + (i + 1) };
    if (seen.has(agentId)) return { ok: false, reason: 'parallel-agent-id-duplicate:' + agentId };
    seen.add(agentId);
    if (agent.reads !== undefined && !isStringList(agent.reads)) return { ok: false, reason: 'parallel-reads-invalid:' + agentId };
    if (agent.writes !== undefined && !isStringList(agent.writes)) return { ok: false, reason: 'parallel-writes-invalid:' + agentId };
    agents.push({
      agentId,
      reads: agent.reads === undefined ? [] : (agent.reads as string[]),
      writes: agent.writes === undefined ? [] : (agent.writes as string[]),
    });
  }
  const conflicts: ParallelConflict[] = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const first = agents[i];
      const second = agents[j];
      if (first === undefined || second === undefined) continue; // loop bounds guarantee both exist
      const writeWrite = Array.from(new Set(first.writes.filter((resource) => second.writes.includes(resource)))).sort();
      for (const resource of writeWrite) conflicts.push({ a: first.agentId, b: second.agentId, resource, kind: 'write-write' });
      if (mode === 'strict') {
        const firstWritesSecondReads = Array.from(new Set(first.writes.filter((resource) => second.reads.includes(resource)))).sort();
        for (const resource of firstWritesSecondReads) conflicts.push({ a: first.agentId, b: second.agentId, resource, kind: 'read-write' });
        const firstReadsSecondWrites = Array.from(new Set(first.reads.filter((resource) => second.writes.includes(resource)))).sort();
        for (const resource of firstReadsSecondWrites) conflicts.push({ a: second.agentId, b: first.agentId, resource, kind: 'read-write' });
      }
    }
  }
  conflicts.sort(conflictCompare);
  return { ok: true, mode, agentCount: agents.length, conflicts, hasConflicts: conflicts.length > 0 };
}
