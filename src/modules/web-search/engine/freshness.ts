// Pure freshness engine for the web search tool (FORGE AI-060). A source is
// fresh within 30 days, current within a year, stale after that, unknown when
// no date is present. Future dates are refused by name: a page that claims to
// be published in the future is a data error, never a freshness signal.

export type FreshnessBand = 'fresh' | 'current' | 'stale' | 'unknown';

export interface FreshnessVerdict {
  ok: boolean;
  band?: FreshnessBand;
  ageDays?: number | null;
  reason?: string;
}

export function freshnessBand(
  publishedAt: string | null | undefined,
  now: Date,
): FreshnessVerdict {
  if (publishedAt === null || publishedAt === undefined || publishedAt === '') {
    return { ok: true, band: 'unknown', ageDays: null };
  }
  if (typeof publishedAt !== 'string') {
    return { ok: false, reason: 'freshness-invalid-date' };
  }
  const trimmed = publishedAt.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return { ok: false, reason: 'freshness-invalid-date:' + trimmed.slice(0, 40) };
  }
  const ts = Date.parse(trimmed);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'freshness-invalid-date:' + trimmed.slice(0, 40) };
  }
  const published = new Date(ts);
  if (published.getTime() > now.getTime()) {
    return { ok: false, reason: 'freshness-future-date' };
  }
  const ageDays = Math.floor((now.getTime() - published.getTime()) / 86400000);
  const band: FreshnessBand = ageDays <= 30 ? 'fresh' : ageDays <= 365 ? 'current' : 'stale';
  return { ok: true, band, ageDays };
}
