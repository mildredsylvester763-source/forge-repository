// Pure tool registry engine for the orchestrator (FORGE AI-077).
// Market law (MCP tool permissioning and function-calling scopes): tools are
// registered with a class (read, write, exec, network), agents get per-tool
// allowlists that deny by default, and every plan action maps to exactly one
// required tool; a denied pair is a named refusal, not a silent skip.
// Every refusal is named.

export interface ToolSpec {
  name: string;
  cls: string;
  description: string;
}

export const TOOLS: ToolSpec[] = [
  { name: 'web-search', cls: 'read', description: 'Search the public web' },
  { name: 'web-fetch', cls: 'network', description: 'Fetch a page from a known host' },
  { name: 'fs-read', cls: 'read', description: 'Read workspace files' },
  { name: 'fs-write', cls: 'write', description: 'Write workspace files' },
  { name: 'shell-exec', cls: 'exec', description: 'Run shell commands in the sandbox' },
  { name: 'db-query', cls: 'read', description: 'Run read-only database queries' },
  { name: 'db-migrate', cls: 'write', description: 'Apply database migrations' },
  { name: 'mail-send', cls: 'network', description: 'Send email on behalf of the user' },
];

export const TOOL_CLASSES = ['read', 'write', 'exec', 'network'];

export const AGENT_TOOLS: Record<string, string[]> = {
  coordinator: ['mail-send', 'fs-read'],
  researcher: ['web-search', 'web-fetch', 'fs-read'],
  writer: ['fs-read', 'fs-write'],
  executor: ['shell-exec', 'fs-read', 'fs-write'],
  reviewer: ['fs-read', 'db-query'],
};

export const ACTION_TOOLS: Record<string, string> = {
  search: 'web-search',
  write: 'fs-write',
  run: 'shell-exec',
  verify: 'db-query',
  present: 'mail-send',
};

export interface PermissionVerdict {
  ok: boolean;
  reason?: string;
  agent?: string;
  tool?: string;
  cls?: string;
}

export interface RequiredTool {
  step: number;
  agent: string;
  action: string;
  tool: string;
}

export interface ToolPlanVerdict {
  ok: boolean;
  reason?: string;
  required?: RequiredTool[];
}

export function checkToolPermission(input: { agent?: unknown; tool?: unknown }): PermissionVerdict {
  const agent = typeof input?.agent === 'string' ? input.agent.trim().toLowerCase() : '';
  if (agent.length === 0) return { ok: false, reason: 'tool-agent-missing' };
  if (!AGENT_TOOLS[agent]) return { ok: false, reason: 'tool-agent-unknown:' + agent };
  const tool = typeof input?.tool === 'string' ? input.tool.trim().toLowerCase() : '';
  if (tool.length === 0) return { ok: false, reason: 'tool-name-missing' };
  if (!TOOLS.some((t) => t.name === tool)) return { ok: false, reason: 'tool-unknown:' + tool };
  if (!(AGENT_TOOLS[agent] ?? []).includes(tool)) {
    return { ok: false, reason: 'tool-denied:' + agent + ':' + tool };
  }
  const spec = TOOLS.find((t) => t.name === tool) as ToolSpec;
  return { ok: true, agent, tool, cls: spec.cls };
}

export function toolsForPlan(input: { assignments?: unknown }): ToolPlanVerdict {
  const assignmentsRaw = Array.isArray(input?.assignments) ? (input.assignments as unknown[]) : [];
  if (assignmentsRaw.length === 0) return { ok: false, reason: 'tool-plan-empty' };
  const required: RequiredTool[] = [];
  for (let i = 0; i < assignmentsRaw.length; i++) {
    const a = assignmentsRaw[i] as { agent?: unknown; action?: unknown };
    const agent = typeof a?.agent === 'string' ? a.agent.trim().toLowerCase() : '';
    if (!AGENT_TOOLS[agent]) {
      return { ok: false, reason: 'tool-agent-unknown:' + (agent.length > 0 ? agent : 'missing') };
    }
    const action = typeof a?.action === 'string' ? a.action.trim().toLowerCase() : '';
    if (!(action in ACTION_TOOLS)) {
      return { ok: false, reason: 'tool-action-unknown:' + (action.length > 0 ? action : 'missing') };
    }
    const tool = ACTION_TOOLS[action]!;
    if (!(AGENT_TOOLS[agent] ?? []).includes(tool)) {
      return { ok: false, reason: 'tool-denied:' + agent + ':' + tool };
    }
    required.push({ step: i + 1, agent, action, tool });
  }
  return { ok: true, required };
}
