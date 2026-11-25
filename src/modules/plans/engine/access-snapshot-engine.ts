/**
 * Hook 9 - cached access for bad networks, pure engine. A signed copy of what the user
 * may use (plan, passes, expiry) that works offline for a few hours. The server stays the
 * boss: the snapshot carries issuedAt/expiresAt, an expired snapshot is refused by name,
 * and a server-only Ed25519 signing key lets clients verify the snapshot with a public key
 * without exposing an HMAC secret to the device. Shape and expiry checks stay pure.
 */

export interface AccessSnapshot {
  readonly userId: string;
  readonly plan: string;
  readonly passes: readonly string[];
  /** Null means the plan came from a legacy non-expiring entitlement record. */
  readonly planExpiresAt: number | null;
  /** Null means a legacy pass has no subscription-item expiry. */
  readonly passExpiresAt: Readonly<Record<string, number | null>>;
  readonly issuedAt: number;
  /** The cache TTL. Individual entitlements may expire earlier and are downgraded independently. */
  readonly expiresAt: number;
}

export type SnapshotResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const HOUR = 3_600_000;

export function assembleAccessSnapshot(input: {
  userId: string;
  plan: string;
  passes: readonly string[];
  planExpiresAt?: number | null;
  passExpiresAt?: Readonly<Record<string, number | null>>;
  now: number;
  ttlMs: number;
}): SnapshotResult<AccessSnapshot> {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (userId === '') return { ok: false, reason: 'snapshot-no-user' };
  const plan = typeof input.plan === 'string' ? input.plan.trim() : '';
  if (plan === '') return { ok: false, reason: 'snapshot-bad-plan' };
  if (!Array.isArray(input.passes) || input.passes.some((p) => typeof p !== 'string' || p.trim() === '')) return { ok: false, reason: 'snapshot-bad-passes' };
  if (!Number.isInteger(input.ttlMs) || input.ttlMs < HOUR || input.ttlMs > 72 * HOUR) return { ok: false, reason: 'snapshot-bad-ttl' };
  if (!Number.isInteger(input.now) || input.now < 0) return { ok: false, reason: 'snapshot-bad-now' };
  const passes = [...new Set(input.passes)].sort();
  const planExpiresAt = input.planExpiresAt ?? null;
  if (planExpiresAt !== null && (!Number.isInteger(planExpiresAt) || planExpiresAt <= input.now)) {
    return { ok: false, reason: 'snapshot-bad-plan-expiry' };
  }
  const suppliedPassExpiries = input.passExpiresAt ?? {};
  if (typeof suppliedPassExpiries !== 'object' || suppliedPassExpiries === null || Array.isArray(suppliedPassExpiries)) {
    return { ok: false, reason: 'snapshot-bad-pass-expiry' };
  }
  const passExpiresAt: Record<string, number | null> = {};
  for (const pass of passes) {
    const expiry = suppliedPassExpiries[pass] ?? null;
    if (expiry !== null && (!Number.isInteger(expiry) || expiry <= input.now)) {
      return { ok: false, reason: 'snapshot-bad-pass-expiry:' + pass };
    }
    passExpiresAt[pass] = expiry;
  }
  if (Object.keys(suppliedPassExpiries).some((pass) => !passes.includes(pass))) {
    return { ok: false, reason: 'snapshot-unknown-pass-expiry' };
  }
  return {
    ok: true,
    value: {
      userId,
      plan,
      passes,
      planExpiresAt,
      passExpiresAt,
      issuedAt: input.now,
      expiresAt: input.now + input.ttlMs,
    },
  };
}

export function verifyAccessSnapshot(snapshot: unknown, now: number): SnapshotResult<{ snapshot: AccessSnapshot; remainingMs: number }> {
  if (typeof snapshot !== 'object' || snapshot === null) return { ok: false, reason: 'snapshot-bad-shape' };
  const s = snapshot as Record<string, unknown>;
  const userId = typeof s.userId === 'string' ? s.userId.trim() : '';
  const rawPlan = typeof s.plan === 'string' ? s.plan.trim() : '';
  const issuedAt = s.issuedAt;
  const expiresAt = s.expiresAt;
  const rawPasses = s.passes;
  if (
    userId === '' || rawPlan === '' ||
    typeof issuedAt !== 'number' || !Number.isInteger(issuedAt) || issuedAt < 0 ||
    typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt <= issuedAt ||
    !Array.isArray(rawPasses) || rawPasses.some((p) => typeof p !== 'string' || p.trim() === '')
  ) {
    return { ok: false, reason: 'snapshot-bad-shape' };
  }
  if (!Number.isInteger(now) || now < 0) return { ok: false, reason: 'snapshot-bad-now' };
  if (now >= expiresAt) return { ok: false, reason: 'snapshot-expired:' + userId };
  const passes = [...new Set(rawPasses as string[])].sort();
  const rawPlanExpiry = s.planExpiresAt === undefined ? null : s.planExpiresAt;
  if (rawPlanExpiry !== null && (typeof rawPlanExpiry !== 'number' || !Number.isInteger(rawPlanExpiry) || rawPlanExpiry <= issuedAt)) {
    return { ok: false, reason: 'snapshot-bad-shape' };
  }
  const rawPassExpiries = s.passExpiresAt === undefined ? {} : s.passExpiresAt;
  if (typeof rawPassExpiries !== 'object' || rawPassExpiries === null || Array.isArray(rawPassExpiries)) {
    return { ok: false, reason: 'snapshot-bad-shape' };
  }
  const passExpiresAt: Record<string, number | null> = {};
  for (const pass of passes) {
    const expiry = (rawPassExpiries as Record<string, unknown>)[pass] ?? null;
    if (expiry !== null && (typeof expiry !== 'number' || !Number.isInteger(expiry) || expiry <= issuedAt)) {
      return { ok: false, reason: 'snapshot-bad-shape' };
    }
    passExpiresAt[pass] = expiry as number | null;
  }
  if (Object.keys(rawPassExpiries).some((pass) => !passes.includes(pass))) {
    return { ok: false, reason: 'snapshot-bad-shape' };
  }
  const planExpiresAt = rawPlanExpiry as number | null;
  const normalized: AccessSnapshot = {
    userId,
    plan: planExpiresAt !== null && now >= planExpiresAt ? 'free' : rawPlan,
    passes: passes.filter((pass) => passExpiresAt[pass] === null || now < (passExpiresAt[pass] as number)),
    planExpiresAt,
    passExpiresAt,
    issuedAt,
    expiresAt,
  };
  return { ok: true, value: { snapshot: normalized, remainingMs: expiresAt - now } };
}
