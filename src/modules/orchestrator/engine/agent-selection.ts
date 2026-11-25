// Pure agent selection and handoff engine for the orchestrator (FORGE AI-076).
// Market law (beam.ai and CrewAI handoff patterns): ownership moves to the
// receiving agent at each handoff, handoffs are recorded at the step boundary
// where they occur, and the number one failure mode of multi-agent systems is
// the infinite handoff loop; this engine refuses ping-pong handoffs with
// named bounce detection. Rosters may restrict the cast. Every refusal is
// named.

export const AGENTS = ['coordinator', 'researcher', 'writer', 'executor', 'reviewer'];

export const CAPABILITIES: Record<string, string[]> = {
  coordinator: ['present'],
  researcher: ['search'],
  writer: ['write'],
  executor: ['run'],
  reviewer: ['verify'],
};

export interface SelectionVerdict {
  ok: boolean;
  reason?: string;
  agent?: string;
}

export interface HandoffAssignment {
  step: number;
  action: string;
  agent: string;
}

export interface HandoffRecord {
  from: string;
  to: string;
  atStep: number;
}

export interface HandoffVerdict {
  ok: boolean;
  reason?: string;
  assignments?: HandoffAssignment[];
  handoffs?: HandoffRecord[];
}

function validateRoster(roster: unknown): string | null {
  if (!Array.isArray(roster) || roster.length === 0) return 'handoff-roster-empty';
  for (const a of roster) {
    if (typeof a !== 'string' || !AGENTS.includes(a)) return 'handoff-agent-unknown:' + String(a);
    if (roster.indexOf(a) !== roster.lastIndexOf(a)) return 'handoff-agent-duplicate:' + a;
  }
  return null;
}

export function selectAgent(input: { action?: unknown; roster?: unknown }): SelectionVerdict {
  const action = typeof input?.action === 'string' ? input.action.trim().toLowerCase() : '';
  if (action.length === 0) return { ok: false, reason: 'handoff-action-missing' };
  const roster = Array.isArray(input?.roster) ? input.roster : AGENTS;
  const err = validateRoster(roster);
  if (err) return { ok: false, reason: err };
  for (const agent of roster) {
    if ((CAPABILITIES[agent] ?? []).includes(action)) return { ok: true, agent };
  }
  return { ok: false, reason: 'handoff-no-capable-agent:' + action };
}

export function planHandoffs(input: { steps?: unknown; roster?: unknown }): HandoffVerdict {
  const stepsRaw = Array.isArray(input?.steps) ? (input.steps as unknown[]) : [];
  if (stepsRaw.length === 0) return { ok: false, reason: 'handoff-steps-empty' };
  const roster = Array.isArray(input?.roster) ? input.roster : AGENTS;
  const err = validateRoster(roster);
  if (err) return { ok: false, reason: err };
  const assignments: HandoffAssignment[] = [];
  for (let i = 0; i < stepsRaw.length; i++) {
    const s = stepsRaw[i];
    const action = typeof (s as { action?: unknown })?.action === 'string'
      ? ((s as { action: string }).action as string).trim().toLowerCase()
      : '';
    if (action.length === 0) return { ok: false, reason: 'handoff-action-missing' };
    let agent = '';
    for (const a of roster) {
      if ((CAPABILITIES[a] ?? []).includes(action)) {
        agent = a;
        break;
      }
    }
    if (!agent) return { ok: false, reason: 'handoff-no-capable-agent:' + action };
    assignments.push({ step: i + 1, action, agent });
  }
  const handoffs: HandoffRecord[] = [];
  for (let i = 1; i < assignments.length; i++) {
    if (assignments[i]!.agent !== assignments[i - 1]!.agent) {
      const prev = handoffs[handoffs.length - 1];
      if (prev && prev.from === assignments[i]!.agent) {
        return {
          ok: false,
          reason:
            'handoff-bounce-detected:' +
            assignments[i]!.agent +
            '->' +
            assignments[i - 1]!.agent +
            '->' +
            assignments[i]!.agent,
        };
      }
      handoffs.push({
        from: assignments[i - 1]!.agent,
        to: assignments[i]!.agent,
        atStep: i + 1,
      });
    }
  }
  return { ok: true, assignments, handoffs };
}
