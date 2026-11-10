// Pure source ranking engine for the web search tool (FORGE AI-057).
// Relevance is 60 percent: unique query terms found in the title and snippet.
// Authority is 30 percent: an explicit 0..100 score, default 50. Freshness is
// 10 percent: fresh 100, current 50, unknown 25, stale 0; invalid dates rank
// as unknown, never faked. Ties break by url so the order is deterministic.
// Duplicate urls and url-less rows are skipped with named reasons.

import { freshnessBand } from './freshness.ts';

export interface RankableResult {
  title?: string;
  url: string;
  snippet?: string;
  authorityScore?: number;
  publishedAt?: string | null;
}

export interface RankedResult {
  url: string;
  title: string | null;
  score: number;
  relevance: number;
  authority: number;
  freshness: number;
  reasons: string[];
}

export interface SkippedResult {
  url: string;
  reason: string;
}

export type RankVerdict =
  | { ok: true; ranked: RankedResult[]; skipped: SkippedResult[] }
  | { ok: false; reason: string };

export function tokenize(text: string): string[] {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function freshnessComponent(band: 'fresh' | 'current' | 'stale' | 'unknown'): number {
  if (band === 'fresh') return 100;
  if (band === 'current') return 50;
  if (band === 'unknown') return 25;
  return 0;
}

export function rankResults(
  query: string,
  results: RankableResult[],
  now: Date,
): RankVerdict {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0) return { ok: false, reason: 'rank-empty-query' };
  if (!Array.isArray(results) || results.length === 0) {
    return { ok: false, reason: 'rank-empty-results' };
  }

  const ranked: RankedResult[] = [];
  const skipped: SkippedResult[] = [];
  const seenUrls = new Set<string>();

  for (const r of results) {
    const url = typeof r?.url === 'string' ? r.url : '';
    if (!url) {
      skipped.push({ url: '', reason: 'rank-result-missing-url' });
      continue;
    }
    const normalizedUrl = url.trim().toLowerCase();
    if (seenUrls.has(normalizedUrl)) {
      skipped.push({ url, reason: 'rank-duplicate-url' });
      continue;
    }
    seenUrls.add(normalizedUrl);

    const haystack = Array.from(
      new Set(tokenize((r.title ?? '') + ' ' + (r.snippet ?? ''))),
    );
    const matched = queryTokens.filter((t) => haystack.includes(t));
    const relevance = Math.round((100 * matched.length) / queryTokens.length);

    const rawAuthority =
      typeof r.authorityScore === 'number' && Number.isFinite(r.authorityScore)
        ? r.authorityScore
        : 50;
    const authority = Math.min(100, Math.max(0, Math.round(rawAuthority)));

    const f = freshnessBand(r.publishedAt ?? null, now);
    const band: 'fresh' | 'current' | 'stale' | 'unknown' = f.ok ? f.band! : 'unknown';
    const freshness = freshnessComponent(band);

    const score = Math.round(0.6 * relevance + 0.3 * authority + 0.1 * freshness);

    const reasons: string[] = [];
    reasons.push('relevance:' + matched.length + '/' + queryTokens.length + ' terms matched');
    reasons.push('authority:' + authority);
    reasons.push('freshness:' + band);

    ranked.push({
      url: r.url,
      title: typeof r.title === 'string' ? r.title : null,
      score,
      relevance,
      authority,
      freshness,
      reasons,
    });
  }

  ranked.sort((a, b) => (b.score - a.score) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  if (ranked.length === 0) return { ok: false, reason: 'rank-no-usable-results' };
  return { ok: true, ranked, skipped };
}
