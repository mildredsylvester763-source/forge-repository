/**
 * FORGE TQ-037 Contract testing engine.
 *
 * Market laws (Pact, Spring Cloud Contract):
 * - Consumer-driven contracts: a pact is a collection of concrete
 *   request/response interactions the consumer actually exercised.
 * - Provider verification replays each interaction against the running
 *   provider and checks route, status and body.
 * - The expected body is a deep SUBSET of the actual body: extra keys
 *   in the provider response are allowed, missing or unequal expected
 *   keys are violations.
 * - Methods are normalized to uppercase and paths to a single leading
 *   slash with collapsed duplicate slashes.
 *
 * Pure engine: no framework imports, no I/O, fully deterministic.
 */

export const CONTRACT_INTERACTION_LIMIT = 50;
export const CONTRACT_NAME_LIMIT = 100;

export interface PactInteractionInput {
  description?: unknown;
  request?: { method?: unknown; path?: unknown };
  response?: { status?: unknown; body?: unknown };
}

export interface ProviderResponseInput {
  method?: unknown;
  path?: unknown;
  status?: unknown;
  body?: unknown;
}

export interface BuildPactInput {
  consumer?: unknown;
  provider?: unknown;
  interactions?: unknown;
}

export interface VerifyContractInput {
  consumer?: unknown;
  provider?: unknown;
  interactions?: unknown;
  providerResponses?: unknown;
}

export interface NormalizedInteraction {
  description: string;
  request: { method: string; path: string };
  response: { status: number; body?: unknown };
}

export interface PactResult {
  ok: boolean;
  reason?: string;
  consumer?: string;
  provider?: string;
  interactions?: NormalizedInteraction[];
  count?: number;
  verified?: number;
}

export function normalizeMethod(method: unknown): string {
  return typeof method === 'string' ? method.trim().toUpperCase() : '';
}

export function normalizePath(path: unknown): string {
  if (typeof path !== 'string') return '';
  let out = path.trim().replace(/\/{2,}/g, '/');
  if (!out.startsWith('/')) out = '/' + out;
  return out;
}

export function buildPact(input: BuildPactInput): PactResult {
  const consumer = typeof input?.consumer === 'string' ? input.consumer.trim() : '';
  if (consumer.length === 0) return { ok: false, reason: 'contract-consumer-missing' };
  if (consumer.length > CONTRACT_NAME_LIMIT) return { ok: false, reason: 'contract-consumer-too-long' };
  const provider = typeof input?.provider === 'string' ? input.provider.trim() : '';
  if (provider.length === 0) return { ok: false, reason: 'contract-provider-missing' };
  if (provider.length > CONTRACT_NAME_LIMIT) return { ok: false, reason: 'contract-provider-too-long' };
  const raw = Array.isArray(input?.interactions) ? (input.interactions as unknown[]) : [];
  if (raw.length === 0) return { ok: false, reason: 'contract-interactions-empty' };
  if (raw.length > CONTRACT_INTERACTION_LIMIT) {
    return { ok: false, reason: 'contract-interactions-limit:' + raw.length };
  }
  const interactions: NormalizedInteraction[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as PactInteractionInput;
    const description = typeof entry?.description === 'string' ? entry.description.trim() : '';
    if (description.length === 0) return { ok: false, reason: 'contract-description-missing:' + (i + 1) };
    const method = normalizeMethod(entry?.request?.method);
    if (method.length === 0) return { ok: false, reason: 'contract-method-missing:' + (i + 1) };
    const path = normalizePath(entry?.request?.path);
    if (path.length === 0 || path === '/') return { ok: false, reason: 'contract-path-missing:' + (i + 1) };
    const status: unknown = entry?.response?.status;
    if (status === undefined) return { ok: false, reason: 'contract-status-missing:' + (i + 1) };
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
      return { ok: false, reason: 'contract-status-invalid:' + (i + 1) + ':' + String(status) };
    }
    interactions.push({
      description,
      request: { method, path },
      response: { status, body: entry?.response?.body },
    });
  }
  return { ok: true, consumer, provider, interactions, count: interactions.length };
}

function bodySubset(expected: unknown, actual: unknown, path: string): string | null {
  if (expected === undefined) return null;
  if (actual === undefined) return path;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return path;
    if (actual.length !== expected.length) return path;
    for (let i = 0; i < expected.length; i++) {
      const sub = bodySubset(expected[i], actual[i], path + '[' + i + ']');
      if (sub !== null) return sub;
    }
    return null;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return path;
    for (const key of Object.keys(expected as Record<string, unknown>)) {
      const child = path === '$' ? '$.' + key : path + '.' + key;
      if (!(key in (actual as Record<string, unknown>))) return child;
      const sub = bodySubset(
        (expected as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key],
        child,
      );
      if (sub !== null) return sub;
    }
    return null;
  }
  return expected === actual ? null : path;
}

export function verifyContract(input: VerifyContractInput): PactResult {
  const pact = buildPact(input);
  if (!pact.ok) return pact;
  const rawResponses = Array.isArray(input?.providerResponses)
    ? (input.providerResponses as unknown[])
    : [];
  if (rawResponses.length === 0) return { ok: false, reason: 'contract-responses-missing' };
  const responses: ProviderResponseInput[] = [];
  for (let i = 0; i < rawResponses.length; i++) {
    const response = rawResponses[i] as ProviderResponseInput;
    const method = normalizeMethod(response?.method);
    if (method.length === 0) return { ok: false, reason: 'contract-response-method-missing:' + (i + 1) };
    const path = normalizePath(response?.path);
    if (path.length === 0 || path === '/') return { ok: false, reason: 'contract-response-path-missing:' + (i + 1) };
    const status: unknown = response?.status;
    if (status === undefined) return { ok: false, reason: 'contract-response-status-missing:' + (i + 1) };
    if (typeof status !== 'number' || !Number.isInteger(status)) {
      return { ok: false, reason: 'contract-response-status-invalid:' + (i + 1) + ':' + String(status) };
    }
    responses.push(response);
  }
  const interactions = pact.interactions ?? [];
  for (let i = 0; i < interactions.length; i++) {
    const interaction = interactions[i]!;
    const route = responses.find(
      (r) => normalizeMethod(r.method) === interaction.request.method && normalizePath(r.path) === interaction.request.path,
    );
    if (!route) {
      return {
        ok: false,
        reason:
          'contract-route-missing:' + (i + 1) + ':' + interaction.request.method + ':' + interaction.request.path,
      };
    }
    const actualStatus: unknown = route.status;
    if (actualStatus !== interaction.response.status) {
      return {
        ok: false,
        reason:
          'contract-status-mismatch:' + (i + 1) + ':' + String(interaction.response.status) + ':' + String(actualStatus),
      };
    }
    const mismatch = bodySubset(interaction.response.body, route.body, '$');
    if (mismatch !== null) {
      return { ok: false, reason: 'contract-body-mismatch:' + (i + 1) + ':' + mismatch };
    }
  }
  return {
    ok: true,
    consumer: pact.consumer,
    provider: pact.provider,
    interactions: pact.interactions,
    verified: pact.count,
  };
}
