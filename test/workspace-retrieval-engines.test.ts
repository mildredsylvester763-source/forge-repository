import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { checkLibrary, LIBRARY_CATALOG, searchLibraryDocs } from '../src/modules/workspace-retrieval/engine/library-docs.ts';
import { RETRIEVAL_SOURCES, searchWorkspaceContent } from '../src/modules/workspace-retrieval/engine/workspace-retrieval.ts';
import { hybridSearch, HYBRID_LANES, tokenize } from '../src/modules/workspace-retrieval/engine/hybrid-search.ts';
import { rerank } from '../src/modules/workspace-retrieval/engine/result-rerank.ts';
import { buildResearchReport, planResearch, RESEARCH_STEPS } from '../src/modules/workspace-retrieval/engine/research-mode.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('library docs engine (FORGE AI-062)', () => {
  it('pins the catalog and validates in a fixed order', () => {
    assert.deepEqual(
      LIBRARY_CATALOG.map((l) => ({ name: l.name, versions: [...l.versions] })),
      [
        { name: 'react', versions: ['18.2.0', '19.0.0'] },
        { name: 'express', versions: ['4.18.2'] },
        { name: 'typeorm', versions: ['0.3.17', '0.3.20'] },
      ],
    );
    assert.deepEqual(checkLibrary({}), { ok: false, reason: 'docs-library-missing' });
    assert.deepEqual(checkLibrary({ library: '  ' }), { ok: false, reason: 'docs-library-missing' });
    assert.deepEqual(checkLibrary({ library: 'vue' }), { ok: false, reason: 'docs-library-unknown:vue' });
    assert.deepEqual(checkLibrary({ library: 'react' }), { ok: false, reason: 'docs-version-missing' });
    assert.deepEqual(checkLibrary({ library: 'react', version: '17.0.2' }), { ok: false, reason: 'docs-version-unknown:react:17.0.2' });
    assert.deepEqual(checkLibrary({ library: 'React', version: ' 18.2.0 ' }), { ok: true, library: 'react', version: '18.2.0' });
  });

  it('searches with AND semantics over symbol, kind and summary', () => {
    assert.deepEqual(searchLibraryDocs({ library: 'react', version: '18.2.0', query: 'caches computed' }), {
      ok: true,
      library: 'react',
      version: '18.2.0',
      results: [{ symbol: 'useMemo', kind: 'hook', summary: 'Caches a computed value between renders' }],
    });
    assert.deepEqual(searchLibraryDocs({ library: 'react', version: '18.2.0', query: 'state caches' }), {
      ok: true,
      library: 'react',
      version: '18.2.0',
      results: [],
    });
    assert.deepEqual(searchLibraryDocs({ library: 'react', version: '18.2.0' }), { ok: false, reason: 'docs-query-missing' });
    assert.deepEqual(searchLibraryDocs({ version: '18.2.0', query: 'state' }), { ok: false, reason: 'docs-library-missing' });
  });

  it('sweeps randomized doc searches against an independent oracle', () => {
    const rand = mulberry32(42);
    const rows = [
      { name: 'react', version: '18.2.0', symbol: 'useState', kind: 'hook', summary: 'Adds state to a function component' },
      { name: 'react', version: '18.2.0', symbol: 'useMemo', kind: 'hook', summary: 'Caches a computed value between renders' },
      { name: 'react', version: '19.0.0', symbol: 'useState', kind: 'hook', summary: 'Adds state with actions support' },
      { name: 'react', version: '19.0.0', symbol: 'use', kind: 'hook', summary: 'Reads a promise or context during render' },
      { name: 'express', version: '4.18.2', symbol: 'app.get', kind: 'method', summary: 'Routes GET requests to a handler' },
      { name: 'express', version: '4.18.2', symbol: 'app.listen', kind: 'method', summary: 'Starts the HTTP server on a port' },
      { name: 'typeorm', version: '0.3.17', symbol: 'Repository.find', kind: 'method', summary: 'Loads rows matching the where clause' },
      { name: 'typeorm', version: '0.3.20', symbol: 'Repository.find', kind: 'method', summary: 'Loads rows matching the where clause' },
      { name: 'typeorm', version: '0.3.20', symbol: 'DataSource', kind: 'class', summary: 'Entry point for database connections' },
    ];
    const oracleDocs = (library: string, version: string, query: string) => {
      const lib = library.trim().toLowerCase();
      if (lib.length === 0) return { ok: false, reason: 'docs-library-missing' };
      const libVersions = [...new Set(rows.filter((r) => r.name === lib).map((r) => r.version))];
      if (libVersions.length === 0) return { ok: false, reason: 'docs-library-unknown:' + lib };
      const ver = version.trim();
      if (ver.length === 0) return { ok: false, reason: 'docs-version-missing' };
      if (!libVersions.includes(ver)) return { ok: false, reason: 'docs-version-unknown:' + lib + ':' + ver };
      const q = query.trim().toLowerCase();
      if (q.length === 0) return { ok: false, reason: 'docs-query-missing' };
      const terms = q.split(/\s+/).filter((t) => t.length > 0);
      const results = rows.filter((r) => r.name === lib && r.version === ver).filter((r) => {
        const hay = (r.symbol + ' ' + r.kind + ' ' + r.summary).toLowerCase();
        return terms.every((t) => hay.includes(t));
      }).map((r) => ({ symbol: r.symbol, kind: r.kind, summary: r.summary }));
      return { ok: true, library: lib, version: ver, results };
    };
    const names = ['react', 'express', 'typeorm', 'vue', '', '  ', 'REACT'];
    const versions = ['18.2.0', '19.0.0', '4.18.2', '0.3.17', '0.3.20', '9.9.9', '', ' 18.2.0 '];
    const words = ['state', 'caches', 'computed', 'hook', 'method', 'routes', 'promise', 'repository', 'value', 'renders', 'database', 'server', 'between', 'context'];
    for (let c = 0; c < 500; c++) {
      const library = names[Math.floor(rand() * names.length)]!;
      const version = versions[Math.floor(rand() * versions.length)]!;
      const nWords = 1 + Math.floor(rand() * 3);
      const terms: string[] = [];
      for (let w = 0; w < nWords; w++) terms.push(words[Math.floor(rand() * words.length)]!);
      const query = rand() < 0.1 ? '' : terms.join(' ');
      assert.deepEqual(searchLibraryDocs({ library, version, query }), oracleDocs(library, version, query));
    }
  });
});

describe('workspace retrieval engine (FORGE AI-063)', () => {
  it('scores titles and bodies and sorts by score then id', () => {
    const items = [
      { id: 'b', source: 'code', title: 'Cache Store', body: 'The cache store holds entries' },
      { id: 'a', source: 'docs', title: 'Cache notes', body: 'Notes about the cache store' },
      { id: 'c', source: 'code', title: 'Unrelated', body: 'Nothing to see' },
    ];
    assert.deepEqual(searchWorkspaceContent({ items, query: 'cache' }), {
      ok: true,
      hits: [
        { id: 'a', source: 'docs', title: 'Cache notes', score: 4 },
        { id: 'b', source: 'code', title: 'Cache Store', score: 4 },
      ],
    });
    assert.deepEqual(searchWorkspaceContent({ items, query: '   ' }), { ok: false, reason: 'retrieval-query-missing' });
    assert.deepEqual(searchWorkspaceContent({ items, query: 'cache', sources: 'code' }), { ok: false, reason: 'retrieval-sources-not-array' });
    assert.deepEqual(searchWorkspaceContent({ items, query: 'cache', sources: [] }), { ok: false, reason: 'retrieval-sources-empty' });
    assert.deepEqual(searchWorkspaceContent({ items, query: 'cache', sources: ['meetings'] }), { ok: false, reason: 'retrieval-source-unknown:meetings' });
    assert.deepEqual(searchWorkspaceContent({ items, query: 'cache', sources: ['CODE'] }), {
      ok: true,
      hits: [{ id: 'b', source: 'code', title: 'Cache Store', score: 4 }],
    });
    assert.deepEqual(RETRIEVAL_SOURCES, ['code', 'docs', 'issues', 'chats', 'assets']);
  });

  it('sweeps randomized retrieval against an independent oracle', () => {
    const rand = mulberry32(42);
    const FIVE = ['code', 'docs', 'issues', 'chats', 'assets'];
    const oracleRetr = (
      items: Array<{ id: string; source: string; title: string; body: string }>,
      query: string,
      sources: unknown,
    ) => {
      const q = query.trim().toLowerCase();
      if (q.length === 0) return { ok: false, reason: 'retrieval-query-missing' };
      let allowed = FIVE.slice();
      if (sources !== undefined && sources !== null) {
        if (!Array.isArray(sources)) return { ok: false, reason: 'retrieval-sources-not-array' };
        const seen: string[] = [];
        for (const raw of sources) {
          const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
          if (!FIVE.includes(s)) return { ok: false, reason: 'retrieval-source-unknown:' + (typeof raw === 'string' ? raw.trim() : String(raw)) };
          if (!seen.includes(s)) seen.push(s);
        }
        if (seen.length === 0) return { ok: false, reason: 'retrieval-sources-empty' };
        allowed = seen;
      }
      const terms = q.split(/\s+/).filter((t) => t.length > 0);
      const hits: Array<{ id: string; source: string; title: string; score: number }> = [];
      for (const item of items) {
        const source = item.source.trim().toLowerCase();
        if (!allowed.includes(source)) continue;
        const title = item.title.toLowerCase();
        const body = item.body.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (title.includes(t)) score += 3;
          if (body.includes(t)) score += 1;
        }
        if (score > 0) hits.push({ id: item.id, source, title: item.title, score });
      }
      hits.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { ok: true, hits };
    };
    const words = ['cache', 'store', 'entry', 'index', 'query', 'plan', 'notes', 'engine', 'forge', 'unit'];
    const sourcePool = FIVE.concat(['CODE', 'Docs ', 'weird']);
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rand() * 6);
      const items = [];
      for (let i = 0; i < n; i++) {
        items.push({
          id: 'i' + Math.floor(rand() * 100),
          source: sourcePool[Math.floor(rand() * sourcePool.length)]!,
          title: words[Math.floor(rand() * words.length)]! + ' ' + words[Math.floor(rand() * words.length)]!,
          body: words[Math.floor(rand() * words.length)]! + ' ' + words[Math.floor(rand() * words.length)]! + ' ' + words[Math.floor(rand() * words.length)]!,
        });
      }
      const query = rand() < 0.08 ? '  ' : words[Math.floor(rand() * words.length)]! + (rand() < 0.5 ? ' ' + words[Math.floor(rand() * words.length)]! : '');
      let sources: unknown;
      const roll = rand();
      if (roll < 0.15) sources = undefined;
      else if (roll < 0.25) sources = [];
      else if (roll < 0.3) sources = 'code';
      else {
        const ns = 1 + Math.floor(rand() * 3);
        const list: string[] = [];
        for (let s = 0; s < ns; s++) list.push(sourcePool[Math.floor(rand() * sourcePool.length)]!);
        sources = list;
      }
      assert.deepEqual(searchWorkspaceContent({ items, query, sources }), oracleRetr(items, query, sources));
    }
  });
});

describe('hybrid search engine (FORGE AI-064)', () => {
  it('fuses three lanes with per-lane weights', () => {
    assert.deepEqual(HYBRID_LANES, ['keyword', 'vector', 'graph']);
    assert.deepEqual(tokenize('Cache-3.0 store!!'), ['cache', '3', '0', 'store']);
    assert.deepEqual(hybridSearch({ docs: [], query: '  ' }), { ok: false, reason: 'hybrid-query-missing' });
    assert.deepEqual(hybridSearch({ docs: [], query: 'x', lanes: 'keyword' }), { ok: false, reason: 'hybrid-lanes-not-array' });
    assert.deepEqual(hybridSearch({ docs: [], query: 'x', lanes: [] }), { ok: false, reason: 'hybrid-lanes-empty' });
    assert.deepEqual(hybridSearch({ docs: [], query: 'x', lanes: ['keyword', 'semantic'] }), { ok: false, reason: 'hybrid-lane-unknown:semantic' });
    assert.deepEqual(hybridSearch({ docs: [], query: 'x', weights: { keyword: 0, vector: 0, graph: 0 } }), { ok: false, reason: 'hybrid-weights-invalid' });
    const docs = [
      { id: 'd1', title: 'cache store notes', body: 'the cache store holds entries' },
      { id: 'd2', title: 'unrelated', body: 'nothing here' },
      { id: 'd3', title: 'linked page', body: 'empty', links: ['d1'] },
    ];
    assert.deepEqual(hybridSearch({ docs, query: 'cache', lanes: ['keyword'] }), { ok: true, hits: [{ id: 'd1', score: 1 }] });
    assert.deepEqual(hybridSearch({ docs, query: 'cache', lanes: ['graph'] }), { ok: true, hits: [{ id: 'd3', score: 1 }] });
    assert.deepEqual(hybridSearch({ docs, query: 'cache', lanes: ['keyword'], weights: { keyword: 2, vector: 1, graph: 1 } }), { ok: true, hits: [{ id: 'd1', score: 2 }] });
    const vDocs = [
      { id: 'v1', title: 'alpha beta', body: 'gamma' },
      { id: 'v2', title: 'delta', body: 'epsilon' },
    ];
    assert.deepEqual(hybridSearch({ docs: vDocs, query: 'alpha beta gamma', lanes: ['vector'] }), { ok: true, hits: [{ id: 'v1', score: 1 }] });
  });

  it('sweeps randomized hybrid searches against an independent oracle', () => {
    const rand = mulberry32(42);
    const LANES = ['keyword', 'vector', 'graph'];
    const oTok = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
    const oFnv = (text: string): number => {
      let h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return h >>> 0;
    };
    const oVec = (text: string): number[] => {
      const v = new Array(64).fill(0);
      for (const t of oTok(text)) {
        const idx = oFnv(t) % 64;
        v[idx] = (v[idx] ?? 0) + 1;
      }
      return v;
    };
    const oCos = (a: number[], b: number[]): number => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < 64; i++) {
        const av = a[i] ?? 0;
        const bv = b[i] ?? 0;
        dot += av * bv;
        na += av * av;
        nb += bv * bv;
      }
      if (na === 0 || nb === 0) return 0;
      return dot / Math.sqrt(na) / Math.sqrt(nb);
    };
    const oracleHyb = (
      docs: Array<{ id: string; title: string; body: string; links?: string[] }>,
      query: string,
      weights: Record<string, number> | undefined,
      lanes: unknown,
    ) => {
      if (query.trim().length === 0) return { ok: false, reason: 'hybrid-query-missing' };
      let useLanes = LANES.slice();
      if (lanes !== undefined && lanes !== null) {
        if (!Array.isArray(lanes)) return { ok: false, reason: 'hybrid-lanes-not-array' };
        if (lanes.length === 0) return { ok: false, reason: 'hybrid-lanes-empty' };
        for (const lane of lanes) {
          if (!LANES.includes(lane)) return { ok: false, reason: 'hybrid-lane-unknown:' + String(lane) };
        }
        useLanes = lanes.slice();
      }
      let w: Record<string, number> = { keyword: 1, vector: 1, graph: 1 };
      if (weights !== undefined && weights !== null) {
        const next: Record<string, number> = {};
        for (const lane of LANES) {
          const value = weights[lane];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { ok: false, reason: 'hybrid-weights-invalid' };
          next[lane] = value;
        }
        const sum = (next.keyword ?? 0) + (next.vector ?? 0) + (next.graph ?? 0);
        if (sum <= 0) return { ok: false, reason: 'hybrid-weights-invalid' };
        w = next;
      }
      const terms = oTok(query);
      const kw: Record<string, number> = {};
      for (const doc of docs) {
        const hay = oTok(doc.title + ' ' + doc.body);
        let hits = 0;
        for (const t of terms) {
          if (hay.includes(t)) hits++;
        }
        kw[doc.id] = terms.length === 0 ? 0 : hits / terms.length;
      }
      const vec: Record<string, number> = {};
      const qv = oVec(query);
      for (const doc of docs) vec[doc.id] = oCos(qv, oVec(doc.title + ' ' + doc.body));
      const graph: Record<string, number> = {};
      for (const doc of docs) {
        let best = 0;
        for (const link of doc.links ?? []) {
          const linked = kw[link];
          if (typeof linked === 'number' && linked > best) best = linked;
        }
        graph[doc.id] = best;
      }
      const norm = (scores: Record<string, number>): Record<string, number> => {
        const max = Math.max(0, ...docs.map((d) => scores[d.id] ?? 0));
        const out: Record<string, number> = {};
        for (const doc of docs) out[doc.id] = max > 0 ? (scores[doc.id] ?? 0) / max : 0;
        return out;
      };
      const kwN = norm(kw);
      const vecN = norm(vec);
      const graphN = norm(graph);
      const hits: Array<{ id: string; score: number }> = [];
      for (const doc of docs) {
        let fused = 0;
        if (useLanes.includes('keyword')) fused += (w.keyword ?? 0) * (kwN[doc.id] ?? 0);
        if (useLanes.includes('vector')) fused += (w.vector ?? 0) * (vecN[doc.id] ?? 0);
        if (useLanes.includes('graph')) fused += (w.graph ?? 0) * (graphN[doc.id] ?? 0);
        if (fused > 0) hits.push({ id: doc.id, score: fused });
      }
      hits.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { ok: true, hits };
    };
    const words = ['cache', 'store', 'entry', 'index', 'query', 'plan', 'notes', 'engine', 'forge', 'unit'];
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rand() * 5);
      const ids = ['d0', 'd1', 'd2', 'd3', 'd4'];
      const docs: Array<{ id: string; title: string; body: string; links?: string[] }> = [];
      for (let i = 0; i < n; i++) {
        const doc: { id: string; title: string; body: string; links?: string[] } = {
          id: ids[i % 5]!,
          title: words[Math.floor(rand() * words.length)]!,
          body: words[Math.floor(rand() * words.length)]! + ' ' + words[Math.floor(rand() * words.length)]!,
        };
        if (rand() < 0.4) doc.links = [ids[Math.floor(rand() * 5)]!];
        docs.push(doc);
      }
      const query = rand() < 0.06 ? '   ' : words[Math.floor(rand() * words.length)]! + ' ' + words[Math.floor(rand() * words.length)]!;
      let lanes: unknown;
      const roll = rand();
      if (roll < 0.2) lanes = undefined;
      else if (roll < 0.28) lanes = [];
      else if (roll < 0.34) lanes = 'keyword';
      else {
        const pool = LANES.concat(['semantic']);
        const nl = 1 + Math.floor(rand() * 3);
        const list: string[] = [];
        for (let l = 0; l < nl; l++) list.push(pool[Math.floor(rand() * pool.length)]!);
        lanes = list;
      }
      let weights: Record<string, number> | undefined;
      if (rand() >= 0.3) weights = { keyword: Math.floor(rand() * 3), vector: Math.floor(rand() * 3), graph: Math.floor(rand() * 3) };
      assert.deepEqual(hybridSearch({ docs, query, lanes, weights }), oracleHyb(docs, query, weights, lanes));
    }
  });
});

describe('result rerank engine (FORGE AI-065)', () => {
  it('removes duplicates canonically and reranks with MMR', () => {
    assert.deepEqual(
      rerank({
        candidates: [
          { key: 'Key-One  ', title: 'alpha beta', body: 'shared words here', score: 5 },
          { key: 'key-one', title: 'duplicate entry', body: 'different body', score: 9 },
          { key: 'key-two', title: 'gamma delta', body: 'other words', score: 4 },
        ],
        lambda: 0.5,
        depth: 10,
      }),
      {
        ok: true,
        removedDuplicates: 1,
        results: [
          { key: 'Key-One  ', title: 'alpha beta', body: 'shared words here', score: 5 },
          { key: 'key-two', title: 'gamma delta', body: 'other words', score: 4 },
        ],
      },
    );
    assert.deepEqual(rerank({}), { ok: false, reason: 'rerank-candidates-empty' });
    assert.deepEqual(rerank({ candidates: [] }), { ok: false, reason: 'rerank-candidates-empty' });
    assert.deepEqual(rerank({ candidates: [{ key: 'a', title: 't', body: 'b', score: 1 }], lambda: 2 }), { ok: false, reason: 'rerank-lambda-invalid' });
    assert.deepEqual(rerank({ candidates: [{ key: 'a', title: 't', body: 'b', score: 1 }], depth: 0 }), { ok: false, reason: 'rerank-depth-invalid' });
    assert.deepEqual(rerank({ candidates: [{ key: '  ', title: 't', body: 'b', score: 1 }] }), { ok: false, reason: 'rerank-key-missing' });
    assert.deepEqual(rerank({ candidates: [{ key: 'a', title: 't', body: 'b', score: 'hi' }] }), { ok: false, reason: 'rerank-score-invalid' });
    assert.deepEqual(rerank({ candidates: [{ key: 'solo', title: 't', body: 'b', score: 1 }] }), { ok: true, removedDuplicates: 0, results: [{ key: 'solo', title: 't', body: 'b', score: 1 }] });
  });

  it('sweeps randomized reranks against an independent oracle', () => {
    const rand = mulberry32(42);
    const oTok = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
    const oracleRr = (
      candidates: Array<{ key: string; title: string; body: string; score: number }>,
      lambdaIn: unknown,
      depthIn: unknown,
    ) => {
      if (candidates.length === 0) return { ok: false, reason: 'rerank-candidates-empty' };
      const lambda = lambdaIn === undefined || lambdaIn === null ? 0.5 : lambdaIn;
      if (typeof lambda !== 'number' || !Number.isFinite(lambda) || lambda < 0 || lambda > 1) return { ok: false, reason: 'rerank-lambda-invalid' };
      const depth = depthIn === undefined || depthIn === null ? 10 : depthIn;
      if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1 || depth > 50) return { ok: false, reason: 'rerank-depth-invalid' };
      const seen = new Set<string>();
      const unique: Array<{ key: string; title: string; body: string; score: number }> = [];
      let removedDuplicates = 0;
      for (const raw of candidates) {
        if (typeof raw?.key !== 'string' || raw.key.trim().toLowerCase().length === 0) return { ok: false, reason: 'rerank-key-missing' };
        if (typeof raw?.score !== 'number' || !Number.isFinite(raw.score)) return { ok: false, reason: 'rerank-score-invalid' };
        const ck = raw.key.trim().toLowerCase();
        if (seen.has(ck)) {
          removedDuplicates++;
          continue;
        }
        seen.add(ck);
        unique.push({ key: raw.key, title: raw?.title ?? '', body: raw?.body ?? '', score: raw.score });
      }
      if (unique.length === 0) return { ok: false, reason: 'rerank-candidates-empty' };
      const termSets = unique.map((cc) => new Set(oTok(cc.title + ' ' + cc.body)));
      const picked: number[] = [];
      const remaining: number[] = unique.map((_, i) => i);
      while (picked.length < Math.min(depth, unique.length) && remaining.length > 0) {
        let bestIdx = 0;
        let bestScore = -Infinity;
        for (let r = 0; r < remaining.length; r++) {
          const i = remaining[r]!;
          let margin = unique[i]!.score;
          for (const p of picked) {
            const a = termSets[i]!;
            const b = termSets[p]!;
            let inter = 0;
            for (const t of a) {
              if (b.has(t)) inter++;
            }
            const sim = a.size === 0 && b.size === 0 ? 0 : inter / (a.size + b.size - inter);
            const m = unique[i]!.score - lambda * sim;
            if (m < margin) margin = m;
          }
          if (margin > bestScore + 1e-12 || (Math.abs(margin - bestScore) <= 1e-12 && unique[i]!.key.trim().toLowerCase() < unique[remaining[bestIdx]!]!.key.trim().toLowerCase())) {
            bestScore = margin;
            bestIdx = r;
          }
        }
        picked.push(remaining[bestIdx]!);
        remaining.splice(bestIdx, 1);
      }
      return { ok: true, removedDuplicates, results: picked.map((i) => unique[i]!) };
    };
    const words = ['alpha', 'beta', 'gamma', 'delta', 'shared', 'words', 'cache', 'store'];
    const keys = ['key-a', 'KEY-A', 'key-b ', 'key-c', 'k', '  '];
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rand() * 5);
      const candidates = [];
      for (let i = 0; i < n; i++) {
        candidates.push({
          key: keys[Math.floor(rand() * keys.length)]!,
          title: words[Math.floor(rand() * words.length)]! + ' ' + words[Math.floor(rand() * words.length)]!,
          body: words[Math.floor(rand() * words.length)]!,
          score: Math.floor(rand() * 10),
        });
      }
      const lambdaRoll = rand();
      const lambda = lambdaRoll < 0.2 ? undefined : Math.floor(rand() * 13) / 10;
      const depthRoll = rand();
      const depth = depthRoll < 0.2 ? undefined : 1 + Math.floor(rand() * 51);
      assert.deepEqual(rerank({ candidates, lambda, depth }), oracleRr(candidates, lambda, depth));
    }
  });
});

describe('research mode engine (FORGE AI-066)', () => {
  it('plans over canonical steps and refuses bad plans', () => {
    assert.deepEqual(RESEARCH_STEPS, ['search', 'read', 'cross-check', 'draft']);
    assert.deepEqual(planResearch({}), { ok: false, reason: 'research-topic-missing' });
    assert.deepEqual(planResearch({ topic: '  ' }), { ok: false, reason: 'research-topic-missing' });
    assert.deepEqual(planResearch({ topic: 'cache coherence' }), { ok: true, topic: 'cache coherence', steps: ['search', 'read', 'cross-check', 'draft'], stepCount: 4 });
    assert.deepEqual(planResearch({ topic: 'x', steps: 'search' }), { ok: false, reason: 'research-steps-not-array' });
    assert.deepEqual(planResearch({ topic: 'x', steps: [] }), { ok: false, reason: 'research-steps-empty' });
    assert.deepEqual(planResearch({ topic: 'x', steps: ['search', 'draft'] }), { ok: true, topic: 'x', steps: ['search', 'draft'], stepCount: 2 });
    assert.deepEqual(planResearch({ topic: 'x', steps: ['draft', 'search'] }), { ok: false, reason: 'research-steps-out-of-order' });
    assert.deepEqual(planResearch({ topic: 'x', steps: ['search', 'search'] }), { ok: false, reason: 'research-step-duplicate:search' });
    assert.deepEqual(planResearch({ topic: 'x', steps: ['search', 'fly'] }), { ok: false, reason: 'research-step-unknown:fly' });
    assert.deepEqual(planResearch({ topic: 'x', steps: ['SEARCH', 'read'] }), { ok: true, topic: 'x', steps: ['search', 'read'], stepCount: 2 });
  });

  it('builds reports that never dedup finding sources', () => {
    assert.deepEqual(buildResearchReport({ topic: 't' }), { ok: false, reason: 'research-findings-empty' });
    assert.deepEqual(buildResearchReport({ topic: '', findings: [{ claim: 'c', sources: ['a'] }] }), { ok: false, reason: 'research-topic-missing' });
    assert.deepEqual(buildResearchReport({ topic: 't', findings: [{ claim: '  ', sources: ['a'] }] }), { ok: false, reason: 'research-claim-missing' });
    assert.deepEqual(buildResearchReport({ topic: 't', findings: [{ claim: 'c' }] }), { ok: false, reason: 'research-source-missing' });
    assert.deepEqual(buildResearchReport({ topic: 't', findings: [{ claim: 'c', sources: ['  '] }] }), { ok: false, reason: 'research-source-blank' });
    assert.deepEqual(buildResearchReport({ topic: 't', findings: [{ claim: 'c', sources: ['a'] }], openQuestions: 'why' }), { ok: false, reason: 'research-questions-not-array' });
    assert.deepEqual(buildResearchReport({ topic: 't', findings: [{ claim: 'c', sources: ['a'] }], openQuestions: [''] }), { ok: false, reason: 'research-question-blank' });
    assert.deepEqual(buildResearchReport({ topic: 't', findings: [{ claim: 'c', sources: ['s', 's'] }] }), {
      ok: true,
      topic: 't',
      summary: 'Investigation of t with 1 findings',
      findings: [{ claim: 'c', sources: ['s', 's'], verified: true }],
      verifiedCount: 1,
      unverifiedCount: 0,
      openQuestions: [],
    });
    assert.deepEqual(
      buildResearchReport({
        topic: 'cache coherence',
        findings: [
          { claim: 'verified claim', sources: ['a', 'b'] },
          { claim: 'single source claim', sources: ['c'] },
        ],
        openQuestions: [' why now? '],
      }),
      {
        ok: true,
        topic: 'cache coherence',
        summary: 'Investigation of cache coherence with 2 findings',
        findings: [
          { claim: 'verified claim', sources: ['a', 'b'], verified: true },
          { claim: 'single source claim', sources: ['c'], verified: false },
        ],
        verifiedCount: 1,
        unverifiedCount: 1,
        openQuestions: ['why now?'],
      },
    );
  });

  it('sweeps randomized research plans against an independent oracle', () => {
    const rand = mulberry32(42);
    const STEPS = ['search', 'read', 'cross-check', 'draft'];
    const oraclePlan = (topic: unknown, steps: unknown) => {
      const t = typeof topic === 'string' ? topic.trim() : '';
      if (t.length === 0) return { ok: false, reason: 'research-topic-missing' };
      let out = STEPS.slice();
      if (steps !== undefined && steps !== null) {
        if (!Array.isArray(steps)) return { ok: false, reason: 'research-steps-not-array' };
        if (steps.length === 0) return { ok: false, reason: 'research-steps-empty' };
        const seen = new Set<string>();
        for (const raw of steps) {
          const s = typeof raw === 'string' ? raw.trim().toLowerCase() : String(raw);
          if (!STEPS.includes(s)) return { ok: false, reason: 'research-step-unknown:' + s };
          if (seen.has(s)) return { ok: false, reason: 'research-step-duplicate:' + s };
          seen.add(s);
        }
        const order = (steps as string[]).map((s) => STEPS.indexOf(s.trim().toLowerCase()));
        for (let i = 1; i < order.length; i++) {
          if (order[i]! < order[i - 1]!) return { ok: false, reason: 'research-steps-out-of-order' };
        }
        out = (steps as string[]).map((s) => s.trim().toLowerCase());
      }
      return { ok: true, topic: t, steps: out, stepCount: out.length };
    };
    for (let c = 0; c < 500; c++) {
      const topicRoll = rand();
      const topic = topicRoll < 0.1 ? '' : topicRoll < 0.15 ? '  ' : 'topic ' + Math.floor(rand() * 50);
      let steps: unknown;
      const roll = rand();
      if (roll < 0.2) steps = undefined;
      else if (roll < 0.28) steps = [];
      else if (roll < 0.34) steps = 'search';
      else {
        const pool = STEPS.concat(['fly']);
        const ns = 1 + Math.floor(rand() * 4);
        const list: string[] = [];
        for (let s = 0; s < ns; s++) list.push(pool[Math.floor(rand() * pool.length)]!);
        steps = list;
      }
      assert.deepEqual(planResearch({ topic, steps }), oraclePlan(topic, steps));
    }
  });
});
