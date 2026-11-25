import type { EventEnvelope } from '../../kernel/events.ts';
import { buildSafetySelfAudit, type SelfAuditFailure, type SelfAuditReport } from './engine/self-audit-engine.ts';

export interface SafetyAuditVaultSnapshot {
  /** Complete ordered chain from genesis, not a filtered date-range query. */
  readonly events: readonly EventEnvelope[];
  /** Count from the same consistent vault snapshot/head. */
  readonly vaultEventCount: number;
}
export interface SafetySelfAuditRepository {
  /** Must return events and count from one consistent snapshot of the tamper-evident vault. */
  readCompleteVaultSnapshot(): Promise<SafetyAuditVaultSnapshot>;
}
export interface SafetySelfAuditAuthorizer {
  /** Implemented from trusted server-side identity/role data, never from request claims. */
  isOwner(ownerId: string): Promise<boolean>;
}
export type SafetySelfAuditServiceResult =
  | { readonly ok: true; readonly report: SelfAuditReport }
  | { readonly ok: false; readonly reason: SelfAuditFailure | 'owner_forbidden' | 'vault_unavailable' };

/** Backend report service; periodic scheduling and owner delivery are deliberately separate integrations. */
export class SafetySelfAuditService {
  private readonly repository: SafetySelfAuditRepository;
  private readonly authorizer: SafetySelfAuditAuthorizer;

  constructor(repository: SafetySelfAuditRepository, authorizer: SafetySelfAuditAuthorizer) {
    this.repository = repository;
    this.authorizer = authorizer;
  }

  async report(input: { readonly ownerId: unknown; readonly from: unknown; readonly to: unknown }): Promise<SafetySelfAuditServiceResult> {
    if (typeof input?.ownerId !== 'string' || input.ownerId.trim().length === 0 || input.ownerId.length > 128) {
      return { ok: false, reason: 'invalid_owner' };
    }
    let authorized: boolean;
    try {
      authorized = await this.authorizer.isOwner(input.ownerId);
    } catch {
      return { ok: false, reason: 'owner_forbidden' };
    }
    if (authorized !== true) return { ok: false, reason: 'owner_forbidden' };

    try {
      const snapshot = await this.repository.readCompleteVaultSnapshot();
      return buildSafetySelfAudit({
        ownerId: input.ownerId,
        from: input.from,
        to: input.to,
        vaultEventCount: snapshot.vaultEventCount,
        events: snapshot.events,
      });
    } catch {
      return { ok: false, reason: 'vault_unavailable' };
    }
  }
}
