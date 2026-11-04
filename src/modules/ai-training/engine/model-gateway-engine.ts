// ============================================================================
// FILE: src/modules/ai-training/engine/model-gateway-engine.ts
// ============================================================================
// The provider-neutral model gateway (FORGE AI-048..052). Pure decisions,
// no I/O. What each function answers:
//   planGatewayRoute  - which outside provider serves a request, cheapest
//                       capable ACTIVE provider wins; the full ranked chain
//                       is returned for failover. Baseline beaten: naive
//                       first-registered or highest-maxTokens routing costs
//                       up to the full provider spread on every request.
//   recordProviderHealth - consecutive-failure circuit health; three in a
//                       row marks a provider unhealthy, one success resets.
//   planFailoverChain - ordered retry plan that never schedules an
//                       unhealthy provider; refuses by name when none remain.
//   byokFingerprint/validateByokKey - BYOK identity without ever storing
//                       the key itself (AI-050).
//   enforceDataPolicy - which data may go to which provider (AI-051):
//                       classification order public < internal <
//                       confidential < restricted; a request never leaves
//                       for a provider below its most sensitive tag.
//   aggregateProviderUsage - honest per-provider accounting (AI-052): real
//                       error rate, exact token sums, cost from the
//                       provider descriptor rates, no smoothing.
// Validation: pinned vectors + 4x500-case mulberry32(42) sweeps + order
// independence in model-gateway-engine.spec.ts (CI green is ground truth).

export interface ProviderDescriptor {
  id: string;
  costPer1kIn: number;
  costPer1kOut: number;
  maxTokens: number;
  active: boolean;
  /** Days the provider retains prompts/responses at source; 0 = retains nothing (AI-054). */
  retentionDays?: number;
}

export interface RouteDecision {
  primaryId: string;
  chain: string[];
  estimatedCostUsd: number;
  refusedInactive: string[];
}

export interface ProviderHealthState {
  providerId: string;
  consecutiveFailures: number;
  healthy: boolean;
}

export interface FailoverPlan {
  chain: Array<{ providerId: string; attempt: number }>;
  unhealthy: string[];
  primaryId: string;
}

export interface ByokKeyMeta {
  providerId: string;
  keyLength: number;
  fingerprint: string;
}

export interface UsageSample {
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  ok: boolean;
}

export interface ProviderAccounting {
  providerId: string;
  requests: number;
  failures: number;
  errorRate: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  avgLatencyMs: number;
}

export interface PolicyDecision {
  allowedTags: string[];
  maxTag: string | null;
  providerClearance: string;
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Sensitivity ladder: public < internal < confidential < restricted (AI-051). */
export const CLASSIFICATION_ORDER = ['public', 'internal', 'confidential', 'restricted'];

/** Three consecutive failures marks a provider unhealthy until a success resets it. */
export const GATEWAY_UNHEALTHY_THRESHOLD = 3;

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

const rankProviders = (providers: ProviderDescriptor[]): ProviderDescriptor[] =>
  providers.slice().sort((a, b) =>
    a.costPer1kOut !== b.costPer1kOut
      ? a.costPer1kOut - b.costPer1kOut
      : a.id < b.id ? -1 : 1,
  );

// --- AI-048: cheapest capable ACTIVE provider, full chain for failover ---
export function planGatewayRoute(input: {
  providers: ProviderDescriptor[];
  promptTokens: number;
  outputTokens: number;
}): Verdict<RouteDecision> {
  const { providers, promptTokens, outputTokens } = input;
  if (!Array.isArray(providers) || providers.length === 0) {
    return { ok: false, reason: 'gateway-no-providers' };
  }
  const active = providers.filter((p) => p.active);
  if (active.length === 0) {
    return { ok: false, reason: 'gateway-no-active-providers' };
  }
  const need = promptTokens + outputTokens;
  const capable = active.filter((p) => p.maxTokens >= need);
  if (capable.length === 0) {
    return { ok: false, reason: 'gateway-no-capable-provider:' + need };
  }
  const ranked = rankProviders(capable);
  const primary = ranked[0];
  const estimatedCostUsd = round6(
    (promptTokens / 1000) * primary.costPer1kIn + (outputTokens / 1000) * primary.costPer1kOut,
  );
  return {
    ok: true,
    value: {
      primaryId: primary.id,
      chain: ranked.map((p) => p.id),
      estimatedCostUsd,
      refusedInactive: providers.filter((p) => !p.active).map((p) => p.id),
    },
  };
}

// --- AI-049: circuit health - success resets, failure increments ---
export function recordProviderHealth(input: {
  providerId: string;
  consecutiveFailures: number;
  ok: boolean;
}): Verdict<ProviderHealthState> {
  const consecutiveFailures = input.ok ? 0 : input.consecutiveFailures + 1;
  return {
    ok: true,
    value: {
      providerId: input.providerId,
      consecutiveFailures,
      healthy: consecutiveFailures < GATEWAY_UNHEALTHY_THRESHOLD,
    },
  };
}

// --- AI-049: ordered failover plan; unhealthy providers are never scheduled ---
export function planFailoverChain(input: {
  providers: ProviderDescriptor[];
  health: Record<string, number>;
  maxRetriesPerProvider: number;
  promptTokens: number;
  outputTokens: number;
}): Verdict<FailoverPlan> {
  const { providers, health, maxRetriesPerProvider, promptTokens, outputTokens } = input;
  if (!Array.isArray(providers) || providers.length === 0) {
    return { ok: false, reason: 'gateway-no-providers' };
  }
  const need = promptTokens + outputTokens;
  const ranked = rankProviders(
    providers.filter((p) => p.active && p.maxTokens >= need),
  );
  const unhealthy = ranked
    .filter((p) => (health[p.id] ?? 0) >= GATEWAY_UNHEALTHY_THRESHOLD)
    .map((p) => p.id);
  const healthy = ranked.filter((p) => (health[p.id] ?? 0) < GATEWAY_UNHEALTHY_THRESHOLD);
  if (healthy.length === 0) {
    return { ok: false, reason: 'failover-no-healthy-providers' };
  }
  const attempts = Math.max(1, Math.floor(maxRetriesPerProvider));
  const chain: FailoverPlan['chain'] = [];
  for (const p of healthy) {
    for (let a = 1; a <= attempts; a++) {
      chain.push({ providerId: p.id, attempt: a });
    }
  }
  return { ok: true, value: { chain, unhealthy, primaryId: healthy[0].id } };
}

// --- AI-050: BYOK identity - the key NEVER leaves this function ---
export function byokFingerprint(providerId: string, key: string): string {
  let h = 5381;
  const s = providerId + ':' + key;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return 'byok_' + h.toString(16).padStart(8, '0').slice(-8);
}

export function validateByokKey(key: string): Verdict<{ keyLength: number }> {
  const trimmed = String(key ?? '').trim();
  if (trimmed.length < 8) {
    return { ok: false, reason: 'byok-invalid-key' };
  }
  return { ok: true, value: { keyLength: trimmed.length } };
}

// --- AI-051: per-request data policy - no data below its clearance level ---
export function enforceDataPolicy(input: {
  dataTags: string[];
  providerClearance: string;
}): Verdict<PolicyDecision> {
  const { dataTags, providerClearance } = input;
  const clearanceIdx = CLASSIFICATION_ORDER.indexOf(String(providerClearance ?? ''));
  if (clearanceIdx < 0) {
    return { ok: false, reason: 'policy-unknown-clearance:' + providerClearance };
  }
  const tags = Array.from(
    new Set(
      (dataTags ?? [])
        .map((t) => String(t).trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  for (const t of tags) {
    if (!CLASSIFICATION_ORDER.includes(t)) {
      return { ok: false, reason: 'policy-unknown-tag:' + t };
    }
  }
  let maxIdx = -1;
  for (const t of tags) {
    maxIdx = Math.max(maxIdx, CLASSIFICATION_ORDER.indexOf(t));
  }
  if (tags.length > 0 && maxIdx > clearanceIdx) {
    return {
      ok: false,
      reason: 'policy-clearance-exceeded:' + CLASSIFICATION_ORDER[maxIdx] + '>' + providerClearance,
    };
  }
  return {
    ok: true,
    value: {
      allowedTags: tags,
      maxTag: tags.length ? CLASSIFICATION_ORDER[maxIdx] : null,
      providerClearance,
    },
  };
}

// --- AI-052: honest per-provider accounting ---
export function aggregateProviderUsage(input: {
  providerId: string;
  descriptor: { costPer1kIn: number; costPer1kOut: number };
  samples: UsageSample[];
}): Verdict<ProviderAccounting> {
  const { providerId, descriptor, samples } = input;
  if (!Array.isArray(samples) || samples.length === 0) {
    return { ok: false, reason: 'accounting-no-samples' };
  }
  let tokensIn = 0;
  let tokensOut = 0;
  let failures = 0;
  let latencySum = 0;
  for (const s of samples) {
    tokensIn += s.tokensIn;
    tokensOut += s.tokensOut;
    if (s.ok === false) failures++;
    latencySum += s.latencyMs;
  }
  const requests = samples.length;
  return {
    ok: true,
    value: {
      providerId,
      requests,
      failures,
      errorRate: round6(failures / requests),
      tokensIn,
      tokensOut,
      costUsd: round6(
        (tokensIn / 1000) * descriptor.costPer1kIn +
        (tokensOut / 1000) * descriptor.costPer1kOut,
      ),
      avgLatencyMs: round6(latencySum / requests),
    },
  };
}
