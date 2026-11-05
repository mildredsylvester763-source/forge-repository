import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProviderPullRequestChangedFilesResolver,
  type ProviderApiTransport,
  type ProviderApiTransportResolver,
} from '../src/modules/build-ci/changed-files.ts';

function makeResolver(transport: ProviderApiTransport, calls: { input?: unknown }[] = []) {
  const resolver: ProviderApiTransportResolver = {
    resolve: async (input) => {
      calls.push({ input });
      return transport;
    },
  };
  return new ProviderPullRequestChangedFilesResolver(resolver);
}

const githubInput = {
  connectionId: 'github-connection',
  provider: 'github' as const,
  workspaceId: 'workspace-a',
  repository: 'team/api',
  pullRequestNumber: 42,
};

test('GitHub pull-request file adapter follows Link pagination and returns deterministic paths', async () => {
  const requests: { path: string; query: Readonly<Record<string, string>> }[] = [];
  const transport: ProviderApiTransport = {
    get: async (path, query) => {
      requests.push({ path, query });
      if (query.page === '1') {
        return {
          status: 200,
          headers: { Link: '<https://api.github.com/repos/team/api/pulls/42/files?per_page=100&page=2>; rel="next"' },
          body: [{ filename: 'z.ts' }, { filename: 'src/app.ts' }],
        };
      }
      return { status: 200, headers: {}, body: [{ filename: 'a.ts' }] };
    },
  };
  const result = await makeResolver(transport).resolve(githubInput);
  assert.deepEqual(requests.map((item) => item.query.page), ['1', '2']);
  assert.equal(requests[0]?.path, '/repos/team/api/pulls/42/files');
  assert.equal(requests[0]?.query.per_page, '100');
  assert.deepEqual(result.paths, ['a.ts', 'src/app.ts', 'z.ts']);
  assert.equal(result.complete, true);
});

test('GitLab merge-request adapter includes both rename paths and follows X-Next-Page', async () => {
  const requests: string[] = [];
  const transport: ProviderApiTransport = {
    get: async (_path, query) => {
      requests.push(query.page!);
      if (query.page === '1') {
        return {
          status: 200,
          headers: { 'x-next-page': '2' },
          body: [{ old_path: 'src/old.ts', new_path: 'src/new.ts', renamed_file: true, collapsed: false, too_large: false }],
        };
      }
      return { status: 200, headers: { 'x-next-page': '' }, body: [{ old_path: 'README.md', new_path: 'README.md', collapsed: false, too_large: false }] };
    },
  };
  const result = await makeResolver(transport).resolve({
    ...githubInput,
    connectionId: 'gitlab-connection',
    provider: 'gitlab',
    repository: 'group/subgroup/project',
    pullRequestNumber: 9,
  });
  assert.deepEqual(requests, ['1', '2']);
  assert.deepEqual(result.paths, ['README.md', 'src/new.ts', 'src/old.ts']);
  assert.equal(result.complete, true);
});

test('provider diff limits never present a partial file list as complete', async () => {
  const transport: ProviderApiTransport = {
    get: async () => ({
      status: 200,
      headers: {},
      body: [{ old_path: 'src/old.ts', new_path: 'src/new.ts', collapsed: true, too_large: false }],
    }),
  };
  const result = await makeResolver(transport).resolve({
    ...githubInput,
    provider: 'gitlab',
  });
  assert.deepEqual(result.paths, ['src/new.ts', 'src/old.ts']);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'incomplete_diff');
});

test('provider API failures return an explicit incomplete result without exposing exception text', async () => {
  const transport: ProviderApiTransport = {
    get: async () => { throw new Error('sensitive upstream request material'); },
  };
  const result = await makeResolver(transport).resolve(githubInput);
  assert.deepEqual(result.paths, []);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'provider_error');
  assert.equal(JSON.stringify(result).includes('sensitive upstream'), false);
});

test('missing or unavailable provider API connection degrades instead of suppressing a build', async () => {
  const resolver = new ProviderPullRequestChangedFilesResolver({
    resolve: async () => null,
  });
  const result = await resolver.resolve(githubInput);
  assert.deepEqual(result.paths, []);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'connection_unavailable');
});

test('provider path adapter rejects malformed repository identities before making API calls', async () => {
  let calls = 0;
  const resolver = new ProviderPullRequestChangedFilesResolver({
    resolve: async () => {
      calls += 1;
      return { get: async () => ({ status: 200, headers: {}, body: [] }) };
    },
  });
  await assert.rejects(() => resolver.resolve({ ...githubInput, repository: 'team/../api' }), /repository/);
  await assert.rejects(() => resolver.resolve({ ...githubInput, provider: 'gitlab', repository: 'team//api' }), /repository/);
  assert.equal(calls, 0);
});


test('GitHub adapter probes the next page when a full page arrives without pagination headers', async () => {
  const pages: string[] = [];
  const transport: ProviderApiTransport = {
    get: async (_path, query) => {
      pages.push(query.page!);
      return query.page === '1'
        ? { status: 200, headers: {}, body: Array.from({ length: 100 }, (_, index) => ({ filename: `src/file-${index}.ts` })) }
        : { status: 200, headers: {}, body: [] };
    },
  };
  const result = await makeResolver(transport).resolve(githubInput);
  assert.deepEqual(pages, ['1', '2']);
  assert.equal(result.paths.length, 100);
  assert.equal(result.complete, true);
});

test('provider adapter reports incomplete data when pagination exceeds its configured page budget', async () => {
  const transport: ProviderApiTransport = {
    get: async () => ({
      status: 200,
      headers: { Link: '<https://api.github.com/repos/team/api/pulls/42/files?page=2>; rel="next"' },
      body: Array.from({ length: 100 }, (_, index) => ({ filename: `src/file-${index}.ts` })),
    }),
  };
  const resolver = new ProviderPullRequestChangedFilesResolver({
    resolve: async () => transport,
  }, { maxPages: 1 });
  const result = await resolver.resolve(githubInput);
  assert.equal(result.paths.length, 100);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'provider_limit');
});
