// AI-002 consent-engine - granular, default-deny consent registry for training data intake.
//
// Catalog law (ALG-14a-e): consent is granular per (workspace, user, dataType), defaults to DENY,
// is append-only (the ledger records every grant and revoke), revocation is immediate, and a
// re-grant after revoke is allowed but audited. Quality of a data source is never a consent gate.
//
// Refusals:
//   consent-no-workspace / consent-no-user / consent-no-data-type / consent-no-purpose
//   consent-expiry-in-past:<expiresAt><=<now>
//   consent-no-active-grant:<workspace>:<user>:<dataType>   (revoke without an active, unexpired grant)
//
// State is passed in as { grants, ledger } and mutated only on success; refusals never mutate.
// grantIds are deterministic within a store ('cgr_1', 'cgr_2', ...); ledger events are 'cev_1', ...

export interface ConsentGrantRecord {
  grantId: string;
  workspace: string;
  user: string;
  dataType: string;
  purpose: string;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  supersededAt: number | null;
  regrants: number;
  fingerprint: string;
}

export interface ConsentLedgerEvent {
  eventId: string;
  kind: 'grant' | 'revoke';
  grantId: string;
  workspace: string;
  user: string;
  dataType: string;
  at: number;
}

export interface ConsentState {
  grants: ConsentGrantRecord[];
  ledger: ConsentLedgerEvent[];
}

export interface GrantConsentInput {
  workspace: string;
  user: string;
  dataType: string;
  purpose: string;
  expiresAt?: number | null;
  now: number;
}

export interface RevokeConsentInput {
  workspace: string;
  user: string;
  dataType: string;
  now: number;
}

export interface CheckConsentInput {
  workspace: string;
  user: string;
  dataType: string;
  now: number;
}

export type ConsentCheckState = 'granted' | 'denied' | 'expired';

export interface ConsentCheckResult {
  granted: boolean;
  state: ConsentCheckState;
  grantId: string | null;
  expiresAt: number | null;
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function fp(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h * 33 + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(-8);
}

// A grant is addressable while it is neither revoked nor superseded. A superseded grant is one
// that expired by time and was then granted over: the re-grant closes it so it can never resurface
// as "active" after the newer grant is revoked.
function activeGrantFor(state: ConsentState, workspace: string, user: string, dataType: string): ConsentGrantRecord | null {
  for (let i = state.grants.length - 1; i >= 0; i--) {
    const g = state.grants[i];
    if (g !== undefined && g.workspace === workspace && g.user === user && g.dataType === dataType && g.revokedAt === null && g.supersededAt === null) {
      return g;
    }
  }
  return null;
}

function isExpired(g: ConsentGrantRecord, now: number): boolean {
  return g.expiresAt !== null && now >= g.expiresAt;
}

function regrantCountFor(state: ConsentState, workspace: string, user: string, dataType: string): number {
  let n = 0;
  for (const g of state.grants) {
    if (g.workspace === workspace && g.user === user && g.dataType === dataType) n++;
  }
  return n;
}

// Grant consent for a triple. If an active, unexpired grant already exists, the call is idempotent:
// the existing grant is returned with duplicate:true and nothing is appended to the ledger.
// If the latest grant is expired (time passed it) it is superseded: a fresh grant is created and
// audited as a regrant. If the latest grant was revoked, a new grant is created and audited.
export function grantConsent(input: GrantConsentInput, state: ConsentState): Verdict<ConsentGrantRecord & { duplicate: boolean }> {
  if (!input) return fail('consent-no-input');
  if (!isNonEmptyString(input.workspace)) return fail('consent-no-workspace');
  if (!isNonEmptyString(input.user)) return fail('consent-no-user');
  if (!isNonEmptyString(input.dataType)) return fail('consent-no-data-type');
  if (!isNonEmptyString(input.purpose)) return fail('consent-no-purpose');
  if (!isNum(input.now)) return fail('consent-no-now');
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : input.expiresAt;
  if (expiresAt !== null) {
    if (!isNum(expiresAt)) return fail('consent-no-expiry');
    if (expiresAt <= input.now) return fail('consent-expiry-in-past:' + expiresAt + '<=' + input.now);
  }
  const existing = activeGrantFor(state, input.workspace, input.user, input.dataType);
  if (existing !== null && !isExpired(existing, input.now)) {
    return { ok: true, value: { ...existing, duplicate: true } };
  }
  if (existing !== null && isExpired(existing, input.now)) {
    // Supersede: the old grant expired by time; the re-grant closes it so it can never resurface.
    existing.supersededAt = input.now;
  }
  const grantId = 'cgr_' + (state.grants.length + 1);
  const regrants = regrantCountFor(state, input.workspace, input.user, input.dataType);
  const record: ConsentGrantRecord = {
    grantId,
    workspace: input.workspace,
    user: input.user,
    dataType: input.dataType,
    purpose: input.purpose,
    grantedAt: input.now,
    expiresAt,
    revokedAt: null,
    supersededAt: null,
    regrants,
    fingerprint: 'csntfp_' + fp(input.workspace + ':' + input.user + ':' + input.dataType + ':' + input.purpose + ':' + input.now),
  };
  state.grants.push(record);
  state.ledger.push({
    eventId: 'cev_' + (state.ledger.length + 1),
    kind: 'grant',
    grantId,
    workspace: input.workspace,
    user: input.user,
    dataType: input.dataType,
    at: input.now,
  });
  return { ok: true, value: { ...record, duplicate: false } };
}

// Revoke consent immediately. Requires an active, unexpired grant for the triple.
export function revokeConsent(input: RevokeConsentInput, state: ConsentState): Verdict<{ grantId: string; revokedAt: number }> {
  if (!input) return fail('consent-no-input');
  if (!isNonEmptyString(input.workspace)) return fail('consent-no-workspace');
  if (!isNonEmptyString(input.user)) return fail('consent-no-user');
  if (!isNonEmptyString(input.dataType)) return fail('consent-no-data-type');
  if (!isNum(input.now)) return fail('consent-no-now');
  const active = activeGrantFor(state, input.workspace, input.user, input.dataType);
  if (active === null || isExpired(active, input.now)) {
    return fail('consent-no-active-grant:' + input.workspace + ':' + input.user + ':' + input.dataType);
  }
  active.revokedAt = input.now;
  state.ledger.push({
    eventId: 'cev_' + (state.ledger.length + 1),
    kind: 'revoke',
    grantId: active.grantId,
    workspace: active.workspace,
    user: active.user,
    dataType: active.dataType,
    at: input.now,
  });
  return { ok: true, value: { grantId: active.grantId, revokedAt: input.now } };
}

// Check consent for a triple. Unknown triples are DENIED (never granted). Expired grants read as
// expired; revoked or absent grants read as denied. Checks never mutate state.
export function checkConsent(input: CheckConsentInput, state: ConsentState): Verdict<ConsentCheckResult> {
  if (!input) return fail('consent-no-input');
  if (!isNonEmptyString(input.workspace)) return fail('consent-no-workspace');
  if (!isNonEmptyString(input.user)) return fail('consent-no-user');
  if (!isNonEmptyString(input.dataType)) return fail('consent-no-data-type');
  if (!isNum(input.now)) return fail('consent-no-now');
  const active = activeGrantFor(state, input.workspace, input.user, input.dataType);
  if (active === null) {
    return { ok: true, value: { granted: false, state: 'denied', grantId: null, expiresAt: null } };
  }
  if (isExpired(active, input.now)) {
    return { ok: true, value: { granted: false, state: 'expired', grantId: active.grantId, expiresAt: active.expiresAt } };
  }
  return { ok: true, value: { granted: true, state: 'granted', grantId: active.grantId, expiresAt: active.expiresAt } };
}

// Read the ledger, optionally filtered. Reads never mutate state.
export function consentLedger(
  state: ConsentState,
  filter?: { workspace?: string; user?: string; dataType?: string; kind?: 'grant' | 'revoke' }
): ConsentLedgerEvent[] {
  const out: ConsentLedgerEvent[] = [];
  for (const ev of state.ledger) {
    if (filter?.workspace !== undefined && ev.workspace !== filter.workspace) continue;
    if (filter?.user !== undefined && ev.user !== filter.user) continue;
    if (filter?.dataType !== undefined && ev.dataType !== filter.dataType) continue;
    if (filter?.kind !== undefined && ev.kind !== filter.kind) continue;
    out.push({ ...ev });
  }
  return out;
}
