// Pure test data lifecycle engine for live agent testing (FORGE TQ-029).
// Test accounts are derived deterministically from a session seed: the
// same seed always produces the same usernames, emails and passwords, so
// a seeded account can be re-derived at any time without storing secrets
// in the engine. Every fixture email lives on the reserved forgelocal.test
// domain, which can never resolve to a real host or reach a real inbox.
// Cleanup only happens on terminal sessions, is idempotent and always
// returns a named plan.

export const FIXTURE_DOMAIN = 'forgelocal.test';

const ACCOUNT_ROLES = ['shopper', 'editor', 'viewer', 'admin'];
const MAX_ACCOUNTS = 12;
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITS = '23456789';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function derivePassword(rnd: () => number): string {
  const chars: string[] = [];
  for (let i = 0; i < 5; i++) {
    chars.push(LOWER[Math.floor(rnd() * LOWER.length)]!);
  }
  for (let i = 0; i < 4; i++) {
    chars.push(UPPER[Math.floor(rnd() * UPPER.length)]!);
  }
  for (let i = 0; i < 3; i++) {
    chars.push(DIGITS[Math.floor(rnd() * DIGITS.length)]!);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = tmp;
  }
  return chars.join('');
}

export interface TestAccountPlan {
  username: string;
  email: string;
  password: string;
  role: string;
}

export interface AccountVerdict {
  ok: boolean;
  reason?: string;
  domain?: string;
  accounts?: TestAccountPlan[];
}

export interface CleanupVerdict {
  ok: boolean;
  reason?: string;
  alreadyClean?: boolean;
  plan?: string[];
  pending?: number;
  cleaned?: number;
}

export interface CleanupIntent {
  status?: unknown;
  pending?: unknown;
  cleaned?: unknown;
}

function norm(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function deriveTestAccounts(seed: unknown, count: unknown): AccountVerdict {
  const s = norm(seed).slice(0, 32);
  if (s.length === 0) {
    return { ok: false, reason: 'data-seed-missing' };
  }
  let n = 3;
  if (count !== undefined && count !== null) {
    const c = Number(count);
    if (!Number.isInteger(c) || c < 1 || c > MAX_ACCOUNTS) {
      return { ok: false, reason: 'data-count-invalid:' + String(count) };
    }
    n = c;
  }
  const slugRaw = s.replace(/[^a-z0-9]/g, '');
  const slug = slugRaw.length > 0 ? slugRaw.slice(0, 12) : 'session';
  const rnd = mulberry32(hashSeed(s));
  const accounts: TestAccountPlan[] = [];
  for (let i = 0; i < n; i++) {
    const username = 'forge-' + slug + '-' + (i + 1);
    accounts.push({
      username,
      email: username + '@' + FIXTURE_DOMAIN,
      password: derivePassword(rnd),
      role: ACCOUNT_ROLES[i % ACCOUNT_ROLES.length]!,
    });
  }
  return { ok: true, domain: FIXTURE_DOMAIN, accounts };
}

export function checkCleanup(input: CleanupIntent): CleanupVerdict {
  const status = norm(input?.status);
  if (status.length === 0) {
    return { ok: false, reason: 'data-status-missing' };
  }
  if (!TERMINAL_STATUSES.includes(status)) {
    return { ok: false, reason: 'data-cleanup-status-refused:' + status };
  }
  const pending = Number(input?.pending);
  if (!Number.isInteger(pending) || pending < 0) {
    return { ok: false, reason: 'data-pending-invalid:' + String(input?.pending) };
  }
  const cleaned = Number(input?.cleaned);
  if (!Number.isInteger(cleaned) || cleaned < 0) {
    return { ok: false, reason: 'data-cleaned-invalid:' + String(input?.cleaned) };
  }
  if (pending === 0) {
    return { ok: true, alreadyClean: true, plan: [], pending: 0, cleaned };
  }
  return {
    ok: true,
    alreadyClean: false,
    plan: ['disable fixtures', 'purge seeded uploads', 'restore app settings', 'remove test accounts'],
    pending,
    cleaned,
  };
}
