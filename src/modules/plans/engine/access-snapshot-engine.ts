/**
 * Hook 9 - cached access for bad networks, pure engine. A signed copy of what the user
 * may use (plan, passes, expiry) that works offline for a few hours. The server stays the
 * boss: the snapshot carries issuedAt/expiresAt, an expired snapshot is refused by name,
 * and the signature (the service's job, HMAC like payment events) can never be forged by
 * the client. Pure and deterministic.
 */

export interface AccessSnapshot {
  readonly userId: string;
  readonly plan: string;
  readonly passes: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type SnapshotResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const HOUR = 3_600_000;

export function assembleAccessSnapshot(input: {
  userId: string;
  plan: string;
  passes: readonly string[];
  now: number;
  ttlMs: number;
}): SnapshotResult<AccessSnapshot> {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (userId === '') return { ok: false, reason: 'snapshot-no-user' };
  const plan = typeof input.plan === 'string' ? input.plan.trim() : '';
  if (plan === '') return { ok: false, reason: 'snapshot-bad-plan' };
  if (!Array.isArray(input.passes) || input.passes.some((p) => typeof p !== 'string')) return { ok: false, reason: 'snapshot-bad-passes' };
  if (!Number.isInteger(input.ttlMs) || input.ttlMs < HOUR || input.ttlMs > 72 * HOUR) return { ok: false, reason: 'snapshot-bad-ttl' };
  if (!Number.isInteger(input.now) || input.now < 0) return { ok: false, reason: 'snapshot-bad-now' };
  const passes = [...new Set(input.passes)].sort();
  return { ok: true, value: { userId, plan, passes, issuedAt: input.now, expiresAt: input.now + input.ttlMs } };
}

export function verifyAccessSnapshot(snapshot: unknown, now: number): SnapshotResult<{ snapshot: AccessSnapshot; remainingMs: number }> {
  if (typeof snapshot !== 'object' || snapshot === null) return { ok: false, reason: 'snapshot-bad-shape' };
  const s = snapshot as Record<string, unknown>;
  const userId = typeof s.userId === 'string' ? s.userId.trim() : '';
  const plan = typeof s.plan === 'string' ? s.plan.trim() : '';
  const issuedAt = s.issuedAt;
  const expiresAt = s.expiresAt;
  const passes = s.passes;
  if (
    userId === '' || plan === '' ||
    typeof issuedAt !== 'number' || !Number.isInteger(issuedAt) || issuedAt < 0 ||
    typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt < issuedAt ||
    !Array.isArray(passes) || passes.some((p) => typeof p !== 'string')
  ) {
    return { ok: false, reason: 'snapshot-bad-shape' };
  }
  if (!Number.isInteger(now) || now < 0) return { ok: false, reason: 'snapshot-bad-now' };
  if (now > expiresAt) return { ok: false, reason: 'snapshot-expired:' + userId };
  const normalized: AccessSnapshot = { userId, plan, passes: [...new Set(passes as string[])].sort(), issuedAt, expiresAt };
  return { ok: true, value: { snapshot: normalized, remainingMs: expiresAt - now } };
}
