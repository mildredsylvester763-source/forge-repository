import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

async function signedInUser(h: Harness, email: string): Promise<string> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'WS Tester' });
  assert.equal(register.status, 201);
  const signIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signIn.status, 200);
  return sessionCookie(signIn);
}

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

describe('web search routes (FORGE AI-057..061)', () => {
  it('refuses every route without a session', async () => {
    const h = await startHarness();
    try {
      const search = await h.post('/v1/web-search/search', { query: 'forge', results: [] });
      assert.equal(search.status, 401);
      assert.equal(await errorCode(search), 'unauthenticated');
      const queries = await h.get('/v1/web-search/queries');
      assert.equal(queries.status, 401);
      const queriesList = await h.post('/v1/web-search/queries/list', { limit: 5 });
      assert.equal(queriesList.status, 401);
      const pages = await h.get('/v1/web-search/pages');
      assert.equal(pages.status, 401);
      const page = await h.post('/v1/web-search/pages', { url: 'https://a.example/x', html: '<p>alpha beta gamma delta epsilon zeta eta theta iota kappa</p>' });
      assert.equal(page.status, 401);
      const pagesList = await h.post('/v1/web-search/pages/list', { limit: 5 });
      assert.equal(pagesList.status, 401);
      const citations = await h.get('/v1/web-search/citations');
      assert.equal(citations.status, 401);
      const citation = await h.post('/v1/web-search/citations', { claim: 'forge is real', sourceUrl: 'https://a.example/x' });
      assert.equal(citation.status, 401);
      const citationsList = await h.post('/v1/web-search/citations/list', { limit: 5 });
      assert.equal(citationsList.status, 401);
      const rulesGet = await h.get('/v1/web-search/domain-rules');
      assert.equal(rulesGet.status, 401);
      const rulesSet = await h.post('/v1/web-search/domain-rules', { allow: [], deny: [] });
      assert.equal(rulesSet.status, 401);
      const rulesFor = await h.post('/v1/web-search/domain-rules/get', { workspace: 'research' });
      assert.equal(rulesFor.status, 401);
    } finally {
      await h.close();
    }
  });

  it('ranks a search end to end and records the query', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'ws-rank@forge.test');
      const searchRes = await h.post(
        '/v1/web-search/search',
        {
          query: 'forge release notes',
          results: [
            {
              url: 'https://forge.dev/notes',
              title: 'Forge 3.0 release notes',
              snippet: 'Forge release notes for version three',
              authorityScore: 80,
              publishedAt: '2027-01-10T00:00:00.000Z',
            },
          ],
        },
        { cookie },
      );
      assert.equal(searchRes.status, 201);
      const search = (await searchRes.json()) as {
        id: string;
        query: string;
        workspace: string;
        ranked: Array<{ url: string; title: string | null; score: number; relevance: number; authority: number; freshness: number; reasons: string[] }>;
        skipped: Array<{ url: string; reason: string }>;
        refusedReason: string | null;
        createdAt: number;
      };
      assert.equal(search.query, 'forge release notes');
      assert.equal(search.workspace, 'default');
      assert.equal(search.refusedReason, null);
      assert.equal(search.createdAt, 1_800_000_000_000);
      assert.deepEqual(search.skipped, []);
      assert.deepEqual(search.ranked, [
        {
          url: 'https://forge.dev/notes',
          title: 'Forge 3.0 release notes',
          score: 94,
          relevance: 100,
          authority: 80,
          freshness: 100,
          reasons: ['relevance:3/3 terms matched', 'authority:80', 'freshness:fresh'],
        },
      ]);
      const queries = (await (await h.get('/v1/web-search/queries', { cookie })).json()) as {
        queries: Array<{ query: string; refusedReason: string | null; results: Array<{ url: string }>; skipped: Array<{ url: string; reason: string }> }>;
      };
      assert.equal(queries.queries.length, 1);
      assert.equal(queries.queries[0]?.query, 'forge release notes');
      assert.equal(queries.queries[0]?.refusedReason, null);
      assert.deepEqual(queries.queries[0]?.results, [
        {
          url: 'https://forge.dev/notes',
          title: 'Forge 3.0 release notes',
          score: 94,
          relevance: 100,
          authority: 80,
          freshness: 100,
          reasons: ['relevance:3/3 terms matched', 'authority:80', 'freshness:fresh'],
        },
      ]);
      assert.deepEqual(queries.queries[0]?.skipped, []);
      const listed = (await (await h.post('/v1/web-search/queries/list', { limit: '1' }, { cookie })).json()) as { queries: Array<{ query: string }> };
      assert.equal(listed.queries.length, 1);
      assert.equal(listed.queries[0]?.query, 'forge release notes');
    } finally {
      await h.close();
    }
  });

  it('refuses bad searches with named reasons', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'ws-refuse@forge.test');
      const missing = await h.post('/v1/web-search/search', { results: [{ url: 'https://a.example/x' }] }, { cookie });
      assert.equal(missing.status, 400);
      assert.equal(await errorCode(missing), 'search-missing-query');
      const tooLong = await h.post('/v1/web-search/search', { query: 'f'.repeat(501), results: [{ url: 'https://a.example/x' }] }, { cookie });
      assert.equal(await errorCode(tooLong), 'search-query-too-long');
      const none = await h.post('/v1/web-search/search', { query: 'forge', results: [] }, { cookie });
      assert.equal(await errorCode(none), 'search-no-results-supplied');
      const tooMany = await h.post(
        '/v1/web-search/search',
        { query: 'forge', results: Array.from({ length: 51 }, (_, i) => ({ url: 'https://a.example/' + i, title: 'forge' })) },
        { cookie },
      );
      assert.equal(await errorCode(tooMany), 'search-too-many-results');
      const punctuation = await h.post('/v1/web-search/search', { query: '!!!', results: [{ url: 'https://a.example/x', title: 'forge' }] }, { cookie });
      assert.equal(punctuation.status, 201);
      const refused = (await punctuation.json()) as { refusedReason: string | null; ranked: Array<{ url: string }>; skipped: Array<{ url: string; reason: string }> };
      assert.equal(refused.refusedReason, 'rank-no-usable-results');
      assert.equal(refused.ranked.length, 0);
      assert.deepEqual(refused.skipped, [{ url: 'https://a.example/x', reason: 'rank-empty-query' }]);
      const noUrl = await h.post('/v1/web-search/search', { query: 'forge', results: [{ title: 'nonsense words' }] }, { cookie });
      assert.equal(noUrl.status, 201);
      const noUrlBody = (await noUrl.json()) as { refusedReason: string | null; skipped: Array<{ url: string; reason: string }> };
      assert.equal(noUrlBody.refusedReason, 'search-no-allowed-results');
      assert.deepEqual(noUrlBody.skipped, [{ url: '', reason: 'rank-result-missing-url' }]);
      const insecure = await h.post('/v1/web-search/search', { query: 'forge', results: [{ url: 'http://plain.example/1', title: 'forge' }] }, { cookie });
      assert.equal(insecure.status, 201);
      const insecureBody = (await insecure.json()) as { refusedReason: string | null; skipped: Array<{ url: string; reason: string }> };
      assert.equal(insecureBody.refusedReason, 'search-no-allowed-results');
      assert.deepEqual(insecureBody.skipped, [{ url: 'http://plain.example/1', reason: 'citation-insecure-scheme:http' }]);
    } finally {
      await h.close();
    }
  });

  it('enforces allow and deny rules per workspace', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'ws-rules@forge.test');
      const research = await h.post('/v1/web-search/domain-rules', { workspace: 'research', allow: [], deny: ['evil.example'] }, { cookie });
      assert.equal(research.status, 200);
      const researchRules = (await research.json()) as { rules: { workspace: string; allow: string[]; deny: string[] } };
      assert.equal(researchRules.rules.workspace, 'research');
      assert.deepEqual(researchRules.rules.deny, ['evil.example']);
      const mixed = await h.post(
        '/v1/web-search/search',
        {
          workspace: 'research',
          query: 'forge',
          results: [
            { url: 'https://evil.example/a', title: 'forge', publishedAt: null },
            { url: 'https://good.example/b', title: 'forge', publishedAt: null },
          ],
        },
        { cookie },
      );
      assert.equal(mixed.status, 201);
      const mixedBody = (await mixed.json()) as { ranked: Array<{ url: string }>; skipped: Array<{ url: string; reason: string }>; refusedReason: string | null };
      assert.equal(mixedBody.refusedReason, null);
      assert.deepEqual(mixedBody.ranked.map((r) => r.url), ['https://good.example/b']);
      assert.deepEqual(mixedBody.skipped, [{ url: 'https://evil.example/a', reason: 'domain-denied:evil.example' }]);
      const locked = await h.post('/v1/web-search/domain-rules', { workspace: 'locked', allow: ['good.example'], deny: [] }, { cookie });
      assert.equal(locked.status, 200);
      const gatekept = await h.post(
        '/v1/web-search/search',
        {
          workspace: 'locked',
          query: 'forge',
          results: [
            { url: 'https://good.example/b', title: 'forge', publishedAt: null },
            { url: 'https://neutral.example/c', title: 'forge', publishedAt: null },
          ],
        },
        { cookie },
      );
      assert.equal(gatekept.status, 201);
      const gatekeptBody = (await gatekept.json()) as { ranked: Array<{ url: string }>; skipped: Array<{ url: string; reason: string }> };
      assert.deepEqual(gatekeptBody.ranked.map((r) => r.url), ['https://good.example/b']);
      assert.deepEqual(gatekeptBody.skipped, [{ url: 'https://neutral.example/c', reason: 'domain-not-allowlisted:neutral.example' }]);
      const fetched = await h.post('/v1/web-search/domain-rules/get', { workspace: '  research  ' }, { cookie });
      assert.equal(fetched.status, 200);
      const fetchedRules = (await fetched.json()) as { rules: { workspace: string; deny: string[] } };
      assert.equal(fetchedRules.rules.workspace, 'research');
      assert.deepEqual(fetchedRules.rules.deny, ['evil.example']);
      const defaultGet = await h.get('/v1/web-search/domain-rules', { cookie });
      assert.equal(defaultGet.status, 200);
      const defaultRules = (await defaultGet.json()) as { rules: { id: string; workspace: string; allow: string[]; deny: string[] } };
      assert.equal(defaultRules.rules.workspace, 'default');
      assert.deepEqual(defaultRules.rules.allow, []);
      assert.deepEqual(defaultRules.rules.deny, []);
      const defaultAgain = (await (await h.get('/v1/web-search/domain-rules', { cookie })).json()) as { rules: { id: string } };
      assert.equal(defaultAgain.rules.id, defaultRules.rules.id);
    } finally {
      await h.close();
    }
  });

  it('fetches, extracts and reuses pages with named refusals', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'ws-pages@forge.test');
      const html = [
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
      const fetched = await h.post('/v1/web-search/pages', { url: 'https://docs.example.com/guide', html }, { cookie });
      assert.equal(fetched.status, 201);
      const page = (await fetched.json()) as {
        id: string;
        url: string;
        domain: string;
        title: string | null;
        wordCount: number;
        content: string;
        publishedAt: string | null;
        freshnessBand: string;
        reused: boolean;
      };
      assert.equal(page.url, 'https://docs.example.com/guide');
      assert.equal(page.domain, 'docs.example.com');
      assert.equal(page.title, 'Forge Docs');
      assert.equal(page.wordCount, 11);
      assert.equal(page.content, 'recent alpha beta gamma delta epsilon zeta eta theta iota kappa');
      assert.equal(page.publishedAt, '2027-01-05T00:00:00.000Z');
      assert.equal(page.freshnessBand, 'fresh');
      assert.equal(page.reused, false);
      const again = await h.post(
        '/v1/web-search/pages',
        { url: 'https://docs.example.com/guide', html: '<p>different alpha beta gamma delta epsilon zeta eta theta iota kappa</p>' },
        { cookie },
      );
      assert.equal(again.status, 201);
      const reusedPage = (await again.json()) as { id: string; wordCount: number; reused: boolean };
      assert.equal(reusedPage.id, page.id);
      assert.equal(reusedPage.reused, true);
      assert.equal(reusedPage.wordCount, 11);
      const listed = (await (await h.post('/v1/web-search/pages/list', { limit: '1' }, { cookie })).json()) as { pages: Array<{ url: string }> };
      assert.equal(listed.pages.length, 1);
      assert.equal(listed.pages[0]?.url, 'https://docs.example.com/guide');
      const tooLong = await h.post('/v1/web-search/pages', { url: 'https://docs.example.com/big', html: 'x'.repeat(300001) }, { cookie });
      assert.equal(await errorCode(tooLong), 'fetch-page-html-too-long');
      const noScheme = await h.post('/v1/web-search/pages', { url: 'docs.example.com/guide', html }, { cookie });
      assert.equal(await errorCode(noScheme), 'citation-missing-scheme');
      await h.post('/v1/web-search/domain-rules', { workspace: 'research', deny: ['docs.example.com'] }, { cookie });
      const denied = await h.post('/v1/web-search/pages', { workspace: 'research', url: 'https://docs.example.com/guide', html }, { cookie });
      assert.equal(await errorCode(denied), 'domain-denied:docs.example.com');
      const empty = await h.post('/v1/web-search/pages', { url: 'https://docs.example.com/empty', html: '<p>too short</p>' }, { cookie });
      assert.equal(await errorCode(empty), 'extract-no-readable-text');
    } finally {
      await h.close();
    }
  });

  it('binds citations idempotently per user with named refusals', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'ws-cite@forge.test');
      const created = await h.post('/v1/web-search/citations', { claim: 'forge   is  real', sourceUrl: 'https://example.com/a' }, { cookie });
      assert.equal(created.status, 201);
      const citation = (await created.json()) as {
        id: string;
        claimText: string;
        sourceUrl: string;
        sourceTitle: string | null;
        quote: string | null;
        createdAt: number;
        reused: boolean;
      };
      assert.equal(citation.claimText, 'forge is real');
      assert.equal(citation.sourceUrl, 'https://example.com/a');
      assert.equal(citation.sourceTitle, null);
      assert.equal(citation.quote, null);
      assert.equal(citation.createdAt, 1_800_000_000_000);
      assert.equal(citation.reused, false);
      const again = await h.post('/v1/web-search/citations', { claim: 'forge is real', sourceUrl: 'https://example.com/a', quote: 'forge is real' }, { cookie });
      assert.equal(again.status, 201);
      const reused = (await again.json()) as { id: string; reused: boolean; quote: string | null };
      assert.equal(reused.id, citation.id);
      assert.equal(reused.reused, true);
      assert.equal(reused.quote, null);
      const other = await signedInUser(h, 'ws-cite-other@forge.test');
      const isolated = await h.get('/v1/web-search/citations', { cookie: other });
      const isolatedBody = (await isolated.json()) as { citations: Array<{ claimText: string }> };
      assert.equal(isolatedBody.citations.length, 0);
      const tooShort = await h.post('/v1/web-search/citations', { claim: 'ab', sourceUrl: 'https://example.com' }, { cookie });
      assert.equal(await errorCode(tooShort), 'citation-too-short');
      const emptyClaim = await h.post('/v1/web-search/citations', { claim: '', sourceUrl: 'https://example.com' }, { cookie });
      assert.equal(await errorCode(emptyClaim), 'citation-empty-claim');
      const insecure = await h.post('/v1/web-search/citations', { claim: 'forge is real', sourceUrl: 'http://example.com' }, { cookie });
      assert.equal(await errorCode(insecure), 'citation-insecure-scheme:http');
      const noScheme = await h.post('/v1/web-search/citations', { claim: 'forge is real', sourceUrl: 'example.com' }, { cookie });
      assert.equal(await errorCode(noScheme), 'citation-missing-scheme');
      const claimTooLong = await h.post('/v1/web-search/citations', { claim: 'f'.repeat(5001), sourceUrl: 'https://example.com' }, { cookie });
      assert.equal(await errorCode(claimTooLong), 'citation-claim-too-long');
      const titleTooLong = await h.post('/v1/web-search/citations', { claim: 'forge is real', sourceUrl: 'https://example.com', sourceTitle: 't'.repeat(501) }, { cookie });
      assert.equal(await errorCode(titleTooLong), 'citation-title-too-long');
      const quoteTooLong = await h.post('/v1/web-search/citations', { claim: 'forge is real', sourceUrl: 'https://example.com', quote: 'q'.repeat(5001) }, { cookie });
      assert.equal(await errorCode(quoteTooLong), 'citation-quote-too-long');
      const listed = (await (await h.post('/v1/web-search/citations/list', { limit: '5' }, { cookie })).json()) as { citations: Array<{ claimText: string }> };
      assert.equal(listed.citations.length, 1);
      assert.equal(listed.citations[0]?.claimText, 'forge is real');
    } finally {
      await h.close();
    }
  });

  it('validates rule lists and rejects unknown body fields', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'ws-validate@forge.test');
      const nonArray = await h.post('/v1/web-search/domain-rules', { workspace: 'loose', allow: 'example.com', deny: 42 }, { cookie });
      assert.equal(nonArray.status, 200);
      const coerced = (await nonArray.json()) as { rules: { workspace: string; allow: string[]; deny: string[] } };
      assert.equal(coerced.rules.workspace, 'loose');
      assert.deepEqual(coerced.rules.allow, []);
      assert.deepEqual(coerced.rules.deny, []);
      const overlap = await h.post('/v1/web-search/domain-rules', { allow: ['example.com'], deny: ['example.com'] }, { cookie });
      assert.equal(await errorCode(overlap), 'rules-allow-deny-overlap:example.com');
      const invalid = await h.post('/v1/web-search/domain-rules', { allow: ['not a domain'] }, { cookie });
      assert.equal(await errorCode(invalid), 'rules-invalid-domain:not a domain');
      const notString = await h.post('/v1/web-search/domain-rules', { deny: [42] }, { cookie });
      assert.equal(await errorCode(notString), 'rules-not-a-string:42');
      const duplicate = await h.post('/v1/web-search/domain-rules', { allow: ['a.com', 'a.com'] }, { cookie });
      assert.equal(await errorCode(duplicate), 'rules-duplicate-domain:a.com');
      const tooMany: string[] = [];
      for (let i = 0; i < 201; i++) tooMany.push('w' + i + '.example');
      const allowTooMany = await h.post('/v1/web-search/domain-rules', { allow: tooMany }, { cookie });
      assert.equal(await errorCode(allowTooMany), 'rules-too-many:allow');
      const denyTooMany = await h.post('/v1/web-search/domain-rules', { deny: tooMany }, { cookie });
      assert.equal(await errorCode(denyTooMany), 'rules-too-many:deny');
      const unknownField = await h.post('/v1/web-search/queries/list', { limit: '5', pageSize: 10 }, { cookie });
      assert.equal(unknownField.status, 400);
      assert.equal(await errorCode(unknownField), 'invalid_request');
      const unknownRulesField = await h.post('/v1/web-search/domain-rules/get', { workspace: 'x', limit: 2 }, { cookie });
      assert.equal(await errorCode(unknownRulesField), 'invalid_request');
    } finally {
      await h.close();
    }
  });

  it('slices long workspace names and clamps list limits', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'ws-limits@forge.test');
      const sliced = await h.post(
        '/v1/web-search/search',
        {
          workspace: 'w'.repeat(70),
          query: 'forge',
          results: [{ url: 'https://a.example/1', title: 'forge', publishedAt: null }],
        },
        { cookie },
      );
      assert.equal(sliced.status, 201);
      const slicedBody = (await sliced.json()) as { workspace: string };
      assert.equal(slicedBody.workspace, 'w'.repeat(64));
      await h.post('/v1/web-search/search', { query: 'forge', results: [{ url: 'https://a.example/2', title: 'forge', publishedAt: null }] }, { cookie });
      await h.post('/v1/web-search/search', { workspace: '  research  ', query: 'forge', results: [{ url: 'https://a.example/3', title: 'forge', publishedAt: null }] }, { cookie });
      const two = (await (await h.post('/v1/web-search/queries/list', { limit: '2' }, { cookie })).json()) as { queries: Array<{ query: string }> };
      assert.equal(two.queries.length, 2);
      const one = (await (await h.post('/v1/web-search/queries/list', { limit: '-3' }, { cookie })).json()) as { queries: Array<{ query: string }> };
      assert.equal(one.queries.length, 1);
      const all = (await (await h.post('/v1/web-search/queries/list', { limit: '0' }, { cookie })).json()) as { queries: Array<{ query: string }> };
      assert.equal(all.queries.length, 3);
      const fallback = (await (await h.post('/v1/web-search/queries/list', { limit: 'abc' }, { cookie })).json()) as { queries: Array<{ query: string }> };
      assert.equal(fallback.queries.length, 3);
      const trimmed = (await (await h.post('/v1/web-search/domain-rules/get', { workspace: '  research  ' }, { cookie })).json()) as { rules: { workspace: string } };
      assert.equal(trimmed.rules.workspace, 'research');
    } finally {
      await h.close();
    }
  });
});
