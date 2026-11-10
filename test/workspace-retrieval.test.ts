import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

async function signedInUser(h: Harness, email: string): Promise<string> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'WR Tester' });
  assert.equal(register.status, 201);
  const signIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signIn.status, 200);
  return sessionCookie(signIn);
}

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

interface ItemRecord {
  id: string;
  userId: string;
  source: string;
  title: string;
  body: string;
  links: string[];
  createdAt: number;
  updatedAt: number;
}

interface ReportRecord {
  id: string;
  userId: string;
  topic: string;
  summary: string;
  findings: Array<{ claim: string; sources: string[]; verified: boolean }>;
  verifiedCount: number;
  unverifiedCount: number;
  openQuestions: string[];
  createdAt: number;
}

async function recordItem(h: Harness, cookie: string, item: Record<string, unknown>): Promise<ItemRecord> {
  const res = await h.post('/v1/workspace-retrieval/items', { items: [item] }, { cookie });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { recorded: number; items: ItemRecord[] };
  assert.equal(body.recorded, 1);
  return body.items[0] as ItemRecord;
}

describe('workspace retrieval routes (FORGE AI-062..066)', () => {
  it('refuses every route without a session', async () => {
    const h = await startHarness();
    try {
      const catalog = await h.get('/v1/workspace-retrieval/library/catalog');
      assert.equal(catalog.status, 401);
      assert.equal(await errorCode(catalog), 'unauthenticated');
      const librarySearch = await h.post('/v1/workspace-retrieval/library/search', { library: 'react', version: '18.2.0', query: 'cache' });
      assert.equal(librarySearch.status, 401);
      assert.equal(await errorCode(librarySearch), 'unauthenticated');
      const sources = await h.get('/v1/workspace-retrieval/sources');
      assert.equal(sources.status, 401);
      assert.equal(await errorCode(sources), 'unauthenticated');
      const lanes = await h.get('/v1/workspace-retrieval/hybrid/lanes');
      assert.equal(lanes.status, 401);
      assert.equal(await errorCode(lanes), 'unauthenticated');
      const steps = await h.get('/v1/workspace-retrieval/research/steps');
      assert.equal(steps.status, 401);
      assert.equal(await errorCode(steps), 'unauthenticated');
      const items = await h.post('/v1/workspace-retrieval/items', { items: [{ source: 'code', title: 't', body: 'b' }] });
      assert.equal(items.status, 401);
      assert.equal(await errorCode(items), 'unauthenticated');
      const itemsList = await h.post('/v1/workspace-retrieval/items/list', { limit: 5 });
      assert.equal(itemsList.status, 401);
      assert.equal(await errorCode(itemsList), 'unauthenticated');
      const workspaceSearch = await h.post('/v1/workspace-retrieval/workspace/search', { query: 'cache' });
      assert.equal(workspaceSearch.status, 401);
      assert.equal(await errorCode(workspaceSearch), 'unauthenticated');
      const hybridSearch = await h.post('/v1/workspace-retrieval/hybrid/search', { query: 'cache' });
      assert.equal(hybridSearch.status, 401);
      assert.equal(await errorCode(hybridSearch), 'unauthenticated');
      const rerank = await h.post('/v1/workspace-retrieval/rerank', { candidates: [{ key: 'k', title: 't', body: 'b', score: 1 }] });
      assert.equal(rerank.status, 401);
      assert.equal(await errorCode(rerank), 'unauthenticated');
      const plan = await h.post('/v1/workspace-retrieval/research/plan', { topic: 'cache coherence' });
      assert.equal(plan.status, 401);
      assert.equal(await errorCode(plan), 'unauthenticated');
      const reportsGet = await h.get('/v1/workspace-retrieval/research/reports');
      assert.equal(reportsGet.status, 401);
      assert.equal(await errorCode(reportsGet), 'unauthenticated');
      const reportPost = await h.post('/v1/workspace-retrieval/research/reports', { topic: 't', findings: [{ claim: 'c', sources: ['a'] }] });
      assert.equal(reportPost.status, 401);
      assert.equal(await errorCode(reportPost), 'unauthenticated');
      const reportsList = await h.post('/v1/workspace-retrieval/research/reports/list', { limit: 5 });
      assert.equal(reportsList.status, 401);
      assert.equal(await errorCode(reportsList), 'unauthenticated');
      const reportFetch = await h.post('/v1/workspace-retrieval/research/reports/get', { id: 'x' });
      assert.equal(reportFetch.status, 401);
      assert.equal(await errorCode(reportFetch), 'unauthenticated');
    } finally {
      await h.close();
    }
  });

  it('lists the catalog, sources, lanes and steps and searches pinned library docs', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'wr-library@forge.test');
      const catalog = await h.get('/v1/workspace-retrieval/library/catalog', { cookie });
      assert.equal(catalog.status, 200);
      const catalogBody = (await catalog.json()) as { libraries: Array<{ name: string; versions: string[] }> };
      assert.deepEqual(catalogBody.libraries, [
        { name: 'react', versions: ['18.2.0', '19.0.0'] },
        { name: 'express', versions: ['4.18.2'] },
        { name: 'typeorm', versions: ['0.3.17', '0.3.20'] },
      ]);
      const search = await h.post('/v1/workspace-retrieval/library/search', { library: 'react', version: '18.2.0', query: 'caches computed' }, { cookie });
      assert.equal(search.status, 200);
      const searchBody = (await search.json()) as { library: string; version: string; results: Array<{ symbol: string; kind: string; summary: string }> };
      assert.deepEqual(searchBody, {
        library: 'react',
        version: '18.2.0',
        results: [{ symbol: 'useMemo', kind: 'hook', summary: 'Caches a computed value between renders' }],
      });
      const missingLibrary = await h.post('/v1/workspace-retrieval/library/search', { version: '18.2.0', query: 'cache' }, { cookie });
      assert.equal(missingLibrary.status, 400);
      assert.equal(await errorCode(missingLibrary), 'docs-library-missing');
      const unknownLibrary = await h.post('/v1/workspace-retrieval/library/search', { library: 'vue', version: '1.0.0', query: 'cache' }, { cookie });
      assert.equal(await errorCode(unknownLibrary), 'docs-library-unknown:vue');
      const missingVersion = await h.post('/v1/workspace-retrieval/library/search', { library: 'react', query: 'cache' }, { cookie });
      assert.equal(await errorCode(missingVersion), 'docs-version-missing');
      const unknownVersion = await h.post('/v1/workspace-retrieval/library/search', { library: 'react', version: '17.0.2', query: 'cache' }, { cookie });
      assert.equal(await errorCode(unknownVersion), 'docs-version-unknown:react:17.0.2');
      const missingQuery = await h.post('/v1/workspace-retrieval/library/search', { library: 'react', version: '18.2.0', query: '  ' }, { cookie });
      assert.equal(await errorCode(missingQuery), 'docs-query-missing');
      const sources = await h.get('/v1/workspace-retrieval/sources', { cookie });
      assert.equal(sources.status, 200);
      const sourcesBody = (await sources.json()) as { sources: string[] };
      assert.deepEqual(sourcesBody.sources, ['code', 'docs', 'issues', 'chats', 'assets']);
      const lanes = await h.get('/v1/workspace-retrieval/hybrid/lanes', { cookie });
      assert.equal(lanes.status, 200);
      const lanesBody = (await lanes.json()) as { lanes: string[] };
      assert.deepEqual(lanesBody.lanes, ['keyword', 'vector', 'graph']);
      const steps = await h.get('/v1/workspace-retrieval/research/steps', { cookie });
      assert.equal(steps.status, 200);
      const stepsBody = (await steps.json()) as { steps: string[] };
      assert.deepEqual(stepsBody.steps, ['search', 'read', 'cross-check', 'draft']);
    } finally {
      await h.close();
    }
  });

  it('records content items with named refusals and pre-existing links', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'wr-items@forge.test');
      const empty = await h.post('/v1/workspace-retrieval/items', {}, { cookie });
      assert.equal(empty.status, 400);
      assert.equal(await errorCode(empty), 'items-empty');
      const emptyList = await h.post('/v1/workspace-retrieval/items', { items: [] }, { cookie });
      assert.equal(await errorCode(emptyList), 'items-empty');
      const tooMany = await h.post(
        '/v1/workspace-retrieval/items',
        { items: Array.from({ length: 201 }, () => ({ source: 'code', title: 'i', body: 'b' })) },
        { cookie },
      );
      assert.equal(await errorCode(tooMany), 'items-count-invalid:201');
      const badSource = await h.post('/v1/workspace-retrieval/items', { items: [{ source: 'wiki', title: 't', body: 'b' }] }, { cookie });
      assert.equal(await errorCode(badSource), 'item-source-unknown:wiki');
      const noTitle = await h.post('/v1/workspace-retrieval/items', { items: [{ source: 'code', title: '   ', body: 'b' }] }, { cookie });
      assert.equal(await errorCode(noTitle), 'item-title-missing');
      const longTitle = await h.post('/v1/workspace-retrieval/items', { items: [{ source: 'code', title: 't'.repeat(501), body: 'b' }] }, { cookie });
      assert.equal(await errorCode(longTitle), 'item-title-too-long');
      const noBody = await h.post('/v1/workspace-retrieval/items', { items: [{ source: 'code', title: 't', body: '   ' }] }, { cookie });
      assert.equal(await errorCode(noBody), 'item-body-missing');
      const longBody = await h.post('/v1/workspace-retrieval/items', { items: [{ source: 'code', title: 't', body: 'b'.repeat(5001) }] }, { cookie });
      assert.equal(await errorCode(longBody), 'item-body-too-long');
      const linksNotArray = await h.post('/v1/workspace-retrieval/items', { items: [{ source: 'code', title: 't', body: 'b', links: 'x' }] }, { cookie });
      assert.equal(await errorCode(linksNotArray), 'item-links-not-array');
      const tooManyLinks = await h.post(
        '/v1/workspace-retrieval/items',
        { items: [{ source: 'code', title: 't', body: 'b', links: Array.from({ length: 51 }, (_, i) => 'l' + i) }] },
        { cookie },
      );
      assert.equal(await errorCode(tooManyLinks), 'item-links-too-many');
      const linkMissing = await h.post('/v1/workspace-retrieval/items', { items: [{ source: 'code', title: 't', body: 'b', links: [''] }] }, { cookie });
      assert.equal(await errorCode(linkMissing), 'item-link-missing');
      const linkUnknown = await h.post('/v1/workspace-retrieval/items', { items: [{ source: 'code', title: 't', body: 'b', links: ['nope'] }] }, { cookie });
      assert.equal(await errorCode(linkUnknown), 'item-link-unknown:nope');
      const recorded = await h.post(
        '/v1/workspace-retrieval/items',
        { items: [{ source: ' CODE ', title: '  Cache Store  ', body: 'The cache store holds entries' }] },
        { cookie },
      );
      assert.equal(recorded.status, 201);
      const rec = (await recorded.json()) as { recorded: number; items: ItemRecord[] };
      assert.equal(rec.recorded, 1);
      const item = rec.items[0] as ItemRecord;
      const idA = item.id;
      assert.deepEqual(
        { userId: item.userId.length > 0, source: item.source, title: item.title, body: item.body, links: item.links, createdAt: item.createdAt, updatedAt: item.updatedAt },
        { userId: true, source: 'code', title: 'Cache Store', body: 'The cache store holds entries', links: [], createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 },
      );
      const linked = await recordItem(h, cookie, { source: 'docs', title: 'Linked note', body: 'plain words here', links: [idA] });
      assert.deepEqual(linked.links, [idA]);
      const batch = await h.post(
        '/v1/workspace-retrieval/items',
        { items: [{ source: 'code', title: 'First', body: 'one' }, { source: 'docs', title: 'Second', body: 'two' }] },
        { cookie },
      );
      assert.equal(batch.status, 201);
      const batchBody = (await batch.json()) as { recorded: number; items: ItemRecord[] };
      assert.equal(batchBody.recorded, 2);
      assert.equal(batchBody.items.length, 2);
    } finally {
      await h.close();
    }
  });

  it('lists items newest first with clamped limits', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'wr-list@forge.test');
      await recordItem(h, cookie, { source: 'code', title: 'Alpha note', body: 'first body words' });
      await recordItem(h, cookie, { source: 'docs', title: 'Beta note', body: 'second body words' });
      await recordItem(h, cookie, { source: 'issues', title: 'Gamma note', body: 'third body words' });
      const two = await h.post('/v1/workspace-retrieval/items/list', { limit: '2' }, { cookie });
      assert.equal(two.status, 200);
      const twoBody = (await two.json()) as { items: ItemRecord[] };
      assert.deepEqual(twoBody.items.map((i) => i.title), ['Gamma note', 'Beta note']);
      const one = await h.post('/v1/workspace-retrieval/items/list', { limit: '-3' }, { cookie });
      const oneBody = (await one.json()) as { items: ItemRecord[] };
      assert.deepEqual(oneBody.items.map((i) => i.title), ['Gamma note']);
      const all = await h.post('/v1/workspace-retrieval/items/list', { limit: '0' }, { cookie });
      const allBody = (await all.json()) as { items: ItemRecord[] };
      assert.equal(allBody.items.length, 3);
      const fallback = await h.post('/v1/workspace-retrieval/items/list', { limit: 'abc' }, { cookie });
      const fallbackBody = (await fallback.json()) as { items: ItemRecord[] };
      assert.equal(fallbackBody.items.length, 3);
      const missing = await h.post('/v1/workspace-retrieval/items/list', {}, { cookie });
      const missingBody = (await missing.json()) as { items: ItemRecord[] };
      assert.equal(missingBody.items.length, 3);
      const unknown = await h.post('/v1/workspace-retrieval/items/list', { limit: '2', pageSize: 5 }, { cookie });
      assert.equal(unknown.status, 400);
      assert.equal(await errorCode(unknown), 'invalid_request');
    } finally {
      await h.close();
    }
  });

  it('searches the workspace and hybrid lanes with named refusals', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'wr-search@forge.test');
      const itemA = await recordItem(h, cookie, { source: 'code', title: 'Cache Store', body: 'The cache store holds entries' });
      const itemB = await recordItem(h, cookie, { source: 'docs', title: 'Notes', body: 'mentions cache once' });
      const ws = await h.post('/v1/workspace-retrieval/workspace/search', { query: 'cache' }, { cookie });
      assert.equal(ws.status, 200);
      const wsBody = (await ws.json()) as { hits: Array<{ id: string; source: string; title: string; score: number }> };
      assert.deepEqual(wsBody.hits, [
        { id: itemA.id, source: 'code', title: 'Cache Store', score: 4 },
        { id: itemB.id, source: 'docs', title: 'Notes', score: 1 },
      ]);
      const filtered = await h.post('/v1/workspace-retrieval/workspace/search', { query: 'cache', sources: ['DOCS'] }, { cookie });
      const filteredBody = (await filtered.json()) as { hits: Array<{ id: string; source: string; title: string; score: number }> };
      assert.deepEqual(filteredBody.hits, [{ id: itemB.id, source: 'docs', title: 'Notes', score: 1 }]);
      const noQuery = await h.post('/v1/workspace-retrieval/workspace/search', {}, { cookie });
      assert.equal(await errorCode(noQuery), 'retrieval-query-missing');
      const blankQuery = await h.post('/v1/workspace-retrieval/workspace/search', { query: '   ' }, { cookie });
      assert.equal(await errorCode(blankQuery), 'retrieval-query-missing');
      const sourcesNotArray = await h.post('/v1/workspace-retrieval/workspace/search', { query: 'cache', sources: 'code' }, { cookie });
      assert.equal(await errorCode(sourcesNotArray), 'retrieval-sources-not-array');
      const sourcesEmpty = await h.post('/v1/workspace-retrieval/workspace/search', { query: 'cache', sources: [] }, { cookie });
      assert.equal(await errorCode(sourcesEmpty), 'retrieval-sources-empty');
      const sourceUnknown = await h.post('/v1/workspace-retrieval/workspace/search', { query: 'cache', sources: ['wiki'] }, { cookie });
      assert.equal(await errorCode(sourceUnknown), 'retrieval-source-unknown:wiki');

      const hybridCookie = await signedInUser(h, 'wr-hybrid@forge.test');
      const docA = await recordItem(hybridCookie === '' ? h : h, hybridCookie, { source: 'code', title: 'Cache Store', body: 'The cache store holds entries' });
      const docC = await recordItem(h, hybridCookie, { source: 'docs', title: 'Linked page', body: 'plain words', links: [docA.id] });
      const keyword = await h.post('/v1/workspace-retrieval/hybrid/search', { query: 'cache', lanes: ['keyword'] }, { cookie: hybridCookie });
      assert.equal(keyword.status, 200);
      const keywordBody = (await keyword.json()) as { hits: Array<{ id: string; score: number }> };
      assert.deepEqual(keywordBody.hits, [{ id: docA.id, score: 1 }]);
      const graph = await h.post('/v1/workspace-retrieval/hybrid/search', { query: 'cache', lanes: ['graph'] }, { cookie: hybridCookie });
      const graphBody = (await graph.json()) as { hits: Array<{ id: string; score: number }> };
      assert.deepEqual(graphBody.hits, [{ id: docC.id, score: 1 }]);
      const allLanes = await h.post('/v1/workspace-retrieval/hybrid/search', { query: 'cache' }, { cookie: hybridCookie });
      const allLanesBody = (await allLanes.json()) as { hits: Array<{ id: string; score: number }> };
      assert.deepEqual(allLanesBody.hits, [
        { id: docA.id, score: 2 },
        { id: docC.id, score: 1 },
      ]);
      const hybridNoQuery = await h.post('/v1/workspace-retrieval/hybrid/search', {}, { cookie: hybridCookie });
      assert.equal(await errorCode(hybridNoQuery), 'hybrid-query-missing');
      const lanesNotArray = await h.post('/v1/workspace-retrieval/hybrid/search', { query: 'cache', lanes: 'keyword' }, { cookie: hybridCookie });
      assert.equal(await errorCode(lanesNotArray), 'hybrid-lanes-not-array');
      const lanesEmpty = await h.post('/v1/workspace-retrieval/hybrid/search', { query: 'cache', lanes: [] }, { cookie: hybridCookie });
      assert.equal(await errorCode(lanesEmpty), 'hybrid-lanes-empty');
      const laneUnknown = await h.post('/v1/workspace-retrieval/hybrid/search', { query: 'cache', lanes: ['keyword', 'semantic'] }, { cookie: hybridCookie });
      assert.equal(await errorCode(laneUnknown), 'hybrid-lane-unknown:semantic');
      const weightsInvalid = await h.post(
        '/v1/workspace-retrieval/hybrid/search',
        { query: 'cache', weights: { keyword: 0, vector: 0, graph: 0 } },
        { cookie: hybridCookie },
      );
      assert.equal(await errorCode(weightsInvalid), 'hybrid-weights-invalid');
    } finally {
      await h.close();
    }
  });

  it('reranks candidates and plans research with named refusals', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'wr-rerank@forge.test');
      const rr = await h.post(
        '/v1/workspace-retrieval/rerank',
        {
          candidates: [
            { key: 'Key-One  ', title: 'alpha beta', body: 'shared words here', score: 5 },
            { key: 'key-one', title: 'duplicate entry', body: 'different body', score: 9 },
            { key: 'key-two', title: 'gamma delta', body: 'other words', score: 4 },
          ],
          lambda: 0.5,
          depth: 10,
        },
        { cookie },
      );
      assert.equal(rr.status, 200);
      const rrBody = (await rr.json()) as { removedDuplicates: number; results: Array<{ key: string; title: string; body: string; score: number }> };
      assert.deepEqual(rrBody, {
        removedDuplicates: 1,
        results: [
          { key: 'Key-One  ', title: 'alpha beta', body: 'shared words here', score: 5 },
          { key: 'key-two', title: 'gamma delta', body: 'other words', score: 4 },
        ],
      });
      const noCandidates = await h.post('/v1/workspace-retrieval/rerank', {}, { cookie });
      assert.equal(await errorCode(noCandidates), 'rerank-candidates-empty');
      const emptyCandidates = await h.post('/v1/workspace-retrieval/rerank', { candidates: [] }, { cookie });
      assert.equal(await errorCode(emptyCandidates), 'rerank-candidates-empty');
      const badLambda = await h.post('/v1/workspace-retrieval/rerank', { candidates: [{ key: 'a', title: 't', body: 'b', score: 1 }], lambda: 2 }, { cookie });
      assert.equal(await errorCode(badLambda), 'rerank-lambda-invalid');
      const badDepth = await h.post('/v1/workspace-retrieval/rerank', { candidates: [{ key: 'a', title: 't', body: 'b', score: 1 }], depth: 0 }, { cookie });
      assert.equal(await errorCode(badDepth), 'rerank-depth-invalid');
      const blankKey = await h.post('/v1/workspace-retrieval/rerank', { candidates: [{ key: '  ', title: 't', body: 'b', score: 1 }] }, { cookie });
      assert.equal(await errorCode(blankKey), 'rerank-key-missing');
      const badScore = await h.post('/v1/workspace-retrieval/rerank', { candidates: [{ key: 'a', title: 't', body: 'b', score: 'hi' }] }, { cookie });
      assert.equal(await errorCode(badScore), 'rerank-score-invalid');

      const plan = await h.post('/v1/workspace-retrieval/research/plan', { topic: 'cache coherence' }, { cookie });
      assert.equal(plan.status, 200);
      const planBody = (await plan.json()) as { topic: string; steps: string[]; stepCount: number };
      assert.deepEqual(planBody, { topic: 'cache coherence', steps: ['search', 'read', 'cross-check', 'draft'], stepCount: 4 });
      const noTopic = await h.post('/v1/workspace-retrieval/research/plan', {}, { cookie });
      assert.equal(await errorCode(noTopic), 'research-topic-missing');
      const blankTopic = await h.post('/v1/workspace-retrieval/research/plan', { topic: '  ' }, { cookie });
      assert.equal(await errorCode(blankTopic), 'research-topic-missing');
      const stepsNotArray = await h.post('/v1/workspace-retrieval/research/plan', { topic: 'x', steps: 'search' }, { cookie });
      assert.equal(await errorCode(stepsNotArray), 'research-steps-not-array');
      const stepsEmpty = await h.post('/v1/workspace-retrieval/research/plan', { topic: 'x', steps: [] }, { cookie });
      assert.equal(await errorCode(stepsEmpty), 'research-steps-empty');
      const subset = await h.post('/v1/workspace-retrieval/research/plan', { topic: 'x', steps: ['SEARCH', 'read'] }, { cookie });
      const subsetBody = (await subset.json()) as { topic: string; steps: string[]; stepCount: number };
      assert.deepEqual(subsetBody, { topic: 'x', steps: ['search', 'read'], stepCount: 2 });
      const outOfOrder = await h.post('/v1/workspace-retrieval/research/plan', { topic: 'x', steps: ['draft', 'search'] }, { cookie });
      assert.equal(await errorCode(outOfOrder), 'research-steps-out-of-order');
      const duplicateStep = await h.post('/v1/workspace-retrieval/research/plan', { topic: 'x', steps: ['search', 'search'] }, { cookie });
      assert.equal(await errorCode(duplicateStep), 'research-step-duplicate:search');
      const unknownStep = await h.post('/v1/workspace-retrieval/research/plan', { topic: 'x', steps: ['search', 'fly'] }, { cookie });
      assert.equal(await errorCode(unknownStep), 'research-step-unknown:fly');
    } finally {
      await h.close();
    }
  });

  it('builds, lists and fetches research reports', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'wr-reports@forge.test');
      const noTopic = await h.post('/v1/workspace-retrieval/research/reports', {}, { cookie });
      assert.equal(noTopic.status, 400);
      assert.equal(await errorCode(noTopic), 'research-topic-missing');
      const noFindings = await h.post('/v1/workspace-retrieval/research/reports', { topic: 't' }, { cookie });
      assert.equal(await errorCode(noFindings), 'research-findings-empty');
      const noClaim = await h.post('/v1/workspace-retrieval/research/reports', { topic: 't', findings: [{ sources: ['a'] }] }, { cookie });
      assert.equal(await errorCode(noClaim), 'research-claim-missing');
      const noSource = await h.post('/v1/workspace-retrieval/research/reports', { topic: 't', findings: [{ claim: 'c' }] }, { cookie });
      assert.equal(await errorCode(noSource), 'research-source-missing');
      const blankSource = await h.post('/v1/workspace-retrieval/research/reports', { topic: 't', findings: [{ claim: 'c', sources: ['  '] }] }, { cookie });
      assert.equal(await errorCode(blankSource), 'research-source-blank');
      const questionsNotArray = await h.post(
        '/v1/workspace-retrieval/research/reports',
        { topic: 't', findings: [{ claim: 'c', sources: ['a'] }], openQuestions: 'why' },
        { cookie },
      );
      assert.equal(await errorCode(questionsNotArray), 'research-questions-not-array');
      const blankQuestion = await h.post(
        '/v1/workspace-retrieval/research/reports',
        { topic: 't', findings: [{ claim: 'c', sources: ['a'] }], openQuestions: [''] },
        { cookie },
      );
      assert.equal(await errorCode(blankQuestion), 'research-question-blank');
      const created = await h.post(
        '/v1/workspace-retrieval/research/reports',
        {
          topic: 'cache coherence',
          findings: [
            { claim: 'verified claim', sources: ['a', 'b'] },
            { claim: 'single source claim', sources: ['c'] },
          ],
          openQuestions: [' why now? '],
        },
        { cookie },
      );
      assert.equal(created.status, 201);
      const report = (await created.json()) as ReportRecord;
      const reportId = report.id;
      assert.deepEqual(
        {
          userId: report.userId.length > 0,
          topic: report.topic,
          summary: report.summary,
          findings: report.findings,
          verifiedCount: report.verifiedCount,
          unverifiedCount: report.unverifiedCount,
          openQuestions: report.openQuestions,
          createdAt: report.createdAt,
        },
        {
          userId: true,
          topic: 'cache coherence',
          summary: 'Investigation of cache coherence with 2 findings',
          findings: [
            { claim: 'verified claim', sources: ['a', 'b'], verified: true },
            { claim: 'single source claim', sources: ['c'], verified: false },
          ],
          verifiedCount: 1,
          unverifiedCount: 1,
          openQuestions: ['why now?'],
          createdAt: 1_800_000_000_000,
        },
      );
      const second = await h.post('/v1/workspace-retrieval/research/reports', { topic: 'second topic', findings: [{ claim: 'only finding', sources: ['s1', 's2'] }] }, { cookie });
      assert.equal(second.status, 201);
      const listed = await h.get('/v1/workspace-retrieval/research/reports', { cookie });
      assert.equal(listed.status, 200);
      const listedBody = (await listed.json()) as { reports: ReportRecord[] };
      assert.equal(listedBody.reports.length, 2);
      assert.equal(listedBody.reports[0]?.topic, 'second topic');
      assert.equal(listedBody.reports[1]?.topic, 'cache coherence');
      const one = await h.post('/v1/workspace-retrieval/research/reports/list', { limit: '1' }, { cookie });
      const oneBody = (await one.json()) as { reports: ReportRecord[] };
      assert.equal(oneBody.reports.length, 1);
      assert.equal(oneBody.reports[0]?.topic, 'second topic');
      const fetched = await h.post('/v1/workspace-retrieval/research/reports/get', { id: reportId }, { cookie });
      assert.equal(fetched.status, 200);
      const fetchedBody = (await fetched.json()) as ReportRecord;
      assert.equal(fetchedBody.id, reportId);
      assert.equal(fetchedBody.topic, 'cache coherence');
      assert.equal(fetchedBody.verifiedCount, 1);
      const notFound = await h.post('/v1/workspace-retrieval/research/reports/get', { id: 'missing' }, { cookie });
      assert.equal(notFound.status, 400);
      assert.equal(await errorCode(notFound), 'research-report-not-found:missing');
      const unknownField = await h.post('/v1/workspace-retrieval/research/reports/get', { id: reportId, extra: true }, { cookie });
      assert.equal(unknownField.status, 400);
      assert.equal(await errorCode(unknownField), 'invalid_request');
    } finally {
      await h.close();
    }
  });
});
