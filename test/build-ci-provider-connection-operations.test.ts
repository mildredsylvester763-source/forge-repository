import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/kernel/sqlite.ts';
import { migrateBuildCiSqlite } from '../src/modules/build-ci/migrations.ts';
import { SqliteProviderConnectionStore } from '../src/modules/build-ci/provider-connections.ts';
import { ProviderConnectionOperations, ProviderConnectionNotFoundError, ProviderSecretReferenceUnavailableError } from '../src/modules/build-ci/provider-connection-operations.ts';
import { createWorkspacePipelineAuthorizer, SqliteWorkspaceMembershipReader, workspaceAccessMigrations } from '../src/modules/build-ci/workspace-access.ts';
import { BuildCiService } from '../src/modules/build-ci/store.ts';
import { SqliteBuildCiStore } from '../src/modules/build-ci/sqlite-store.ts';
import { SqlitePipelineTemplateStore } from '../src/modules/build-ci/templates.ts';
import { buildCiRoutes } from '../src/modules/build-ci/routes.ts';
import type { IdentityService } from '../src/modules/identity/identity-service.ts';
import type { RequestContext } from '../src/kernel/http.ts';

function membership(db: DatabaseSync, workspaceId: string, userId: string, role: 'owner' | 'member', at: string): void {
  db.prepare(`INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(workspaceId, userId, role, at, at);
}

test('provider connection operations are workspace-authorized, secret-safe and append-only audited', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrateBuildCiSqlite(db);
    migrate(db, 'workspace_access', workspaceAccessMigrations);
    const now = Date.parse('2026-11-04T13:00:00.000Z');
    membership(db, 'workspace-a', 'owner-a', 'owner', new Date(now).toISOString());
    membership(db, 'workspace-a', 'member-a', 'member', new Date(now).toISOString());
    membership(db, 'workspace-b', 'owner-b', 'owner', new Date(now).toISOString());
    const store = new SqliteProviderConnectionStore(db);
    const known = new Set([
      'vault://forge/workspace-a/github/first',
      'vault://forge/workspace-a/github/second',
    ]);
    const resolveCalls: string[] = [];
    const operations = new ProviderConnectionOperations({
      connections: store,
      authorize: createWorkspacePipelineAuthorizer(new SqliteWorkspaceMembershipReader(db)),
      secrets: { resolve: async (ref) => { resolveCalls.push(ref); return known.has(ref) ? 'secret-material-never-returned' : null; } },
      now: () => now,
    });

    await assert.rejects(
      () => operations.create({
        workspaceId: 'workspace-a', actorId: 'member-a', deliveryActorId: 'member-a', connectionId: 'forbidden',
        provider: 'github', repository: 'team/repo', secretRef: 'vault://forge/workspace-a/github/first',
      }),
      (error: unknown) => error instanceof Error && error.name === 'PipelineAuthorizationError',
    );
    const created = await operations.create({
      workspaceId: 'workspace-a', actorId: 'owner-a', deliveryActorId: 'member-a', connectionId: 'github-app-1',
      provider: 'github', repository: 'team/private-repo', secretRef: 'vault://forge/workspace-a/github/first',
    });
    assert.equal(created.active, true);
    assert.equal((await store.find('github', 'github-app-1'))?.actorId, 'member-a');
    assert.equal('secretRef' in created, false);
    assert.equal(JSON.stringify(created).includes('secret-material-never-returned'), false);

    const listed = await operations.list({ workspaceId: 'workspace-a', actorId: 'owner-a' });
    assert.equal(listed.length, 1);
    assert.equal('secretRef' in (listed[0] ?? {}), false);
    assert.deepEqual(await operations.list({ workspaceId: 'workspace-b', actorId: 'owner-b' }), []);

    await assert.rejects(
      () => operations.rotateSecretReference({
        workspaceId: 'workspace-a', actorId: 'owner-a', connectionId: 'github-app-1',
        provider: 'github', nextSecretRef: 'vault://forge/workspace-a/github/missing',
      }),
      (error: unknown) => error instanceof ProviderSecretReferenceUnavailableError,
    );
    const rotated = await operations.rotateSecretReference({
      workspaceId: 'workspace-a', actorId: 'owner-a', connectionId: 'github-app-1',
      provider: 'github', nextSecretRef: 'vault://forge/workspace-a/github/second',
    });
    assert.equal(rotated.updatedAt, new Date(now).toISOString());
    assert.equal('secretRef' in rotated, false);
    assert.equal((await store.find('github', 'github-app-1'))?.secretRef, 'vault://forge/workspace-a/github/second');

    const revoked = await operations.revoke({
      workspaceId: 'workspace-a', actorId: 'owner-a', connectionId: 'github-app-1', provider: 'github',
    });
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.connection.active, false);
    assert.equal((await operations.revoke({
      workspaceId: 'workspace-a', actorId: 'owner-a', connectionId: 'github-app-1', provider: 'github',
    })).revoked, false);

    const events = await operations.listEvents({
      workspaceId: 'workspace-a', actorId: 'owner-a', connectionId: 'github-app-1', provider: 'github',
    });
    assert.deepEqual(events.map((event) => event.eventType), ['created', 'secret_reference_rotated', 'revoked']);
    assert.equal(events.every((event) => event.actorId === 'owner-a'), true);
    assert.equal((await store.find('github', 'github-app-1'))?.actorId, 'member-a');
    assert.deepEqual(events[1]?.metadata, { secretReferenceChanged: true });
    assert.equal(JSON.stringify(events).includes('vault://'), false, 'audit metadata must not disclose secret references');
    assert.throws(
      () => db.prepare(`UPDATE build_ci_provider_connection_events SET actor_id = 'tampered' WHERE connection_id = ?`).run('github-app-1'),
      /append-only/,
    );
    assert.throws(
      () => db.prepare(`DELETE FROM build_ci_provider_connection_events WHERE connection_id = ?`).run('github-app-1'),
      /append-only/,
    );
    await assert.rejects(
      () => operations.listEvents({
        workspaceId: 'workspace-b', actorId: 'owner-b', connectionId: 'github-app-1', provider: 'github',
      }),
      (error: unknown) => error instanceof ProviderConnectionNotFoundError,
    );
    assert.equal(resolveCalls.length, 3);
  } finally {
    db.close();
  }
});

function providerRouteContext(input: { method: 'GET' | 'POST'; token?: string; query?: Record<string, string>; body?: Record<string, unknown> }): RequestContext {
  return {
    requestId: 'provider-route-test', ip: '127.0.0.1', userAgent: 'test', method: input.method,
    path: '/v1/build-ci/provider-connections', query: (name) => input.query?.[name], header: () => undefined,
    cookie: (name) => name === 'forge_session' ? input.token : undefined,
    json: async () => input.body ?? {},
  };
}

test('provider connection HTTP routes require an authorized session and never disclose secret references', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrateBuildCiSqlite(db);
    migrate(db, 'workspace_access', workspaceAccessMigrations);
    const at = '2026-11-04T14:00:00.000Z';
    membership(db, 'workspace-route', 'route-owner', 'owner', at);
    membership(db, 'workspace-route', 'route-member', 'member', at);
    const authorize = createWorkspacePipelineAuthorizer(new SqliteWorkspaceMembershipReader(db));
    const connections = new SqliteProviderConnectionStore(db);
    const operations = new ProviderConnectionOperations({
      connections,
      authorize,
      secrets: { resolve: async (ref) => ref === 'vault://forge/workspace-route/github/secret' || ref === 'vault://forge/workspace-route/github/secret-v2' ? 'never-return-this-secret' : null },
      now: () => Date.parse(at),
    });
    const identity = {
      authenticate: async (token?: string) => {
        const users: Record<string, string> = { owner: 'route-owner', member: 'route-member' };
        const userId = token ? users[token] : undefined;
        return userId ? { user: { id: userId }, sessionExpiresAt: Date.now() + 60_000 } : null;
      },
    } as unknown as IdentityService;
    const buildCi = new BuildCiService({
      store: new SqliteBuildCiStore(db),
      templates: new SqlitePipelineTemplateStore(db),
      authorize,
    });
    const routes = buildCiRoutes(buildCi, identity, { name: 'forge_session' }, () => Date.parse(at), undefined, undefined, operations);
    const createRoute = routes['/v1/build-ci/provider-connections']?.POST;
    const listRoute = routes['/v1/build-ci/provider-connections']?.GET;
    const rotateRoute = routes['/v1/build-ci/provider-connections/rotate-secret-reference']?.POST;
    const revokeRoute = routes['/v1/build-ci/provider-connections/revoke']?.POST;
    const eventsRoute = routes['/v1/build-ci/provider-connections/events']?.GET;
    assert.ok(createRoute && listRoute && rotateRoute && revokeRoute && eventsRoute);
    const unauthenticated = await createRoute(providerRouteContext({
      method: 'POST', body: { workspaceId: 'workspace-route', connectionId: 'x', provider: 'github', deliveryActorId: 'route-owner',
        repository: 'team/repo', secretRef: 'vault://forge/workspace-route/github/secret' },
    })).catch((error: unknown) => error);
    assert.ok(unauthenticated instanceof Error && unauthenticated.name === 'AppError');

    const denied = await createRoute(providerRouteContext({
      method: 'POST', token: 'member', body: { workspaceId: 'workspace-route', connectionId: 'x', provider: 'github', deliveryActorId: 'route-owner',
        repository: 'team/repo', secretRef: 'vault://forge/workspace-route/github/secret' },
    })).catch((error: unknown) => error);
    assert.ok(denied instanceof Error && denied.name === 'AppError');

    const created = await createRoute(providerRouteContext({
      method: 'POST', token: 'owner', body: { workspaceId: 'workspace-route', connectionId: 'route-connection',
        provider: 'github', deliveryActorId: 'route-member', repository: 'team/private-repo', secretRef: 'vault://forge/workspace-route/github/secret' },
    }));
    assert.equal(created.status, 201);
    assert.equal(JSON.stringify(created.body).includes('vault://'), false);
    assert.equal(JSON.stringify(created.body).includes('never-return-this-secret'), false);

    const listed = await listRoute(providerRouteContext({ method: 'GET', token: 'owner', query: { workspaceId: 'workspace-route' } }));
    assert.equal((listed.body as { connections: unknown[] }).connections.length, 1);
    assert.equal(JSON.stringify(listed.body).includes('secretRef'), false);

    const rotated = await rotateRoute(providerRouteContext({
      method: 'POST', token: 'owner', body: { workspaceId: 'workspace-route', connectionId: 'route-connection',
        provider: 'github', nextSecretRef: 'vault://forge/workspace-route/github/secret-v2' },
    }));
    assert.equal(rotated.status, 200);
    assert.equal(JSON.stringify(rotated.body).includes('secretRef'), false);

    const history = await eventsRoute(providerRouteContext({
      method: 'GET', token: 'owner', query: { workspaceId: 'workspace-route', connectionId: 'route-connection', provider: 'github' },
    }));
    assert.deepEqual((history.body as { events: { eventType: string }[] }).events.map((event) => event.eventType),
      ['created', 'secret_reference_rotated']);

    const revoked = await revokeRoute(providerRouteContext({
      method: 'POST', token: 'owner', body: { workspaceId: 'workspace-route', connectionId: 'route-connection', provider: 'github' },
    }));
    assert.equal((revoked.body as { revoked: boolean }).revoked, true);
  } finally {
    db.close();
  }
});
