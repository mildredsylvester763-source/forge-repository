import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { migrateBuildCiSqlite } from '../src/modules/build-ci/migrations.ts';
import { SqliteWebhookDeliveryStore } from '../src/modules/build-ci/webhook-deliveries.ts';
import { WebhookIngressError, WebhookIngressService } from '../src/modules/build-ci/webhook-ingress.ts';
import {
  normalizeGitHubWebhook,
  normalizeGitLabWebhook,
  verifyGitHubWebhookSignature,
  verifyGitLabWebhookSignature,
  WebhookPayloadError,
} from '../src/modules/build-ci/webhooks.ts';

test('GitHub webhook HMAC-SHA256 verification matches the official validation vector', () => {
  const secret = "It's a Secret to Everybody";
  const body = Buffer.from('Hello, World!', 'utf8');
  const signature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
  assert.equal(verifyGitHubWebhookSignature(body, signature, secret), true);
  assert.equal(verifyGitHubWebhookSignature(body, signature, 'wrong-secret'), false);
  assert.equal(verifyGitHubWebhookSignature(Buffer.from('Hello, forged!'), signature, secret), false);
  assert.equal(verifyGitHubWebhookSignature(body, 'sha1=not-supported', secret), false);
  assert.equal(verifyGitHubWebhookSignature(body, undefined, secret), false);
});

test('GitLab Standard Webhooks signature verifies raw bytes and enforces timestamp freshness', () => {
  const key = Buffer.alloc(32, 0x42);
  const signingToken = `whsec_${key.toString('base64')}`;
  const raw = Buffer.from('{"project":{"path_with_namespace":"team/api"},"ref":"refs/heads/main"}', 'utf8');
  const id = 'delivery-123';
  const timestamp = '1000';
  const message = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), raw]);
  const signature = `v1,${createHmac('sha256', key).update(message).digest('base64')}`;
  const headers = { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,invalid ${signature}` };
  assert.equal(verifyGitLabWebhookSignature(raw, headers, signingToken, 1000), true);
  assert.equal(verifyGitLabWebhookSignature(raw, headers, signingToken, 1400), false);
  assert.equal(verifyGitLabWebhookSignature(Buffer.from('{"tampered":true}'), headers, signingToken, 1000), false);
  assert.equal(verifyGitLabWebhookSignature(raw, headers, 'not-a-signing-token', 1000), false);
  assert.equal(verifyGitLabWebhookSignature(raw, { ...headers, 'webhook-id': 'different-id' }, signingToken, 1000), false);
});

test('GitHub push normalization preserves branch, commit and changed paths', () => {
  const raw = Buffer.from(JSON.stringify({
    repository: { full_name: 'team/api' },
    ref: 'refs/heads/main',
    after: '0123456789abcdef',
    commits: [
      { added: ['src/new.ts'], modified: ['src/app.ts'], removed: ['old.txt'] },
      { modified: ['src/app.ts'] },
    ],
    sender: { login: 'maintainer' },
  }));
  const normalized = normalizeGitHubWebhook(raw, {
    'X-GitHub-Event': 'push',
    'X-GitHub-Delivery': 'gh-delivery-1',
  });
  assert.equal(normalized.provider, 'github');
  assert.equal(normalized.repository, 'team/api');
  assert.equal(normalized.event.kind, 'push');
  assert.equal(normalized.event.branch, 'main');
  assert.equal(normalized.event.commitSha, '0123456789abcdef');
  assert.deepEqual(normalized.event.changedFiles, ['src/new.ts', 'src/app.ts', 'old.txt']);
  assert.equal(normalized.event.eventId, 'gh-delivery-1');
});

test('GitHub pull request normalization uses the target branch and does not invent changed paths', () => {
  const raw = Buffer.from(JSON.stringify({
    repository: { full_name: 'team/api' },
    action: 'opened',
    number: 42,
    pull_request: {
      base: { ref: 'main' },
      head: { ref: 'feature/secure-build', sha: 'abcdef123' },
      draft: true,
    },
  }));
  const normalized = normalizeGitHubWebhook(raw, {
    'x-github-event': 'pull_request',
    'x-github-delivery': 'gh-delivery-2',
  });
  assert.equal(normalized.event.kind, 'pull_request');
  assert.equal(normalized.event.baseBranch, 'main');
  assert.equal(normalized.event.branch, 'feature/secure-build');
  assert.equal(normalized.event.pullRequestNumber, 42);
  assert.equal(normalized.event.commitSha, 'abcdef123');
  assert.equal(normalized.event.changedFiles, undefined);
});

test('GitLab push and merge-request hooks normalize into FORGE trigger events', () => {
  const push = normalizeGitLabWebhook(Buffer.from(JSON.stringify({
    project: { path_with_namespace: 'team/api' },
    ref: 'refs/heads/release',
    checkout_sha: 'deadbeef',
    commits: [{ added: ['dist/app.js'], modified: [], removed: [] }],
  })), {
    'X-Gitlab-Event': 'Push Hook',
    'Idempotency-Key': 'gl-push-1',
  });
  assert.equal(push.event.kind, 'push');
  assert.equal(push.event.branch, 'release');
  assert.deepEqual(push.event.changedFiles, ['dist/app.js']);

  const mergeRequest = normalizeGitLabWebhook(Buffer.from(JSON.stringify({
    project: { path_with_namespace: 'team/api' },
    object_attributes: {
      action: 'open',
      target_branch: 'main',
      source_branch: 'feature/cache',
      iid: 9,
      last_commit: { id: 'cafebabe' },
    },
  })), {
    'X-Gitlab-Event': 'Merge Request Hook',
    'webhook-id': 'gl-mr-9',
  });
  assert.equal(mergeRequest.event.kind, 'pull_request');
  assert.equal(mergeRequest.event.baseBranch, 'main');
  assert.equal(mergeRequest.event.branch, 'feature/cache');
  assert.equal(mergeRequest.event.pullRequestNumber, 9);
  assert.equal(mergeRequest.event.commitSha, 'cafebabe');
});

test('provider normalizers reject missing delivery identity and malformed JSON', () => {
  assert.throws(() => normalizeGitHubWebhook(Buffer.from('{}'), { 'x-github-event': 'push' }), WebhookPayloadError);
  assert.throws(() => normalizeGitLabWebhook(Buffer.from('{'), { 'x-gitlab-event': 'Push Hook', 'webhook-id': 'id' }), WebhookPayloadError);
});

test('verified webhook ingress enqueues once and rejects repository-binding mismatch', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    migrateBuildCiSqlite(db);
    const deliveries = new SqliteWebhookDeliveryStore(db);
    const secret = 'github-webhook-test-secret';
    const connection = {
      connectionId: 'connection-123',
      provider: 'github' as const,
      workspaceId: 'workspace-web',
      repository: 'team/api',
      signingSecret: secret,
      active: true,
    };
    const ingress = new WebhookIngressService({
      connections: { resolve: async () => connection },
      deliveries,
      now: () => 1_800_000_000_000,
    });
    const rawBody = Buffer.from(JSON.stringify({
      repository: { full_name: 'team/api' },
      ref: 'refs/heads/main',
      after: 'abc123',
      commits: [{ added: ['src/new.ts'], modified: [], removed: [] }],
    }));
    const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const headers = {
      'x-hub-signature-256': signature,
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-001',
    };
    const first = await ingress.ingest('github', 'connection-123', rawBody, headers);
    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.workspaceId, 'workspace-web');
    const second = await ingress.ingest('github', 'connection-123', rawBody, headers);
    assert.equal(second.duplicate, true);
    const stored = await deliveries.find('connection-123', 'delivery-001');
    assert.equal(stored?.status, 'queued');
    assert.equal(stored?.event.branch, 'main');
    assert.deepEqual(stored?.event.changedFiles, ['src/new.ts']);
    assert.equal(stored?.bodySha256.length, 64);

    const wrongBinding = new WebhookIngressService({
      connections: { resolve: async () => ({ ...connection, repository: 'team/other' }) },
      deliveries,
      now: () => 1_800_000_000_000,
    });
    await assert.rejects(() => wrongBinding.ingest('github', 'connection-123', rawBody, headers), WebhookIngressError);
    const invalidSignature = new WebhookIngressService({
      connections: { resolve: async () => connection },
      deliveries,
      now: () => 1_800_000_000_000,
    });
    await assert.rejects(() => invalidSignature.ingest('github', 'connection-123', rawBody, { ...headers, 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }), WebhookIngressError);
  } finally {
    db.close();
  }
});

test('webhook delivery claims use leases, bounded retries, and reject stale workers', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    migrateBuildCiSqlite(db);
    const store = new SqliteWebhookDeliveryStore(db);
    await store.enqueue({
      connectionId: 'lease-connection', provider: 'github', workspaceId: 'lease-workspace',
      repository: 'team/api', deliveryId: 'lease-delivery', event: {
        kind: 'push', source: 'github:push', eventType: 'push', eventId: 'lease-delivery', branch: 'main',
      }, bodySha256: 'b'.repeat(64), receivedAt: '2026-11-04T10:00:00.000Z',
    });

    const first = await store.claimNext({
      workerId: 'worker-a', now: '2026-11-04T10:01:00.000Z', leaseExpiresAt: '2026-11-04T10:02:00.000Z',
    });
    assert.equal(first?.status, 'processing');
    assert.equal(first?.attempts, 1);
    assert.equal(first?.leaseOwner, 'worker-a');

    assert.equal(await store.complete(first!.deliveryRowId, 'worker-a', '2026-11-04T10:03:00.000Z'), false);
    assert.deepEqual(await store.fail({
      deliveryRowId: first!.deliveryRowId, workerId: 'worker-a', error: 'stale worker',
      failedAt: '2026-11-04T10:03:00.000Z', retryAt: '2026-11-04T10:04:00.000Z', maxAttempts: 2,
    }), { updated: false, terminal: false });

    const recovered = await store.claimNext({
      workerId: 'worker-b', now: '2026-11-04T10:03:00.000Z', leaseExpiresAt: '2026-11-04T10:05:00.000Z',
    });
    assert.equal(recovered?.attempts, 2);
    assert.equal(recovered?.leaseOwner, 'worker-b');

    assert.deepEqual(await store.fail({
      deliveryRowId: recovered!.deliveryRowId, workerId: 'worker-b', error: 'temporary provider processing error',
      failedAt: '2026-11-04T10:03:30.000Z', retryAt: '2026-11-04T10:04:00.000Z', maxAttempts: 3,
    }), { updated: true, terminal: false });
    assert.equal(await store.claimNext({
      workerId: 'worker-c', now: '2026-11-04T10:03:59.000Z', leaseExpiresAt: '2026-11-04T10:06:00.000Z',
    }), null);

    const third = await store.claimNext({
      workerId: 'worker-c', now: '2026-11-04T10:04:00.000Z', leaseExpiresAt: '2026-11-04T10:06:00.000Z',
    });
    assert.equal(third?.attempts, 3);
    assert.deepEqual(await store.fail({
      deliveryRowId: third!.deliveryRowId, workerId: 'worker-c', error: 'permanent processing failure',
      failedAt: '2026-11-04T10:04:30.000Z', retryAt: '2026-11-04T10:05:00.000Z', maxAttempts: 3,
    }), { updated: true, terminal: true });

    const final = await store.find('lease-connection', 'lease-delivery');
    assert.equal(final?.status, 'failed');
    assert.equal(final?.attempts, 3);
    assert.equal(final?.leaseOwner, undefined);
    assert.match(final?.lastError ?? '', /permanent processing failure/);
  } finally {
    db.close();
  }
});
