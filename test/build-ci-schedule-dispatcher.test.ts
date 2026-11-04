import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateBuildCiSqlite } from '../src/modules/build-ci/migrations.ts';
import { BuildCiService } from '../src/modules/build-ci/store.ts';
import { SqliteBuildCiStore } from '../src/modules/build-ci/sqlite-store.ts';
import { SqlitePipelineTemplateStore } from '../src/modules/build-ci/templates.ts';
import { SqliteScheduleOccurrenceStore } from '../src/modules/build-ci/schedule-occurrences.ts';
import { ScheduleDispatcher } from '../src/modules/build-ci/schedule-dispatcher.ts';

function fixture(authorize: (actorId: string) => Promise<boolean> = async () => true) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrateBuildCiSqlite(db);
  const pipelines = new SqliteBuildCiStore(db);
  const buildCi = new BuildCiService({
    store: pipelines,
    templates: new SqlitePipelineTemplateStore(db),
    authorize: async (request) => authorize(request.actorId),
  });
  const occurrences = new SqliteScheduleOccurrenceStore(db);
  return { db, pipelines, buildCi, occurrences };
}

test('scheduler scans with a durable cursor and dispatches each minute occurrence exactly once', async () => {
  const { db, pipelines, buildCi, occurrences } = fixture();
  try {
    await buildCi.createPipeline({
      workspaceId: 'workspace-schedule', actorId: 'scheduler-actor',
      definition: {
        id: 'minute-build', name: 'Minute build',
        triggers: [{ id: 'every-minute', kind: 'schedule', scheduleId: 'minute-build', cron: '* * * * *', timeZone: 'UTC' }],
        steps: [{ id: 'test', task: 'quality.test' }],
      },
    });
    let now = Date.parse('2026-11-04T12:05:00.000Z');
    const dispatcher = new ScheduleDispatcher({
      occurrences, pipelines, buildCi, now: () => now, initialLookbackMinutes: 3,
      scanBatchMinutes: 10, retryBaseMs: 1_000,
    });
    const scan = await dispatcher.scanWorkspace('workspace-schedule');
    assert.equal(scan.scanned, true);
    assert.equal(scan.occurrencesFound, 3);
    assert.equal(scan.inserted, 3);
    const repeatScan = await dispatcher.scanWorkspace('workspace-schedule');
    assert.equal(repeatScan.scanned, false);

    for (let i = 0; i < 3; i += 1) {
      const result = await dispatcher.processNext({
        workspaceId: 'workspace-schedule', actorId: 'scheduler-actor', workerId: 'schedule-worker',
      });
      assert.equal(result.dispatched, true);
      assert.equal(result.queuedRun, true);
    }
    assert.equal((await dispatcher.processNext({
      workspaceId: 'workspace-schedule', actorId: 'scheduler-actor', workerId: 'schedule-worker',
    })).claimed, false);

    const runs = db.prepare('SELECT event_id, created_at, status FROM build_pipeline_runs ORDER BY created_at').all() as Array<{
      event_id: string; created_at: string; status: string;
    }>;
    assert.equal(runs.length, 3);
    assert.ok(runs.every((run) => run.status === 'queued'));
    assert.deepEqual(runs.map((run) => run.created_at), [
      '2026-11-04T12:03:00.000Z', '2026-11-04T12:04:00.000Z', '2026-11-04T12:05:00.000Z',
    ]);
    assert.equal((await occurrences.list('workspace-schedule')).filter((item) => item.status === 'dispatched').length, 3);
  } finally { db.close(); }
});

test('scheduler retries authorization failures and dispatches idempotently after recovery', async () => {
  let allowed = true;
  const { db, pipelines, buildCi, occurrences } = fixture(async () => allowed);
  try {
    await buildCi.createPipeline({
      workspaceId: 'workspace-retry', actorId: 'scheduler-actor', createdAt: '2026-11-04T11:00:00.000Z',
      definition: {
        id: 'retry-build', name: 'Retry build',
        triggers: [{ id: 'daily', kind: 'schedule', scheduleId: 'daily', cron: '0 12 * * *', timeZone: 'UTC' }],
        steps: [{ id: 'test', task: 'quality.test' }],
      },
    });
    allowed = false;
    let now = Date.parse('2026-11-04T12:00:00.000Z');
    const dispatcher = new ScheduleDispatcher({
      occurrences, pipelines, buildCi, now: () => now, initialLookbackMinutes: 1, retryBaseMs: 1_000,
    });
    await dispatcher.scanWorkspace('workspace-retry');
    const failed = await dispatcher.processNext({
      workspaceId: 'workspace-retry', actorId: 'scheduler-actor', workerId: 'worker-a',
    });
    assert.equal(failed.retryScheduled, true);
    allowed = true;
    now += 1_001;
    const retried = await dispatcher.processNext({
      workspaceId: 'workspace-retry', actorId: 'scheduler-actor', workerId: 'worker-b',
    });
    assert.equal(retried.dispatched, true);
    assert.equal(retried.queuedRun, true);
    const runCount = db.prepare('SELECT COUNT(*) AS count FROM build_pipeline_runs').get() as { count: number };
    assert.equal(Number(runCount.count), 1);
  } finally { db.close(); }
});

test('queued occurrence from a superseded pipeline version is skipped, not run against stale config', async () => {
  const { db, pipelines, buildCi, occurrences } = fixture();
  try {
    const definition = {
      id: 'versioned-build', name: 'Versioned build',
      triggers: [{ id: 'nightly', kind: 'schedule' as const, scheduleId: 'nightly', cron: '0 12 * * *', timeZone: 'UTC' }],
      steps: [{ id: 'test', task: 'quality.test' }],
    };
    await buildCi.createPipeline({ workspaceId: 'workspace-version', actorId: 'scheduler-actor', createdAt: '2026-11-04T11:00:00.000Z', definition });
    let now = Date.parse('2026-11-04T12:00:00.000Z');
    const dispatcher = new ScheduleDispatcher({ occurrences, pipelines, buildCi, now: () => now, initialLookbackMinutes: 1 });
    await dispatcher.scanWorkspace('workspace-version');
    await buildCi.createPipeline({
      workspaceId: 'workspace-version', actorId: 'scheduler-actor', createdAt: '2026-11-04T11:30:00.000Z',
      definition: { ...definition, name: 'Updated build' },
    });
    const result = await dispatcher.processNext({
      workspaceId: 'workspace-version', actorId: 'scheduler-actor', workerId: 'worker',
    });
    assert.equal(result.skipped, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM build_pipeline_runs').get()?.count, 0);
    assert.equal((await occurrences.list('workspace-version'))[0]?.status, 'skipped');
  } finally { db.close(); }
});

test('paused schedules create no occurrences and resume from the next due minute', async () => {
  const { db, pipelines, buildCi, occurrences } = fixture();
  try {
    const base = {
      id: 'pausable-build',
      name: 'Pausable build',
      triggers: [{
        id: 'every-minute',
        kind: 'schedule' as const,
        enabled: false,
        scheduleId: 'pausable',
        cron: '* * * * *',
        timeZone: 'UTC',
      }],
      steps: [{ id: 'test', task: 'quality.test' }],
    };
    await buildCi.createPipeline({
      workspaceId: 'workspace-pause', actorId: 'scheduler-actor',
      createdAt: '2026-11-04T11:00:00.000Z', definition: base,
    });
    let now = Date.parse('2026-11-04T12:00:00.000Z');
    const dispatcher = new ScheduleDispatcher({
      occurrences, pipelines, buildCi, now: () => now, initialLookbackMinutes: 1,
    });
    const pausedScan = await dispatcher.scanWorkspace('workspace-pause');
    assert.equal(pausedScan.occurrencesFound, 0);
    await buildCi.createPipeline({
      workspaceId: 'workspace-pause', actorId: 'scheduler-actor',
      createdAt: '2026-11-04T12:00:30.000Z',
      definition: { ...base, name: 'Resumed build', triggers: [{ ...base.triggers[0], enabled: true }] },
    });
    now = Date.parse('2026-11-04T12:01:00.000Z');
    const resumedScan = await dispatcher.scanWorkspace('workspace-pause');
    assert.equal(resumedScan.inserted, 1);
    const dispatched = await dispatcher.processNext({
      workspaceId: 'workspace-pause', actorId: 'scheduler-actor', workerId: 'resume-worker',
    });
    assert.equal(dispatched.dispatched, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM build_pipeline_runs').get()?.count, 1);
  } finally { db.close(); }
});
