import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/kernel/errors.ts';
import type { RequestContext } from '../src/kernel/http.ts';
import { offlineSyncRoutes } from '../src/modules/offline-sync/index.ts';

const TOKEN = 'A'.repeat(43);
const user = { id: 'owner-1' };

function context(body: Record<string, unknown> = {}, token: string | undefined = TOKEN): RequestContext {
  return {
    requestId: 'req-1',
    ip: '127.0.0.1',
    userAgent: 'co-100-test',
    method: 'POST',
    path: '/',
    header: (name) => name.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined,
    cookie: () => undefined,
    json: async () => body,
  };
}

function setup(authenticated = true) {
  const calls: unknown[][] = [];
  const service = {
    apply: async (ownerId: string, input: unknown) => {
      calls.push(['apply', ownerId, input]);
      return { operationId: 'op-1', status: 'applied', duplicate: false, appliedVersion: 1, entity: null, conflict: null };
    },
    getEntity: async (ownerId: string, entityType: string, entityId: string) => {
      calls.push(['getEntity', ownerId, entityType, entityId]);
      return null;
    },
    listOpenConflicts: async (ownerId: string) => {
      calls.push(['listOpenConflicts', ownerId]);
      return [];
    },
    resolveConflict: async (ownerId: string, id: string, resolution: string, by: string) => {
      calls.push(['resolveConflict', ownerId, id, resolution, by]);
      return { duplicate: false, conflict: {}, entity: null };
    },
  };
  const identity = {
    authenticate: async (token: string | undefined) => {
      calls.push(['authenticate', token]);
      return authenticated && token === TOKEN ? { user } : null;
    },
  };
  const routes = offlineSyncRoutes(
    service as unknown as Parameters<typeof offlineSyncRoutes>[0],
    identity as unknown as Parameters<typeof offlineSyncRoutes>[1],
    { name: 'forge_session' },
  );
  return { calls, routes };
}

function handler(routes: ReturnType<typeof offlineSyncRoutes>, path: string, method: 'GET' | 'POST') {
  const result = routes[path]?.[method];
  assert.ok(result, `missing route ${method} ${path}`);
  return result;
}

describe('CO-100 authenticated HTTP route boundary', () => {
  it('rejects anonymous writes before reaching the sync service', async () => {
    const setupResult = setup(false);
    await assert.rejects(handler(setupResult.routes, '/v1/sync/operations', 'POST')(context({})), (error: unknown) =>
      error instanceof AppError && error.status === 401,
    );
    assert.equal(setupResult.calls.filter((call) => call[0] === 'apply').length, 0);
  });

  it('derives the owner from the authenticated session and rejects caller-selected owner IDs', async () => {
    const setupResult = setup();
    const input = {
      clientId: 'desktop',
      sequence: 1,
      entityType: 'workspace_file',
      entityId: 'file-1',
      baseVersion: 0,
      kind: 'put',
      payload: { body: 'first' },
      causalClock: { desktop: 1 },
    };
    const result = await handler(setupResult.routes, '/v1/sync/operations', 'POST')(context(input));
    assert.equal(result.status, 200);
    assert.equal(setupResult.calls.find((call) => call[0] === 'apply')?.[1], 'owner-1');
    await assert.rejects(
      handler(setupResult.routes, '/v1/sync/operations', 'POST')(context({ ...input, ownerId: 'victim' })),
      (error: unknown) => error instanceof AppError && error.status === 400,
    );
  });

  it('scopes entity reads and conflict listing to the authenticated owner', async () => {
    const setupResult = setup();
    await handler(setupResult.routes, '/v1/sync/entities/get', 'POST')(
      context({ entityType: 'workspace_file', entityId: 'file-1' }),
    );
    await handler(setupResult.routes, '/v1/sync/conflicts', 'GET')(context());
    assert.deepEqual(
      setupResult.calls.find((call) => call[0] === 'getEntity'),
      ['getEntity', 'owner-1', 'workspace_file', 'file-1'],
    );
    assert.deepEqual(
      setupResult.calls.find((call) => call[0] === 'listOpenConflicts'),
      ['listOpenConflicts', 'owner-1'],
    );
  });

  it('uses the authenticated user as conflict resolver and rejects resolver spoofing', async () => {
    const setupResult = setup();
    await handler(setupResult.routes, '/v1/sync/conflicts/resolve', 'POST')(
      context({ conflictId: 'conflict-1', resolution: 'keep_current' }),
    );
    assert.deepEqual(
      setupResult.calls.find((call) => call[0] === 'resolveConflict'),
      ['resolveConflict', 'owner-1', 'conflict-1', 'keep_current', 'owner-1'],
    );
    await assert.rejects(
      handler(setupResult.routes, '/v1/sync/conflicts/resolve', 'POST')(
        context({ conflictId: 'conflict-1', resolution: 'keep_current', resolvedBy: 'other' }),
      ),
      (error: unknown) => error instanceof AppError && error.status === 400,
    );
  });

  it('maps operation replay errors to 409 rather than leaking a 500', async () => {
    const service = {
      apply: async () => {
        const error = new Error('This client sequence was already used for a different operation.');
        error.name = 'OfflineSyncError';
        Object.assign(error, { code: 'operation_sequence_reused' });
        throw error;
      },
    };
    const routes = offlineSyncRoutes(
      service as unknown as Parameters<typeof offlineSyncRoutes>[0],
      { authenticate: async () => ({ user }) },
      { name: 'forge_session' },
    );
    await assert.rejects(
      handler(routes, '/v1/sync/operations', 'POST')(context({})),
      (error: unknown) => error instanceof AppError && error.status === 409 && error.code === 'operation_sequence_reused',
    );
  });
});
