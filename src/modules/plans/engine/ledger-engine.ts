/**
 * FORGE plan hooks — Hook 3 (credit entries carry an engine tag) and Hook 7 (money as whole
 * numbers). The ledger is append-only: a balance is ALWAYS the sum of entries, never a
 * stored number. Every entry carries the engine it belongs to (empty string = general
 * credits), where it came from, when it stops working, the job that spent it and the real
 * cost to Forge in whole micro-dollars for margin checks.
 *
 * Spend order is law: for an engine feature, that engine's credits go first, then general
 * credits. Inside a group, expiring free-window credits go first, then plan credits, then
 * pass credits, then top-ups; earlier expiry goes first. A spend is atomic: if the pools
 * cannot cover it, nothing is written.
 */
import { isEngineCode } from './plan-engine.ts';

export type CreditSource = 'free_window' | 'plan' | 'pass' | 'top_up';

export interface LedgerEntry {
  readonly entryId: string;
  readonly userId: string;
  /** Engine tag; the empty string means general credits. */
  readonly engine: string;
  readonly source: CreditSource;
  /** Positive when added, negative when spent. */
  readonly amount: number;
  readonly expiresAt: number | null;
  readonly jobId: string | null;
  /** For spend entries: the grant entry this spend drew from. Null on grants. */
  readonly sourceEntryId: string | null;
  /** The job's real cost to Forge, whole micro-dollars. */
  readonly costUsdMicros: number | null;
  readonly createdAt: number;
}

export interface GrantInput {
  readonly engine: string;
  readonly source: CreditSource;
  readonly amount: number;
  readonly expiresAt: number | null;
  readonly jobId: string | null;
}

export interface GrantResult {
  readonly entries: readonly LedgerEntry[];
  readonly entry: LedgerEntry;
}

export type GrantParseResult = { ok: true; grant: GrantInput } | { ok: false; reason: string };

const CREDIT_SOURCE_ORDER: Record<CreditSource, number> = { free_window: 0, plan: 1, pass: 2, top_up: 3 };

const CREDIT_SOURCES: readonly string[] = ['free_window', 'plan', 'pass', 'top_up'];

/** Parse and validate a credit grant. Rejections are named reasons, never thrown. */
export function parseGrant(raw: unknown): GrantParseResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'bad_payload' };
  const r = raw as Record<string, unknown>;
  const engine = r.engine ?? '';
  if (typeof engine !== 'string' || (engine !== '' && !isEngineCode(engine))) return { ok: false, reason: 'bad_engine' };
  const source = r.source;
  if (typeof source !== 'string' || !CREDIT_SOURCES.includes(source)) return { ok: false, reason: 'bad_source' };
  const amount = r.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > 1e9) return { ok: false, reason: 'bad_amount' };
  const expiresAt = r.expiresAt ?? null;
  if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt <= 0)) return { ok: false, reason: 'bad_expires' };
  const jobId = r.jobId ?? null;
  if (jobId !== null && (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 128)) return { ok: false, reason: 'bad_job' };
  return { ok: true, grant: { engine, source: source as CreditSource, amount, expiresAt, jobId } };
}

/** Append a grant. Entry ids are numbered per user by the ledger length. The caller's array is never mutated. */
export function appendGrant(entries: readonly LedgerEntry[], userId: string, grant: GrantInput, now: number): GrantResult {
  const entry: LedgerEntry = {
    entryId: 'led_' + userId + '_' + (entries.length + 1),
    userId,
    engine: grant.engine,
    source: grant.source,
    amount: grant.amount,
    expiresAt: grant.expiresAt,
    jobId: grant.jobId,
    sourceEntryId: null,
    costUsdMicros: null,
    createdAt: now,
  };
  return { entries: [...entries, entry], entry };
}

/** The balance for one engine pool: the sum of entries, with expired grants counted as dead. */
export function creditBalance(entries: readonly LedgerEntry[], now: number, engine: string): number {
  let balance = 0;
  for (const entry of entries) {
    if (entry.engine !== engine) continue;
    if (entry.amount > 0 && entry.expiresAt !== null && entry.expiresAt <= now) continue;
    balance += entry.amount;
  }
  return balance;
}

export interface EngineBalance {
  readonly engine: string;
  readonly balance: number;
}

/** Every pool the user has entries for: general first, then engines alphabetically. */
export function balanceByEngine(entries: readonly LedgerEntry[], now: number): { general: number; engines: readonly EngineBalance[] } {
  const engines = new Set<string>();
  for (const entry of entries) {
    if (entry.engine !== '') engines.add(entry.engine);
  }
  const list = [...engines].sort().map((engine) => ({ engine, balance: creditBalance(entries, now, engine) }));
  return { general: creditBalance(entries, now, ''), engines: list };
}

export interface SpendInput {
  /** The engine charging the job; the empty string is a general feature. */
  readonly engine: string;
  readonly amount: number;
  readonly jobId: string;
  readonly costUsdMicros: number;
}

export interface SpendBreakdownEntry {
  readonly entryId: string;
  readonly source: CreditSource;
  readonly used: number;
}

export type SpendResult =
  | { ok: true; entries: readonly LedgerEntry[]; spent: number; from: readonly SpendBreakdownEntry[] }
  | { ok: false; reason: 'insufficient_credits'; shortfall: number };

/**
 * Spend credits, engine pool first then general, free-window before plan before pass before
 * top-up, earlier expiry first. The job's cost lands on the first spend entry. Atomic: an
 * uncovered spend writes nothing. The caller's array is never mutated.
 */
export function spend(entries: readonly LedgerEntry[], userId: string, input: SpendInput, now: number): SpendResult {
  const spentBySource = new Map<string, number>();
  for (const entry of entries) {
    if (entry.amount < 0 && entry.sourceEntryId !== null) {
      spentBySource.set(entry.sourceEntryId, (spentBySource.get(entry.sourceEntryId) ?? 0) + -entry.amount);
    }
  }
  const pool = (engine: string): readonly LedgerEntry[] =>
    entries
      .filter((entry) => entry.engine === engine && entry.amount > 0 && (entry.expiresAt === null || entry.expiresAt > now))
      .map((entry) => ({ ...entry, amount: entry.amount - (spentBySource.get(entry.entryId) ?? 0) }))
      .filter((entry) => entry.amount > 0)
      .sort((a, b) => {
        const bySource = CREDIT_SOURCE_ORDER[a.source] - CREDIT_SOURCE_ORDER[b.source];
        if (bySource !== 0) return bySource;
        const aExpiry = a.expiresAt ?? Number.MAX_SAFE_INTEGER;
        const bExpiry = b.expiresAt ?? Number.MAX_SAFE_INTEGER;
        if (aExpiry !== bExpiry) return aExpiry - bExpiry;
        return a.entryId < b.entryId ? -1 : 1;
      });
  const groups: Array<readonly LedgerEntry[]> = input.engine === '' ? [pool('')] : [pool(input.engine), pool('')];
  let remaining = input.amount;
  const consumed: Array<{ entry: LedgerEntry; used: number }> = [];
  for (const group of groups) {
    for (const entry of group) {
      if (remaining === 0) break;
      const used = Math.min(remaining, entry.amount);
      consumed.push({ entry, used });
      remaining -= used;
    }
    if (remaining === 0) break;
  }
  if (remaining > 0) return { ok: false, reason: 'insufficient_credits', shortfall: remaining };
  const negatives: LedgerEntry[] = consumed.map((item, index) => ({
    entryId: 'led_' + userId + '_' + (entries.length + index + 1),
    userId,
    engine: item.entry.engine,
    source: item.entry.source,
    amount: -item.used,
    expiresAt: item.entry.expiresAt,
    jobId: input.jobId,
    sourceEntryId: item.entry.entryId,
    costUsdMicros: index === 0 ? input.costUsdMicros : 0,
    createdAt: now,
  }));
  const from: SpendBreakdownEntry[] = consumed.map((item) => ({ entryId: item.entry.entryId, source: item.entry.source, used: item.used }));
  return { ok: true, entries: [...entries, ...negatives], spent: input.amount, from };
}
