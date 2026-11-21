import type { EventEnvelope, EventStore, VerifyReport } from '../../kernel/events.ts';

export const SAFETY_ADMIN_AUDIT_VAULT_FEATURE_ID = 'TS-775';
export const SAFETY_ADMIN_AUDIT_EVENT_TYPE = 'admin.unrestricted_action.recorded';

export type AdminAuditScope =
  | { readonly kind: 'global'; readonly id: string }
  | { readonly kind: 'workspace'; readonly id: string }
  | { readonly kind: 'lab_sandbox'; readonly id: string };

export type AdminAuditOutcome = 'succeeded' | 'refused';

export interface AdminUnrestrictedAction {
  readonly actionId: string;
  readonly actionType: string;
  readonly scope: AdminAuditScope;
  readonly target?: { readonly type: string; readonly id: string };
  readonly outcome: AdminAuditOutcome;
  /** A stable, non-sensitive code only; arbitrary user text is deliberately not accepted. */
  readonly reasonCode?: string;
}

export interface SafetyAdminAuditVaultAccess {
  /** Must resolve from trusted server-side identity/role data, never a request boolean. */
  isGlobalOwner(userId: string): Promise<boolean>;
}

export type RecordAdminActionResult =
  | { readonly ok: true; readonly event: EventEnvelope }
  | { readonly ok: false; readonly reason: 'actor_invalid' | 'owner_required' | 'authorization_unavailable' | 'action_invalid' | 'event_store_unavailable' };

export type VerifyAdminAuditVaultResult =
  | { readonly ok: true; readonly verification: Extract<VerifyReport, { ok: true }> }
  | { readonly ok: false; readonly reason: 'actor_invalid' | 'owner_required' | 'authorization_unavailable' | 'event_store_unavailable' | 'chain_invalid'; readonly verification?: VerifyReport };

/**
 * TS-775 recording boundary for unrestricted admin actions. It always appends to Forge's
 * existing EN-04 hash-chained EventStore; there is deliberately no feature-off switch.
 * Callers must invoke it for each real action. Until every unrestricted operation is wired
 * through this boundary and a durable production EventStore is composed, complete capture is
 * not claimed.
 */
export class SafetyAdminAuditVaultService {
  private readonly access: SafetyAdminAuditVaultAccess;
  private readonly events: EventStore;

  constructor(input: { readonly access: SafetyAdminAuditVaultAccess; readonly events: EventStore }) {
    this.access = input.access;
    this.events = input.events;
  }

  async record(actorUserId: unknown, rawAction: unknown): Promise<RecordAdminActionResult> {
    if (!isId(actorUserId)) return { ok: false, reason: 'actor_invalid' };
    const action = validateAction(rawAction, actorUserId);
    if (!action) return { ok: false, reason: 'action_invalid' };

    let owner: boolean;
    try {
      owner = await this.access.isGlobalOwner(actorUserId);
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
    if (owner !== true) return { ok: false, reason: 'owner_required' };

    try {
      const event = await this.events.append({
        type: SAFETY_ADMIN_AUDIT_EVENT_TYPE,
        version: 1,
        actor: { kind: 'user', id: actorUserId },
        subject: { type: 'admin_scope', id: action.scope.id },
        payload: {
          actionId: action.actionId,
          actionType: action.actionType,
          scope: action.scope,
          target: action.target ?? null,
          outcome: action.outcome,
          reasonCode: action.reasonCode ?? null,
        },
      });
      return Object.freeze({ ok: true, event });
    } catch {
      return { ok: false, reason: 'event_store_unavailable' };
    }
  }

  async verify(actorUserId: unknown): Promise<VerifyAdminAuditVaultResult> {
    if (!isId(actorUserId)) return { ok: false, reason: 'actor_invalid' };
    let owner: boolean;
    try {
      owner = await this.access.isGlobalOwner(actorUserId);
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
    if (owner !== true) return { ok: false, reason: 'owner_required' };
    try {
      const verification = await this.events.verify();
      if (!verification.ok) return { ok: false, reason: 'chain_invalid', verification };
      return Object.freeze({ ok: true, verification });
    } catch {
      return { ok: false, reason: 'event_store_unavailable' };
    }
  }
}

function validateAction(value: unknown, actorUserId: string): AdminUnrestrictedAction | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(['actionId', 'actionType', 'scope', 'target', 'outcome', 'reasonCode']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (!isId(value.actionId) || !isActionType(value.actionType) || !isScope(value.scope, actorUserId)) return null;
  if (value.outcome !== 'succeeded' && value.outcome !== 'refused') return null;
  if (value.reasonCode !== undefined && !isReasonCode(value.reasonCode)) return null;
  if (value.target !== undefined && value.target !== null) {
    if (!isRecord(value.target) || Object.keys(value.target).some((key) => !['type', 'id'].includes(key)) ||
        !isActionType(value.target.type) || !isId(value.target.id)) return null;
  } else if (value.target === null) {
    return null;
  }
  const scope = Object.freeze({ ...value.scope }) as AdminAuditScope;
  const target = value.target === undefined ? undefined : Object.freeze({ ...value.target as { type: string; id: string } });
  return Object.freeze({
    actionId: value.actionId,
    actionType: value.actionType,
    scope,
    ...(target ? { target } : {}),
    outcome: value.outcome,
    ...(value.reasonCode === undefined ? {} : { reasonCode: value.reasonCode }),
  });
}

function isScope(value: unknown, actorUserId: string): value is AdminAuditScope {
  if (!isRecord(value) || Object.keys(value).some((key) => !['kind', 'id'].includes(key)) || !isId(value.id)) return false;
  if (value.kind === 'global') return value.id === actorUserId;
  return value.kind === 'workspace' || value.kind === 'lab_sandbox';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function isActionType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 96 && /^[a-z][a-z0-9_.-]*$/.test(value);
}

function isReasonCode(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 96 && /^[a-z][a-z0-9_.-]*$/.test(value);
}
