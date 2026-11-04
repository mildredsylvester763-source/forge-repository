import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, type Database } from '../src/kernel/sqlite.ts';
import { migrateBuildCiSqlite } from '../src/modules/build-ci/migrations.ts';
import { BuildCiService } from '../src/modules/build-ci/store.ts';
import { SqliteBuildCiStore } from '../src/modules/build-ci/sqlite-store.ts';
import { SqlitePipelineTemplateStore } from '../src/modules/build-ci/templates.ts';
import { SqliteWebhookDeliveryStore } from '../src/modules/build-ci/webhook-deliveries.ts';
import { WebhookDeliveryOperations } from '../src/modules/build-ci/webhook-operations.ts';
import { buildCiRoutes } from '../src/modules/build-ci/routes.ts';
import { createWorkspacePipelineAuthorizer, SqliteWorkspaceMembershipReader, workspaceAccessMigrations } from '../src/modules/build-ci/workspace-access.ts';
import type { IdentityService } from '../src/modules/identity/identity-service.ts';
import type { RequestContext } from '../src/kernel/http.ts';

function requestContext(input: {
  method: 'GET' | 'POST'; token?: string; query?: Record<string, string>; body?: Record<string, unknown>;
}): RequestContext {
  return {
    requestId: 'webhook-operations-test',
    ip: '127.0.0.1',
    userAgent: 'test',
    method: input.method,
    path: '/v1/build-ci/webhooks/dead-letters',
    query: (name) => input.query?.[name],
    header: () => undefined,
    cookie: (name) => name === 'forge_session' ? input.token : undefined,
    json: async () => input.body ?? {},
  };
}

function addMembership(db: Database, workspaceId: string, userId: string, role: 'owner' | 'member', at: string): void {
  db.prepare(`INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(workspaceId, userId, role, at, at);
}

async function createFailedDelivery(
  store: SqliteWebhookDeliveryStore,
  deliveryId: string,
  receivedAt: string,
): Promise<string> {
  await store.enqueue({
    connectionId: 'provider-connection-ops',
    provider: 'github',
    workspaceId: 'workspace-ops',
    repository: 'team/ops',
    deliveryId,
    event: { kind: 'push', source: 'github:push', eventType: 'push', eventId: deliveryId, branch: 'main' },
    bodySha256: 'e'.repeat(64),
    receivedAt,
  });
  const failedAt = new Date(Date.parse(receivedAt) + 10_000).toISOString();
  const claimed = await store.claimNext({
    workerId: 'dead-letter-test-worker',
    now: failedAt,
    leaseExpiresAt: new Date(Date.parse(failedAt) + 60_000).toISOString(),
  });
  assert.ok(claimed);
  const failed = await store.fail({
    deliveryRowId: claimed.deliveryRowId,
    workerId: 'dead-letter-test-worker',
    error: 'provider failed with credential ghp_SHOULD_NEVER_BE_STORED',
    failedAt,
    retryAt: new Date(Date.parse(failedAt) + 60_000).toISOString(),
    maxAttempts: 1,
  });
  assert.deepEqual(failed, { updated: true, terminal: true });
  return claimed.deliveryRowId;
}

test('webhook dead letters are workspace-scoped, paginated, role-gated and replay-audited', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrateBuildCiSqlite(db);
    migrate(db, 'workspace_access', workspaceAccessMigrations);
    addMembership(db, 'workspace-ops', 'workspace-owner', 'owner', '2026-11-04T10:00:00.000Z');
    addMembership(db, 'workspace-ops', 'workspace-member', 'member', '2026-11-04T10:00:00.000Z');
    addMembership(db, 'workspace-other', 'other-owner', 'owner', '2026-11-04T10:00:00.000Z');

    const deliveries = new SqliteWebhookDeliveryStore(db);
    const firstId = await createFailedDelivery(deliveries, 'dead-letter-1', '2026-11-04T10:00:00.000Z');
    const secondId = await createFailedDelivery(deliveries, 'dead-letter-2', '2026-11-04T10:01:00.000Z');
    const thirdId = await createFailedDelivery(deliveries, 'dead-letter-3', '2026-11-04T10:02:00.000Z');
    const authorize = createWorkspacePipelineAuthorizer(new SqliteWorkspaceMembershipReader(db));
    const operations = new WebhookDeliveryOperations({
      deliveries,
      authorize,
      now: () => Date.parse('2026-11-04T11:00:00.000Z'),
    });

    const page1 = await operations.listDeadLetters({ workspaceId: 'workspace-ops', actorId: 'workspace-owner', limit: 2 });
    assert.deepEqual(page1.items.map((item) => item.deliveryRowId), [thirdId, secondId]);
    assert.ok(page1.nextCursor);
    const page2 = await operations.listDeadLetters({
      workspaceId: 'workspace-ops', actorId: 'workspace-owner', limit: 2, before: page1.nextCursor,
    });
    assert.deepEqual(page2.items.map((item) => item.deliveryRowId), [firstId]);
    assert.equal(page2.nextCursor, undefined);
    assert.equal(page1.items.every((item) => item.lastError === 'Webhook delivery processing failed.'), true);
    assert.deepEqual((await operations.listDeadLetters({ workspaceId: 'workspace-other', actorId: 'other-owner' })).items, []);

    await assert.rejects(
      () => operations.replayFailed({ workspaceId: 'workspace-ops', deliveryRowId: firstId, actorId: 'workspace-member' }),
      (error: unknown) => error instanceof Error && error.name === 'PipelineAuthorizationError',
    );
    assert.equal((await deliveries.find('provider-connection-ops', 'dead-letter-1'))?.status, 'failed');

    const replay = await operations.replayFailed({ workspaceId: 'workspace-ops', deliveryRowId: firstId, actorId: 'workspace-owner' });
    assert.deepEqual(replay, { replayed: true, previousAttempts: 1 });
    const requeued = await deliveries.find('provider-connection-ops', 'dead-letter-1');
    assert.equal(requeued?.status, 'queued');
    assert.equal(requeued?.attempts, 0);
    assert.equal(requeued?.lastError, undefined);
    assert.equal(requeued?.leaseOwner, undefined);
    assert.equal(requeued?.nextAttemptAt, undefined);
    assert.deepEqual(await operations.replayFailed({ workspaceId: 'workspace-ops', deliveryRowId: firstId, actorId: 'workspace-owner' }), { replayed: false });

    const events = await operations.listReplayEvents({ workspaceId: 'workspace-ops', deliveryRowId: firstId, actorId: 'workspace-member' });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actorId, 'workspace-owner');
    assert.equal(events[0]?.eventType, 'replayed');
    assert.deepEqual(events[0]?.metadata, { previousAttempts: 1 });
    assert.equal((await operations.listDeadLetters({ workspaceId: 'workspace-ops', actorId: 'workspace-owner' })).items.some((item) => item.deliveryRowId === firstId), false);
    assert.throws(
      () => db.prepare(`UPDATE build_ci_webhook_delivery_events SET actor_id = 'tampered' WHERE delivery_row_id = ?`).run(firstId),
      /append-only/,
    );

    const identity = {
      authenticate: async (token?: string) => {
        const users: Record<string, string> = { owner: 'workspace-owner', member: 'workspace-member', outsider: 'other-owner' };
        const userId = token ? users[token] : undefined;
        return userId ? { user: { id: userId }, sessionExpiresAt: Date.now() + 60_000 } : null;
      },
    } as unknown as IdentityService;
    const buildCi = new BuildCiService({
      store: new SqliteBuildCiStore(db),
      templates: new SqlitePipelineTemplateStore(db),
      authorize,
    });
    const routes = buildCiRoutes(buildCi, identity, { name: 'forge_session' }, () => Date.parse('2026-11-04T11:00:00.000Z'), undefined, operations);
    const listRoute = routes['/v1/build-ci/webhooks/dead-letters']?.GET;
    const eventsRoute = routes['/v1/build-ci/webhooks/dead-letters/events']?.GET;
    const replayRoute = routes['/v1/build-ci/webhooks/dead-letters/replay']?.POST;
    assert.ok(listRoute && eventsRoute && replayRoute);
    const httpList = await listRoute(requestContext({ method: 'GET', token: 'owner', query: { workspaceId: 'workspace-ops', limit: '1' } }));
    assert.equal(httpList.status, 200);
    const listedItem = (httpList.body as { items: Record<string, unknown>[] }).items[0];
    assert.ok(listedItem);
    assert.equal('event' in listedItem, false, 'dead-letter list must not expose the stored webhook payload');
    assert.equal('bodySha256' in listedItem, false, 'dead-letter list must not expose payload fingerprints');
    const denied = await replayRoute(requestContext({
      method: 'POST', token: 'member', body: { workspaceId: 'workspace-ops', deliveryRowId: secondId },
    })).catch((error: unknown) => error);
    assert.ok(denied instanceof Error && denied.name === 'AppError');
    const httpReplay = await replayRoute(requestContext({
      method: 'POST', token: 'owner', body: { workspaceId: 'workspace-ops', deliveryRowId: secondId },
    }));
    assert.equal(httpReplay.status, 202);
    const httpEvents = await eventsRoute(requestContext({
      method: 'GET', token: 'member', query: { workspaceId: 'workspace-ops', deliveryRowId: secondId },
    }));
    assert.equal((httpEvents.body as { events: unknown[] }).events.length, 1);
  } finally {
    db.close();
  }
});
