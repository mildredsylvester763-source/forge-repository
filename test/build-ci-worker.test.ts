import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildCiWorkerHost } from '../src/modules/build-ci/worker.ts';
import { silentLogger } from '../src/kernel/logger.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('worker drains a bounded webhook batch and stops when no due delivery is claimable', async () => {
  let calls = 0;
  const worker = new BuildCiWorkerHost({
    workerId: 'worker-test',
    logger: silentLogger,
    maxWebhookDeliveriesPerCycle: 4,
    webhooks: {
      processNext: async () => {
        calls += 1;
        return calls <= 2
          ? { claimed: true, processed: true }
          : { claimed: false, processed: false };
      },
    },
  });

  const result = await worker.runOnce();
  assert.equal(calls, 3);
  assert.equal(result.webhookClaims, 2);
  assert.equal(result.webhookProcessed, 2);
  assert.equal(result.errors, 0);
});

test('worker scans trusted workspace inventory and dispatches a bounded schedule batch per workspace', async () => {
  const processedActors: string[] = [];
  let dispatchCalls = 0;
  const worker = new BuildCiWorkerHost({
    workerId: 'schedule-worker',
    logger: silentLogger,
    maxScheduleDispatchesPerWorkspace: 3,
    schedules: {
      scanWorkspace: async (workspaceId) => ({
        scanned: true,
        from: '2026-11-04T10:00:00.000Z',
        through: '2026-11-04T10:01:00.000Z',
        occurrencesFound: workspaceId === 'workspace-a' ? 2 : 0,
        inserted: workspaceId === 'workspace-a' ? 2 : 0,
      }),
      processNext: async ({ workspaceId, actorId }) => {
        processedActors.push(workspaceId + ':' + actorId);
        dispatchCalls += 1;
        return dispatchCalls <= 2
          ? { claimed: true, dispatched: true }
          : { claimed: false, dispatched: false };
      },
    },
    scheduleWorkspaces: {
      listWorkspaces: async () => ({
        workspaces: [
          { workspaceId: 'workspace-a', actorId: 'service-a' },
          { workspaceId: 'workspace-b', actorId: 'service-b' },
        ],
      }),
    },
  });

  const result = await worker.runOnce();
  assert.equal(result.scheduleWorkspacesScanned, 2);
  assert.equal(result.scheduleOccurrencesFound, 2);
  assert.equal(result.scheduleOccurrencesInserted, 2);
  assert.equal(result.scheduleClaims, 2);
  assert.equal(result.scheduleDispatched, 2);
  assert.deepEqual(processedActors, [
    'workspace-a:service-a',
    'workspace-a:service-a',
    'workspace-a:service-a',
    'workspace-b:service-b',
  ]);
});

test('worker paginates the trusted workspace inventory between polling cycles', async () => {
  const cursors: Array<string | undefined> = [];
  const scanned: string[] = [];
  const worker = new BuildCiWorkerHost({
    workerId: 'paged-schedule-worker',
    logger: silentLogger,
    schedules: {
      scanWorkspace: async (workspaceId) => {
        scanned.push(workspaceId);
        return { scanned: true, occurrencesFound: 0, inserted: 0 };
      },
      processNext: async () => ({ claimed: false, dispatched: false }),
    },
    scheduleWorkspaces: {
      listWorkspaces: async ({ cursor }) => {
        cursors.push(cursor);
        return cursor === undefined
          ? { workspaces: [{ workspaceId: 'workspace-a', actorId: 'service-a' }], nextCursor: 'page-2' }
          : { workspaces: [{ workspaceId: 'workspace-b', actorId: 'service-b' }], nextCursor: null };
      },
    },
  });

  await worker.runOnce();
  await worker.runOnce();
  assert.deepEqual(cursors, [undefined, 'page-2']);
  assert.deepEqual(scanned, ['workspace-a', 'workspace-b']);
});

test('concurrent runOnce calls share one in-flight cycle', async () => {
  const entered = deferred<void>();
  const release = deferred<{ claimed: boolean; processed: boolean }>();
  const worker = new BuildCiWorkerHost({
    workerId: 'single-flight-worker',
    logger: silentLogger,
    webhooks: {
      processNext: async () => {
        entered.resolve(undefined);
        return release.promise;
      },
    },
  });

  const first = worker.runOnce();
  await entered.promise;
  const second = worker.runOnce();
  assert.equal(first, second);
  release.resolve({ claimed: false, processed: false });
  await first;
});

test('stop waits for an in-flight worker operation and prevents another poll cycle', async () => {
  const entered = deferred<void>();
  const release = deferred<{ claimed: boolean; processed: boolean }>();
  let calls = 0;
  const worker = new BuildCiWorkerHost({
    workerId: 'shutdown-worker',
    logger: silentLogger,
    pollIntervalMs: 100,
    webhooks: {
      processNext: async () => {
        calls += 1;
        entered.resolve(undefined);
        return release.promise;
      },
    },
  });

  worker.start();
  await entered.promise;
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release.resolve({ claimed: false, processed: false });
  await stopping;
  assert.equal(stopped, true);
  assert.equal(calls, 1);
});

test('worker rejects a scheduler without a trusted workspace source', () => {
  assert.throws(() => new BuildCiWorkerHost({
    workerId: 'invalid-worker',
    logger: silentLogger,
    schedules: {
      scanWorkspace: async () => ({ scanned: false, occurrencesFound: 0, inserted: 0 }),
      processNext: async () => ({ claimed: false, dispatched: false }),
    },
  }), /schedules and scheduleWorkspaces must be supplied together/);
});
