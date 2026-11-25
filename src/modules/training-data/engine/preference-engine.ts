// AI-009 preference-engine - explicit preference signals, consent-gated and append-only.
//
// Catalog law (ALG-14a/e): a preference signal is stored only with the user's consent on
// record. Signals are explicit (like, dislike, skip), never inferred. One signal per
// (user, item, signal) identity: re-submitting the same signal is idempotent, the existing
// record is returned and nothing is appended. Reads never mutate.
//
// Refusals:
//   preference-no-input / preference-no-user / preference-no-item
//   preference-no-signal / preference-invalid-signal:<signal>
//   preference-no-consent / preference-consent-required / preference-no-now

export type PreferenceSignal = 'like' | 'dislike' | 'skip';

export const PREFERENCE_SIGNALS: string[] = ['like', 'dislike', 'skip'];

export interface PreferenceRecord {
  prefId: string;
  user: string;
  item: string;
  signal: PreferenceSignal;
  fingerprint: string;
  createdAt: number;
}

export interface StorePreferenceInput {
  user: string;
  item: string;
  signal: string;
  consent: { granted: boolean };
  now: number;
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

// Store one explicit preference signal. Consent is checked by the caller (AI-002) and passed
// in as a decision. The store is passed in and appended to by the caller on success; this
// function never mutates it. Duplicate identity wins.
export function storePreference(
  input: StorePreferenceInput,
  store: PreferenceRecord[]
): Verdict<PreferenceRecord & { duplicate: boolean }> {
  if (!input) return fail('preference-no-input');
  if (!isNonEmptyString(input.user)) return fail('preference-no-user');
  if (!isNonEmptyString(input.item)) return fail('preference-no-item');
  if (input.signal === undefined || input.signal === null) return fail('preference-no-signal');
  if (!PREFERENCE_SIGNALS.includes(input.signal)) return fail('preference-invalid-signal:' + String(input.signal));
  if (!input.consent || typeof input.consent !== 'object') return fail('preference-no-consent');
  if (input.consent.granted !== true) return fail('preference-consent-required');
  if (!isNum(input.now)) return fail('preference-no-now');
  const identity = input.user + ':' + input.item + ':' + input.signal;
  const fingerprint = 'pfp_' + fp(identity);
  const dup = store.find((p) => p.fingerprint === fingerprint);
  if (dup) return { ok: true, value: { ...dup, duplicate: true } };
  const record: PreferenceRecord = {
    prefId: 'prf_' + (store.length + 1),
    user: input.user,
    item: input.item,
    signal: input.signal as PreferenceSignal,
    fingerprint,
    createdAt: input.now,
  };
  return { ok: true, value: { ...record, duplicate: false } };
}

// Read one user's stored signals. Reads never mutate.
export function preferencesFor(user: string, store: PreferenceRecord[]): PreferenceRecord[] {
  const out: PreferenceRecord[] = [];
  for (const p of store) {
    if (p.user === user) out.push({ ...p });
  }
  return out;
}
