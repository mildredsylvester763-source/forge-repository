// Approval gates engine (FORGE AI-080). Pure: no imports at all.
// A plan is gated when any policy trigger fires: the risk level is
// listed as always-risk, the tool class is listed as sensitive, or the
// cost exceeds the maximum auto-approved cost. Triggers are reported
// deterministically in the order risk, tool, cost. Rejecting a gate
// requires a stated reason, so denials stay auditable.

export const APPROVAL_RISK_LEVELS: readonly string[] = ['low', 'medium', 'high'];
export const APPROVAL_TOOL_CLASSES: readonly string[] = ['read', 'write', 'exec', 'network'];
export const DEFAULT_APPROVAL_POLICY = { riskLevels: ['high'], toolClasses: ['write', 'exec', 'network'], maxAutoCost: 1000 };

export interface ApprovalPolicyInput {
  riskLevels?: unknown;
  toolClasses?: unknown;
  maxAutoCost?: unknown;
}

export interface PlanApprovalInput {
  risk?: unknown;
  toolClass?: unknown;
  cost?: unknown;
  policy?: unknown;
}

export interface PlanApprovalResult {
  ok: boolean;
  reason?: string;
  risk?: string;
  toolClass?: string;
  cost?: number;
  requiresApproval?: boolean;
  triggers?: string[];
}

export interface ResolveApprovalInput {
  gateId?: unknown;
  decision?: unknown;
  reason?: unknown;
}

export interface ResolveApprovalResult {
  ok: boolean;
  reason?: string;
  gateId?: string;
  decision?: string;
  reasonText?: string;
}

function normalizeList(raw: unknown, catalog: readonly string[]): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const value = item.trim().toLowerCase();
    if (!catalog.includes(value)) return null;
    out.push(value);
  }
  return out;
}

export function planApproval(input: PlanApprovalInput): PlanApprovalResult {
  const risk = typeof input?.risk === 'string' ? input.risk.trim().toLowerCase() : '';
  if (!APPROVAL_RISK_LEVELS.includes(risk)) return { ok: false, reason: 'approval-risk-invalid' };
  const toolClass = typeof input?.toolClass === 'string' ? input.toolClass.trim().toLowerCase() : '';
  if (!APPROVAL_TOOL_CLASSES.includes(toolClass)) return { ok: false, reason: 'approval-tool-class-invalid' };
  const cost = input?.cost;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return { ok: false, reason: 'approval-cost-invalid' };
  let riskLevels: string[] = [...DEFAULT_APPROVAL_POLICY.riskLevels];
  let toolClasses: string[] = [...DEFAULT_APPROVAL_POLICY.toolClasses];
  let maxAutoCost = DEFAULT_APPROVAL_POLICY.maxAutoCost;
  const policyRaw: unknown = input?.policy;
  if (policyRaw !== undefined) {
    if (policyRaw === null || typeof policyRaw !== 'object' || Array.isArray(policyRaw)) {
      return { ok: false, reason: 'approval-policy-invalid' };
    }
    const policy = policyRaw as ApprovalPolicyInput;
    if (policy.riskLevels !== undefined) {
      const normalized = normalizeList(policy.riskLevels, APPROVAL_RISK_LEVELS);
      if (normalized === null) return { ok: false, reason: 'approval-policy-invalid' };
      riskLevels = normalized;
    }
    if (policy.toolClasses !== undefined) {
      const normalized = normalizeList(policy.toolClasses, APPROVAL_TOOL_CLASSES);
      if (normalized === null) return { ok: false, reason: 'approval-policy-invalid' };
      toolClasses = normalized;
    }
    if (policy.maxAutoCost !== undefined) {
      const mac = policy.maxAutoCost;
      if (typeof mac !== 'number' || !Number.isFinite(mac) || mac < 0) return { ok: false, reason: 'approval-policy-invalid' };
      maxAutoCost = mac;
    }
  }
  const triggers: string[] = [];
  if (riskLevels.includes(risk)) triggers.push('risk:' + risk);
  if (toolClasses.includes(toolClass)) triggers.push('tool:' + toolClass);
  if (cost > maxAutoCost) triggers.push('cost:' + cost + '>' + maxAutoCost);
  return { ok: true, risk, toolClass, cost, requiresApproval: triggers.length > 0, triggers };
}

export function resolveApproval(input: ResolveApprovalInput): ResolveApprovalResult {
  const gateId = typeof input?.gateId === 'string' ? input.gateId.trim() : '';
  if (gateId.length === 0) return { ok: false, reason: 'approval-gate-missing' };
  const decision = typeof input?.decision === 'string' ? input.decision.trim().toLowerCase() : '';
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, reason: 'approval-decision-unknown:' + (decision.length === 0 ? 'missing' : decision) };
  }
  if (decision === 'reject') {
    const reasonText = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (reasonText.length === 0) return { ok: false, reason: 'approval-reject-reason-missing' };
    return { ok: true, gateId, decision, reasonText };
  }
  return { ok: true, gateId, decision };
}
