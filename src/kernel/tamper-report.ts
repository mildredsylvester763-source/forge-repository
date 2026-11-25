import { verifyChainAgainstAnchor, type EventChainAnchor, type VerifyReport } from './events.ts';
import type { StoredAnchor } from './anchor-store.ts';

/**
 * CO-076 — the tamper-evidence verification report.
 *
 * One document that says, honestly, whether the audit chain is intact AND whether an
 * INDEPENDENT checkpoint agrees with it. A chain that verifies locally but has no
 * agreeing external anchor is reported as unproven, not as sound — a report that
 * papered over a missing anchor would be the tamper evidence failing at its one job.
 */

export interface BackupEvidence {
  readonly name: string;
  readonly sha256: string;
  readonly ok: boolean;
  readonly reason?: string;
}

export interface TamperEvidenceReport {
  readonly generatedAt: string;
  readonly chain: { readonly ok: boolean; readonly count: number; readonly headHash?: string; readonly reason?: string };
  readonly anchor: {
    readonly present: boolean;
    readonly seq?: number;
    readonly hash?: string;
    readonly createdAt?: string;
    readonly agreement: 'agree' | 'mismatch' | 'unavailable' | 'invalid';
    readonly reason?: string;
  };
  readonly backups: readonly BackupEvidence[];
  /** True ONLY when the chain verifies AND the independent anchor agrees. */
  readonly verified: boolean;
  readonly failures: readonly string[];
}

export interface TamperEvidenceInput {
  readonly chain: VerifyReport;
  /** The checkpoint read from the independent store (CO-076 anchor), or null. */
  readonly anchor: StoredAnchor | EventChainAnchor | null;
  readonly now: Date;
  /** Optional: backup verification results, carried into the same report. */
  readonly backups?: readonly BackupEvidence[];
}

export function buildTamperEvidenceReport(input: TamperEvidenceInput): TamperEvidenceReport {
  const failures: string[] = [];
  const chain = input.chain.ok
    ? { ok: true as const, count: input.chain.count, headHash: input.chain.headHash }
    : { ok: false as const, count: input.chain.count, reason: input.chain.reason };
  if (!input.chain.ok) failures.push(`chain_${input.chain.reason}_at_${input.chain.brokenAtSeq}`);

  const anchored = verifyChainAgainstAnchor(input.chain, input.anchor as EventChainAnchor | null);
  let anchorBlock: TamperEvidenceReport['anchor'];
  if (!anchored.ok && 'reason' in anchored && String(anchored.reason).startsWith('anchor_')) {
    const reason = anchored.reason as string;
    if (reason === 'anchor_unavailable') {
      anchorBlock = { present: input.anchor !== null, agreement: 'unavailable', reason };
      failures.push(reason);
    } else {
      anchorBlock = {
        present: input.anchor !== null,
        seq: typeof input.anchor?.seq === 'number' ? input.anchor.seq : undefined,
        hash: typeof input.anchor?.hash === 'string' ? input.anchor.hash : undefined,
        agreement: 'invalid',
        reason,
      };
      failures.push(reason);
    }
  } else if (anchored.ok) {
    anchorBlock = {
      present: true,
      seq: input.anchor?.seq,
      hash: input.anchor?.hash,
      createdAt: (input.anchor as StoredAnchor | null)?.createdAt,
      agreement: 'agree',
    };
  } else {
    // The chain itself was already unsound; the anchor comparison is meaningless until that is fixed.
    anchorBlock = { present: input.anchor !== null, agreement: 'unavailable', reason: 'chain_unsound' };
  }

  const backups = input.backups ?? [];
  for (const backup of backups) {
    if (!backup.ok) failures.push(`backup_${backup.name}_${backup.reason ?? 'unverified'}`);
  }

  return {
    generatedAt: input.now.toISOString(),
    chain,
    anchor: anchorBlock,
    backups,
    verified: failures.length === 0,
    failures,
  };
}
