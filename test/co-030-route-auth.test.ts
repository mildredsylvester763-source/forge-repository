import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createHttpHandler, type RouteTable } from '../src/kernel/http.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { identityRoutes } from '../src/modules/identity/routes.ts';
import type { IdentityService } from '../src/modules/identity/identity-service.ts';
import { taskRuntimeRoutes } from '../src/modules/task-runtime/routes.ts';
import type { TaskRuntimeService } from '../src/modules/task-runtime/task-runtime-service.ts';
import { orchestratorRoutes } from '../src/modules/orchestrator/routes.ts';
import type { OrchestratorService } from '../src/modules/orchestrator/orchestrator-service.ts';
import { workspaceRetrievalRoutes } from '../src/modules/workspace-retrieval/routes.ts';
import type { WorkspaceRetrievalService } from '../src/modules/workspace-retrieval/workspace-retrieval-service.ts';
import { webSearchRoutes } from '../src/modules/web-search/routes.ts';
import type { WebSearchService } from '../src/modules/web-search/web-search-service.ts';
import { searchIntegrityRoutes } from '../src/modules/search-integrity/routes.ts';
import type { SearchIntegrityService } from '../src/modules/search-integrity/search-integrity-service.ts';

const COOKIE_NAME = 'forge_session';
const identity = { authenticate: async () => null } as unknown as IdentityService;

function coreRoutes(): RouteTable {
  const cookie = { name: COOKIE_NAME };
  return {
    ...identityRoutes(identity, { name: COOKIE_NAME, secure: false }, () => 0),
    ...taskRuntimeRoutes({} as TaskRuntimeService, identity, cookie),
    ...orchestratorRoutes({} as OrchestratorService, identity, cookie),
    ...workspaceRetrievalRoutes({} as WorkspaceRetrievalService, identity, cookie),
    ...webSearchRoutes({} as WebSearchService, identity, cookie),
    ...searchIntegrityRoutes({} as SearchIntegrityService, identity, cookie),
  };
}

async function serve(routes: RouteTable) {
  const handler = createHttpHandler({
    routes,
    logger: silentLogger,
    allowedOrigins: [],
    trustProxyHops: 0,
    hsts: false,
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

describe('CO-030 server-side authentication enforcement', () => {
  it('rejects unauthenticated requests at every protected Core route before service execution', async () => {
    const routes = coreRoutes();
    const requests: Array<{ path: string; method: 'GET' | 'POST' }> = [
      { path: '/v1/auth/me', method: 'GET' },
    ];
    const publicIdentityPaths = new Set(['/v1/auth/register', '/v1/auth/sign-in', '/v1/auth/sign-out']);

    for (const [path, handlers] of Object.entries(routes)) {
      if (publicIdentityPaths.has(path) || path === '/v1/auth/me') continue;
      for (const method of ['GET', 'POST'] as const) {
        if (handlers[method]) requests.push({ path, method });
      }
    }

    assert.ok(requests.length >= 60, 'the route audit should cover the current Core endpoint inventory');
    const api = await serve(routes);
    try {
      for (const request of requests) {
        const response = await fetch(api.baseUrl + request.path, {
          method: request.method,
          ...(request.method === 'POST'
            ? { headers: { 'content-type': 'application/json' }, body: '{}' }
            : {}),
        });
        assert.equal(response.status, 401, `${request.method} ${request.path} must require an authenticated session`);
        const body = await response.json() as { error?: { code?: string } };
        assert.equal(body.error?.code, 'unauthenticated', `${request.method} ${request.path} must use the standard auth failure`);
      }
    } finally {
      await api.close();
    }
  });
});
