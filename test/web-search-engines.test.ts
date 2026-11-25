import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { rankResults, tokenize, type RankableResult } from '../src/modules/web-search/engine/source-ranking.ts';
import { extractPage } from '../src/modules/web-search/engine/page-extraction.ts';
import { normalizeClaim, parseSourceUrl, validateCitation } from '../src/modules/web-search/engine/citation.ts';
import { freshnessBand } from '../src/modules/web-search/engine/freshness.ts';
import { domainMatches, evaluateDomain, findOverlap, isValidDomainPattern, normalizeHost, validateRuleList, type DomainRules } from '../src/modules/web-search/engine/domain-policy.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = new Date(1_800_000_000_000);
const nowMs = NOW.getTime();

describe('source-ranking engine (FORGE AI-057)', () => {
  it('ranks pinned vectors with exact scores and reasons', () => {
    assert.deepEqual(tokenize('Forge-3.0 RELEASE!! notes'), ['forge', 'release', 'notes']);
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize('a b'), []);
    assert.deepEqual(
      rankResults(
        'forge release notes',
        [
          {
            url: 'https://forge.dev/notes',
            title: 'Forge 3.0 release notes',
            snippet: 'Forge release notes for version three',
            authorityScore: 80,
            publishedAt: '2027-01-10T00:00:00.000Z',
          },
        ],
        NOW,
      ),
      {
        ok: true,
        ranked: [
          {
            url: 'https://forge.dev/notes',
            title: 'Forge 3.0 release notes',
            score: 94,
            relevance: 100,
            authority: 80,
            freshness: 100,
            reasons: ['relevance:3/3 terms matched', 'authority:80', 'freshness:fresh'],
          },
        ],
        skipped: [],
      },
    );
    assert.deepEqual(
      rankResults(
        'forge release notes',
        [
          {
            url: 'https://blog.example/wander',
            title: 'A wandering blog',
            snippet: 'unrelated thoughts about hiking trails',
            authorityScore: 50,
            publishedAt: null,
          },
        ],
        NOW,
      ),
      {
        ok: true,
        ranked: [
          {
            url: 'https://blog.example/wander',
            title: 'A wandering blog',
            score: 18,
            relevance: 0,
            authority: 50,
            freshness: 25,
            reasons: ['relevance:0/3 terms matched', 'authority:50', 'freshness:unknown'],
          },
        ],
        skipped: [],
      },
    );
  });

  it('breaks ties by url, keeps null titles, skips duplicates and missing urls', () => {
    assert.deepEqual(
      rankResults(
        'forge',
        [
          { url: 'https://b.example/two', title: 'forge docs', publishedAt: null },
          { url: 'https://a.example/one', title: 'forge docs', publishedAt: null },
        ],
        NOW,
      ),
      {
        ok: true,
        ranked: [
          { url: 'https://a.example/one', title: 'forge docs', score: 78, relevance: 100, authority: 50, freshness: 25, reasons: ['relevance:1/1 terms matched', 'authority:50', 'freshness:unknown'] },
          { url: 'https://b.example/two', title: 'forge docs', score: 78, relevance: 100, authority: 50, freshness: 25, reasons: ['relevance:1/1 terms matched', 'authority:50', 'freshness:unknown'] },
        ],
        skipped: [],
      },
    );
    assert.deepEqual(
      rankResults('forge', [{ url: 'https://x.example/untitled', snippet: 'totally unrelated words', publishedAt: null }], NOW),
      {
        ok: true,
        ranked: [
          { url: 'https://x.example/untitled', title: null, score: 18, relevance: 0, authority: 50, freshness: 25, reasons: ['relevance:0/1 terms matched', 'authority:50', 'freshness:unknown'] },
        ],
        skipped: [],
      },
    );
    assert.deepEqual(
      rankResults(
        'forge',
        [
          { title: 'no url here', snippet: 'forge content', publishedAt: null } as unknown as RankableResult,
          { url: 'https://a.example/ok', title: 'forge ok', publishedAt: null },
        ],
        NOW,
      ),
      {
        ok: true,
        ranked: [
          { url: 'https://a.example/ok', title: 'forge ok', score: 78, relevance: 100, authority: 50, freshness: 25, reasons: ['relevance:1/1 terms matched', 'authority:50', 'freshness:unknown'] },
        ],
        skipped: [{ url: '', reason: 'rank-result-missing-url' }],
      },
    );
    assert.deepEqual(
      rankResults(
        'forge',
        [{ url: 'https://a.example/dup', title: 'forge first', publishedAt: null }, { url: 'https://a.example/dup', title: 'forge second', publishedAt: null }],
        NOW,
      ),
      {
        ok: true,
        ranked: [
          { url: 'https://a.example/dup', title: 'forge first', score: 78, relevance: 100, authority: 50, freshness: 25, reasons: ['relevance:1/1 terms matched', 'authority:50', 'freshness:unknown'] },
        ],
        skipped: [{ url: 'https://a.example/dup', reason: 'rank-duplicate-url' }],
      },
    );
    assert.deepEqual(
      rankResults('forge', [{ title: 'no url', snippet: 'forge' } as unknown as RankableResult], NOW),
      { ok: false, reason: 'rank-no-usable-results' },
    );
  });

  it('refuses empty and unusable inputs with named reasons', () => {
    assert.deepEqual(rankResults('', [{ url: 'https://a.example/x', title: 'forge' }], NOW), { ok: false, reason: 'rank-empty-query' });
    assert.deepEqual(rankResults('!!!', [{ url: 'https://a.example/x', title: 'forge' }], NOW), { ok: false, reason: 'rank-empty-query' });
    assert.deepEqual(rankResults('forge', [], NOW), { ok: false, reason: 'rank-empty-results' });
    assert.deepEqual(rankResults('forge', undefined as unknown as RankableResult[], NOW), { ok: false, reason: 'rank-empty-results' });
  });

  it('matches an independent scoring oracle on 500 mulberry32(42) cases', () => {
    const rand = mulberry32(42);
    const words = ['forge', 'alpha', 'beta', 'gamma', 'docs', 'notes', 'release', 'search', 'rank', 'tool', 'web', 'page', 'fresh', 'domain', 'claim'];
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
    const randWord = (): string => {
      const n = 1 + Math.floor(rand() * 3);
      let s = pick(words);
      for (let i = 1; i < n; i++) s += ' ' + pick(words);
      return s;
    };
    const randDate = (): string | null => {
      const kind = rand();
      if (kind < 0.1) return null;
      if (kind < 0.15) return '';
      if (kind < 0.2) return 'not-a-date';
      const days = Math.floor(rand() * 800);
      return new Date(nowMs - days * 86400000).toISOString();
    };
    const oTokens = (text: string): string[] =>
      Array.from(new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2)));
    const oBand = (pub: string | null): 'fresh' | 'current' | 'stale' | 'unknown' => {
      if (pub === null || pub === '' || typeof pub !== 'string') return 'unknown';
      const trimmed = pub.trim();
      if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return 'unknown';
      const ts = Date.parse(trimmed);
      if (!Number.isFinite(ts)) return 'unknown';
      if (ts > nowMs) return 'unknown';
      const ageDays = Math.floor((nowMs - ts) / 86400000);
      return ageDays <= 30 ? 'fresh' : ageDays <= 365 ? 'current' : 'stale';
    };
    interface ORow {
      title?: string;
      url: string;
      snippet?: string;
      authorityScore?: number;
      publishedAt?: string | null;
    }
    interface ORanked {
      url: string;
      title: string | null;
      score: number;
      relevance: number;
      authority: number;
      freshness: number;
      reasons: string[];
    }
    const oracleRank = (query: string, rows: readonly ORow[]): object => {
      const toks = oTokens(query);
      if (toks.length === 0) return { ok: false, reason: 'rank-empty-query' };
      if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: 'rank-empty-results' };
      const ranked: ORanked[] = [];
      const skipped: Array<{ url: string; reason: string }> = [];
      const seen = new Set<string>();
      for (const r of rows) {
        const url = typeof r?.url === 'string' ? r.url : '';
        if (!url) {
          skipped.push({ url: '', reason: 'rank-result-missing-url' });
          continue;
        }
        const norm = url.trim().toLowerCase();
        if (seen.has(norm)) {
          skipped.push({ url, reason: 'rank-duplicate-url' });
          continue;
        }
        seen.add(norm);
        const hay = oTokens((r.title ?? '') + ' ' + (r.snippet ?? ''));
        const matched = toks.filter((t) => hay.includes(t));
        const relevance = Math.round((100 * matched.length) / toks.length);
        const authority = Math.min(
          100,
          Math.max(0, Math.round(typeof r.authorityScore === 'number' && Number.isFinite(r.authorityScore) ? r.authorityScore : 50)),
        );
        const band = oBand(r.publishedAt ?? null);
        const freshness = band === 'fresh' ? 100 : band === 'current' ? 50 : band === 'unknown' ? 25 : 0;
        const score = Math.round(0.6 * relevance + 0.3 * authority + 0.1 * freshness);
        ranked.push({
          url: r.url,
          title: typeof r.title === 'string' ? r.title : null,
          score,
          relevance,
          authority,
          freshness,
          reasons: ['relevance:' + matched.length + '/' + toks.length + ' terms matched', 'authority:' + authority, 'freshness:' + band],
        });
      }
      ranked.sort((a, b) => (b.score - a.score) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
      if (ranked.length === 0) return { ok: false, reason: 'rank-no-usable-results' };
      return { ok: true, ranked, skipped };
    };
    for (let c = 0; c < 500; c++) {
      const query = rand() < 0.05 ? '' : randWord();
      const nRows = Math.floor(rand() * 9);
      const rows: RankableResult[] = [];
      for (let j = 0; j < nRows; j++) {
        const urlKind = rand();
        const row: RankableResult = {
          url: urlKind < 0.1 ? '' : urlKind < 0.2 ? 'https://a.example/dup' : 'https://' + pick(words) + '.example/' + j,
        };
        if (rand() < 0.9) row.title = randWord();
        if (rand() < 0.8) row.snippet = randWord();
        if (rand() < 0.8) row.authorityScore = Math.floor(rand() * 150);
        row.publishedAt = randDate();
        rows.push(row);
      }
      assert.deepEqual(rankResults(query, rows, NOW), oracleRank(query, rows));
    }
  });
});

describe('page-extraction engine (FORGE AI-058)', () => {
  it('extracts the pinned page with title, words and publish date', () => {
    const pageHtml = [
      '<html><head><title>Forge Docs</title>',
      '<script>var hidden = "script words here";</script>',
      '<style>body { color: red; }</style>',
      '</head><body>',
      '<!-- a comment with words too -->',
      '<nav><a href="/x">nav link text</a></nav>',
      '<time datetime="2027-01-05T00:00:00Z"></time>',
      '<p>recent alpha beta gamma delta epsilon zeta eta theta iota kappa</p>',
      '</body></html>',
    ].join('');
    assert.deepEqual(extractPage(pageHtml), {
      ok: true,
      page: {
        title: 'Forge Docs',
        text: 'recent alpha beta gamma delta epsilon zeta eta theta iota kappa',
        wordCount: 11,
        publishedAt: '2027-01-05T00:00:00.000Z',
      },
    });
    assert.deepEqual(
      extractPage(
        '<html><head><title>Meta Page</title><meta property="article:published_time" content="2026-12-01T00:00:00Z"></head><body><p>alpha beta gamma delta epsilon zeta eta theta iota kappa</p></body></html>',
      ),
      {
        ok: true,
        page: { title: 'Meta Page', text: 'alpha beta gamma delta epsilon zeta eta theta iota kappa', wordCount: 10, publishedAt: '2026-12-01T00:00:00.000Z' },
      },
    );
    assert.deepEqual(
      extractPage('<p>alpha &amp; beta &lt;gamma&gt; &quot;delta&quot; &#39;epsilon&#39; zeta eta theta iota kappa</p>'),
      {
        ok: true,
        page: { title: null, text: 'alpha & beta <gamma> "delta" \'epsilon\' zeta eta theta iota kappa', wordCount: 11, publishedAt: null },
      },
    );
  });

  it('refuses empty and unreadable html with named reasons', () => {
    assert.deepEqual(extractPage(''), { ok: false, reason: 'extract-empty-html' });
    assert.deepEqual(extractPage('   '), { ok: false, reason: 'extract-empty-html' });
    assert.deepEqual(extractPage('<p>too short</p>'), { ok: false, reason: 'extract-no-readable-text' });
    assert.deepEqual(extractPage(42 as unknown as string), { ok: false, reason: 'extract-empty-html' });
  });

  it('matches an independent construction oracle on 500 mulberry32(42) cases', () => {
    const rand = mulberry32(42);
    const words = ['forge', 'alpha', 'beta', 'gamma', 'docs', 'notes', 'release', 'search', 'rank', 'tool', 'web', 'page', 'fresh', 'domain', 'claim'];
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
    for (let c = 0; c < 500; c++) {
      const nWords = rand() < 0.1 ? 3 : 10 + Math.floor(rand() * 30);
      const bodyWords: string[] = [];
      for (let j = 0; j < nWords; j++) bodyWords.push(pick(words));
      const titleTxt = rand() < 0.5 ? null : pick(words) + ' ' + pick(words);
      const dateStr = rand() < 0.5 ? new Date(nowMs - Math.floor(rand() * 800) * 86400000).toISOString() : null;
      const parts: string[] = ['<html><head>'];
      if (rand() < 0.5) parts.push('<!-- hidden comment words here -->');
      if (rand() < 0.5) parts.push('<script>var x = "script words";</script>');
      if (rand() < 0.5) parts.push('<style>.c { color: blue; }</style>');
      if (titleTxt !== null) parts.push('<title>' + titleTxt + '</title>');
      if (dateStr !== null) parts.push('<time datetime="' + dateStr + '"></time>');
      parts.push('</head><body>');
      if (rand() < 0.5) parts.push('<nav><a href="/x">nav boilerplate words</a></nav>');
      parts.push('<p>' + bodyWords.join(' ') + '</p>');
      parts.push('</body></html>');
      const expected: object =
        nWords < 10
          ? { ok: false, reason: 'extract-no-readable-text' }
          : { ok: true, page: { title: titleTxt, text: bodyWords.join(' '), wordCount: nWords, publishedAt: dateStr } };
      assert.deepEqual(extractPage(parts.join('')), expected);
    }
  });
});

describe('citation engine (FORGE AI-059)', () => {
  it('normalizes claims and parses https sources', () => {
    assert.equal(normalizeClaim('  forge   claims\nthis  '), 'forge claims this');
    assert.equal(normalizeClaim(42 as unknown as string), '');
    assert.deepEqual(parseSourceUrl('https://Docs.Example.com/Path'), { ok: true, source: { url: 'https://Docs.Example.com/Path', host: 'docs.example.com' } });
    assert.deepEqual(parseSourceUrl('https://user@proxy.example/x'), { ok: true, source: { url: 'https://user@proxy.example/x', host: 'proxy.example' } });
    assert.deepEqual(parseSourceUrl('https://proxy.example:8443/x'), { ok: true, source: { url: 'https://proxy.example:8443/x', host: 'proxy.example' } });
    assert.deepEqual(validateCitation('forge   is  real', 'https://example.com/a'), {
      ok: true,
      claim: 'forge is real',
      source: { url: 'https://example.com/a', host: 'example.com' },
    });
  });

  it('refuses insecure and malformed inputs with named reasons', () => {
    assert.deepEqual(parseSourceUrl('http://example.com'), { ok: false, reason: 'citation-insecure-scheme:http' });
    assert.deepEqual(parseSourceUrl('ftp://files.example.com'), { ok: false, reason: 'citation-insecure-scheme:ftp' });
    assert.deepEqual(parseSourceUrl('example.com/page'), { ok: false, reason: 'citation-missing-scheme' });
    assert.deepEqual(parseSourceUrl('https://'), { ok: false, reason: 'citation-missing-host' });
    assert.deepEqual(parseSourceUrl(''), { ok: false, reason: 'citation-missing-source' });
    assert.deepEqual(validateCitation('ab', 'https://example.com'), { ok: false, reason: 'citation-too-short' });
    assert.deepEqual(validateCitation('   ', 'https://example.com'), { ok: false, reason: 'citation-empty-claim' });
    assert.deepEqual(validateCitation('forge is real', 'http://example.com'), { ok: false, reason: 'citation-insecure-scheme:http' });
    assert.deepEqual(validateCitation('forge is real', 'example.com'), { ok: false, reason: 'citation-missing-scheme' });
    assert.deepEqual(validateCitation(42 as unknown as string, 'https://example.com'), { ok: false, reason: 'citation-empty-claim' });
    assert.deepEqual(validateCitation('forge is real', 42 as unknown as string), { ok: false, reason: 'citation-missing-source' });
  });

  it('matches an independent url oracle on 500 mulberry32(42) cases', () => {
    const rand = mulberry32(42);
    const words = ['forge', 'alpha', 'beta', 'gamma', 'docs', 'notes', 'release', 'search', 'rank', 'tool', 'web', 'page', 'fresh', 'domain', 'claim'];
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
    const randWord = (): string => {
      const n = 1 + Math.floor(rand() * 3);
      let s = pick(words);
      for (let i = 1; i < n; i++) s += ' ' + pick(words);
      return s;
    };
    const oracle = (claim: string, url: string): object => {
      const norm = claim.replace(/\s+/g, ' ').trim();
      if (norm.length === 0) return { ok: false, reason: 'citation-empty-claim' };
      if (norm.length < 3) return { ok: false, reason: 'citation-too-short' };
      if (url.trim().length === 0) return { ok: false, reason: 'citation-missing-source' };
      const m = url.trim().match(/^([a-z][a-z0-9+.-]*):\/\//i);
      if (!m) return { ok: false, reason: 'citation-missing-scheme' };
      const scheme = m[1]!.toLowerCase();
      if (scheme !== 'https') return { ok: false, reason: 'citation-insecure-scheme:' + scheme };
      const after = url.trim().slice(m[0].length);
      const host = after.split('/')[0]!.split('@').pop()!.split(':')[0]!.toLowerCase();
      if (!host) return { ok: false, reason: 'citation-missing-host' };
      return { ok: true, claim: norm, source: { url: url.trim(), host } };
    };
    for (let c = 0; c < 500; c++) {
      let claim: string;
      const claimKind = rand();
      if (claimKind < 0.1) claim = pick(['ab', 'x', 'xy', 'a b c']);
      else if (claimKind < 0.15) claim = '';
      else claim = randWord();
      const urlKind = Math.floor(rand() * 6);
      let url: string;
      if (urlKind === 0) url = 'https://' + pick(words) + '.' + pick(words) + '.example/' + c;
      else if (urlKind === 1) url = 'HTTP://' + pick(words) + '.example/' + c;
      else if (urlKind === 2) url = pick(words) + '.example/' + c;
      else if (urlKind === 3) url = 'https://' + pick(words) + '@' + pick(words) + '.example:8443/x';
      else if (urlKind === 4) url = '';
      else url = 'https://' + pick(words) + '.example/' + c;
      assert.deepEqual(validateCitation(claim, url), oracle(claim, url));
    }
  });
});

describe('freshness engine (FORGE AI-060)', () => {
  it('bands pinned dates with exact ages', () => {
    assert.deepEqual(freshnessBand('2027-01-10T00:00:00.000Z', NOW), { ok: true, band: 'fresh', ageDays: 5 });
    assert.deepEqual(freshnessBand(null, NOW), { ok: true, band: 'unknown', ageDays: null });
    assert.deepEqual(freshnessBand(undefined, NOW), { ok: true, band: 'unknown', ageDays: null });
    assert.deepEqual(freshnessBand('', NOW), { ok: true, band: 'unknown', ageDays: null });
    const daysAgo = (d: number): string => new Date(nowMs - d * 86400000).toISOString();
    assert.deepEqual(freshnessBand(daysAgo(0), NOW), { ok: true, band: 'fresh', ageDays: 0 });
    assert.deepEqual(freshnessBand(daysAgo(30), NOW), { ok: true, band: 'fresh', ageDays: 30 });
    assert.deepEqual(freshnessBand(daysAgo(31), NOW), { ok: true, band: 'current', ageDays: 31 });
    assert.deepEqual(freshnessBand(daysAgo(365), NOW), { ok: true, band: 'current', ageDays: 365 });
    assert.deepEqual(freshnessBand(daysAgo(366), NOW), { ok: true, band: 'stale', ageDays: 366 });
  });

  it('refuses future and invalid dates with named reasons', () => {
    assert.deepEqual(freshnessBand('2027-01-16', NOW), { ok: false, reason: 'freshness-future-date' });
    assert.deepEqual(freshnessBand(42 as unknown as string, NOW), { ok: false, reason: 'freshness-invalid-date' });
    assert.deepEqual(freshnessBand('not-a-date', NOW), { ok: false, reason: 'freshness-invalid-date:not-a-date' });
    assert.deepEqual(freshnessBand('2027-13-40', NOW), { ok: false, reason: 'freshness-invalid-date:2027-13-40' });
  });

  it('matches an independent age oracle on 500 mulberry32(42) cases', () => {
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const kind = rand();
      let input: string | null | undefined;
      if (kind < 0.05) input = null;
      else if (kind < 0.1) input = '';
      else if (kind < 0.15) input = 'garbage-' + c;
      else if (kind < 0.2) input = new Date(nowMs + (1 + Math.floor(rand() * 100)) * 86400000).toISOString();
      else input = new Date(nowMs - Math.floor(rand() * 900) * 86400000).toISOString();
      let expected: object;
      if (input === null || input === undefined || input === '') {
        expected = { ok: true, band: 'unknown', ageDays: null };
      } else if (!/^\d{4}-\d{2}-\d{2}/.test(input.trim())) {
        expected = { ok: false, reason: 'freshness-invalid-date:' + input.trim().slice(0, 40) };
      } else {
        const ts = Date.parse(input.trim());
        if (!Number.isFinite(ts)) expected = { ok: false, reason: 'freshness-invalid-date:' + input.trim().slice(0, 40) };
        else if (ts > nowMs) expected = { ok: false, reason: 'freshness-future-date' };
        else {
          const ageDays = Math.floor((nowMs - ts) / 86400000);
          expected = { ok: true, band: ageDays <= 30 ? 'fresh' : ageDays <= 365 ? 'current' : 'stale', ageDays };
        }
      }
      assert.deepEqual(freshnessBand(input, NOW), expected);
    }
  });
});

describe('domain-policy engine (FORGE AI-061)', () => {
  it('normalizes hosts and validates patterns', () => {
    assert.equal(normalizeHost('HTTPS://WWW.Example.com:443/path'), 'www.example.com');
    assert.equal(normalizeHost('user@evil.example/x'), 'evil.example');
    assert.equal(normalizeHost('a.com.'), 'a.com');
    assert.equal(normalizeHost(''), '');
    assert.equal(normalizeHost(42 as unknown as string), '');
    assert.equal(isValidDomainPattern('example.com'), true);
    assert.equal(isValidDomainPattern('*.example.com'), true);
    assert.equal(isValidDomainPattern('example'), false);
    assert.equal(isValidDomainPattern('example..com'), false);
    assert.equal(isValidDomainPattern('*.com'), false);
    assert.equal(isValidDomainPattern('-bad.com'), false);
  });

  it('matches hosts against bare and wildcard patterns', () => {
    assert.equal(domainMatches('docs.example.com', 'example.com'), true);
    assert.equal(domainMatches('example.com', 'example.com'), true);
    assert.equal(domainMatches('notexample.com', 'example.com'), false);
    assert.equal(domainMatches('docs.example.com', '*.example.com'), true);
    assert.equal(domainMatches('example.com', '*.example.com'), false);
    assert.equal(domainMatches('a.b.example.com', '*.example.com'), true);
  });

  it('evaluates and validates rules with named refusals', () => {
    assert.deepEqual(evaluateDomain('example.com', { allow: [], deny: [] }), { ok: true });
    assert.deepEqual(evaluateDomain('example.com', undefined as unknown as DomainRules), { ok: true });
    assert.deepEqual(evaluateDomain('evil.com', { allow: [], deny: ['evil.com'] }), { ok: false, reason: 'domain-denied:evil.com' });
    assert.deepEqual(evaluateDomain('neutral.com', { allow: ['good.com'], deny: [] }), { ok: false, reason: 'domain-not-allowlisted:neutral.com' });
    assert.deepEqual(evaluateDomain('sub.good.com', { allow: ['good.com'], deny: [] }), { ok: true });
    assert.deepEqual(evaluateDomain('both.com', { allow: ['both.com'], deny: ['both.com'] }), { ok: false, reason: 'domain-denied:both.com' });
    assert.deepEqual(evaluateDomain('', { allow: [], deny: [] }), { ok: false, reason: 'domain-empty-host' });
    assert.deepEqual(evaluateDomain('not_a_host', { allow: [], deny: [] }), { ok: false, reason: 'domain-invalid-host:not_a_host' });
    assert.equal(validateRuleList(['example.com']), null);
    assert.equal(validateRuleList(['*.example.com', 'other.org']), null);
    assert.equal(validateRuleList(42 as unknown as string[]), 'rules-not-a-list');
    assert.equal(validateRuleList([42]), 'rules-not-a-string:42');
    assert.equal(validateRuleList(['']), 'rules-empty-domain');
    assert.equal(validateRuleList(['not a domain']), 'rules-invalid-domain:not a domain');
    assert.equal(validateRuleList(['a.com', 'A.com']), 'rules-duplicate-domain:a.com');
    assert.equal(validateRuleList(['-bad.com']), 'rules-invalid-domain:-bad.com');
    assert.equal(findOverlap(['example.com'], ['example.com']), 'example.com');
    assert.equal(findOverlap(['a.com'], ['b.com']), null);
    assert.equal(findOverlap(['sub.example.com'], ['*.example.com']), null);
    assert.equal(findOverlap(['*.example.com'], ['*.example.com']), '*.example.com');
  });

  it('matches independent label and policy oracles on 500 mulberry32(42) cases', () => {
    const rand = mulberry32(42);
    const words = ['forge', 'alpha', 'beta', 'gamma', 'docs', 'notes', 'release', 'search', 'rank', 'tool', 'web', 'page', 'fresh', 'domain', 'claim'];
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
    const oracleValidHost = (h: string): boolean => {
      if (typeof h !== 'string' || h.length === 0) return false;
      const labels = h.split('.');
      if (labels.length < 2) return false;
      return labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l));
    };
    const oracleNormalize = (input: string): string => {
      if (typeof input !== 'string') return '';
      let h = input.trim().toLowerCase();
      const scheme = h.match(/^([a-z][a-z0-9+.-]*):\/\//);
      if (scheme) h = h.slice(scheme[0].length);
      const slash = h.indexOf('/');
      if (slash >= 0) h = h.slice(0, slash);
      const at = h.indexOf('@');
      if (at >= 0) h = h.slice(at + 1);
      const colon = h.indexOf(':');
      if (colon >= 0) h = h.slice(0, colon);
      while (h.endsWith('.')) h = h.slice(0, -1);
      return h;
    };
    const oracleMatches = (host: string, pattern: string): boolean => {
      const h = oracleNormalize(host);
      const p = oracleNormalize(pattern);
      if (!h || !p) return false;
      if (p.startsWith('*.')) {
        const base = p.slice(2);
        return h.endsWith('.' + base) && h !== base;
      }
      return h === p || h.endsWith('.' + p);
    };
    const oracleEvaluate = (host: string, rules: { allow: string[]; deny: string[] }): object => {
      const h = oracleNormalize(host);
      if (!h) return { ok: false, reason: 'domain-empty-host' };
      if (!oracleValidHost(h)) return { ok: false, reason: 'domain-invalid-host:' + h };
      for (const pattern of rules.deny) {
        if (oracleMatches(h, pattern)) return { ok: false, reason: 'domain-denied:' + h };
      }
      if (rules.allow.length > 0 && !rules.allow.some((pattern) => oracleMatches(h, pattern))) {
        return { ok: false, reason: 'domain-not-allowlisted:' + h };
      }
      return { ok: true };
    };
    const oracleList = (patterns: readonly string[]): string | null => {
      const seen = new Set<string>();
      for (const raw of patterns) {
        const p = oracleNormalize(raw);
        if (!p) return 'rules-empty-domain';
        const bare = p.startsWith('*.') ? p.slice(2) : p;
        if (!oracleValidHost(bare) || bare.split('.').length < 2) return 'rules-invalid-domain:' + p;
        if (seen.has(p)) return 'rules-duplicate-domain:' + p;
        seen.add(p);
      }
      return null;
    };
    const randHost = (): string => {
      const kind = rand();
      if (kind < 0.08) return '';
      if (kind < 0.16) return 'https://' + pick(words) + '.example.com:8443/x';
      if (kind < 0.24) return 'user@' + pick(words) + '.example.com';
      if (kind < 0.32) return pick(words) + '.example.com.';
      if (kind < 0.4) return 'bad_' + pick(words) + '.com';
      if (kind < 0.48) return '-bad.' + pick(words) + '.com';
      const n = 1 + Math.floor(rand() * 3);
      let h = pick(words);
      for (let k = 1; k < n; k++) h += '.' + pick(words);
      return h + '.example';
    };
    const patternPool = ['example.com', '*.example.com', 'good.com', 'evil.com', 'sub.good.com', '-bad.com', 'bad_.com', 'example..com', '*.com', 'com', 'example'];
    const randRules = (): { allow: string[]; deny: string[] } => {
      const rules = { allow: [] as string[], deny: [] as string[] };
      const nAllow = Math.floor(rand() * 3);
      const nDeny = Math.floor(rand() * 3);
      for (let i = 0; i < nAllow; i++) rules.allow.push(pick(patternPool));
      for (let i = 0; i < nDeny; i++) rules.deny.push(pick(patternPool));
      return rules;
    };
    for (let c = 0; c < 500; c++) {
      const host = randHost();
      const rules = randRules();
      assert.deepEqual(evaluateDomain(host, rules), oracleEvaluate(host, rules));
      const normalized = oracleNormalize(host);
      const bare = normalized.startsWith('*.') ? normalized.slice(2) : normalized;
      assert.equal(isValidDomainPattern(host), oracleValidHost(bare) && bare.split('.').length >= 2);
      const p1 = pick(patternPool);
      const p2 = pick(patternPool);
      assert.equal(domainMatches(host, p1), oracleMatches(host, p1));
      assert.equal(validateRuleList([p1, p2]), oracleList([p1, p2]));
    }
  });
});
