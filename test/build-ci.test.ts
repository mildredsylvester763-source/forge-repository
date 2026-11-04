import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PipelineDefinitionError,
  PipelineGraphError,
  buildDryRunPlan,
  createPipelineVersion,
  createRollbackVersion,
  evaluateCondition,
  evaluatePathFilter,
  evaluateTrigger,
  matchesOrderedPatterns,
  newPipelineId,
  orderPipelineSteps,
  triggerIdempotencyKey,
  validatePipelineDefinition,
  type PipelineDefinition,
  type TriggerEvent,
} from '../src/modules/build-ci/pipeline.ts';

function definition(overrides: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return validatePipelineDefinition({
    id: 'web-build',
    name: 'Web build',
    triggers: [{ id: 'on-push', kind: 'push', branches: ['main', 'release/**'], paths: ['src/**', '!src/docs/**'] }],
    steps: [
      { id: 'lint', task: 'quality.lint' },
      { id: 'test', task: 'quality.test', needs: ['lint'], when: { op: 'eq', field: 'branch', value: 'main' } },
      { id: 'package', task: 'build.package', needs: ['test'] },
    ],
    ...overrides,
  });
}

const pushEvent: TriggerEvent = {
  kind: 'push', source: 'github:repo/owner/project', eventId: 'delivery-123', branch: 'main',
  changedFiles: ['src/app.ts'], commitSha: 'a'.repeat(40),
};

test('validates declarative task references and freezes accepted definitions', () => {
  const value = definition();
  assert.equal(value.id, 'web-build');
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.steps), true);
  assert.throws(() => validatePipelineDefinition({ ...value, shell: 'rm -rf /' }), PipelineDefinitionError);
});

test('rejects duplicate IDs, missing fields and unsafe task/parameter content', () => {
  assert.throws(() => validatePipelineDefinition({
    id: 'web', name: 'Web', triggers: [{ id: 't', kind: 'push' }, { id: 't', kind: 'manual' }],
    steps: [{ id: 'a', task: 'test.run', params: JSON.parse('{"__proto__":{"admin":true}}') }],
  }), PipelineDefinitionError);
  assert.throws(() => validatePipelineDefinition({ id: 'web', name: 'Web', triggers: [], steps: [] }), PipelineDefinitionError);
  assert.throws(() => validatePipelineDefinition({
    id: 'unsafe', name: 'Unsafe', triggers: [{ id: 'push', kind: 'push', paths: ['src/../secrets/**'] }],
    steps: [{ id: 'run', task: 'tests.run' }],
  }), PipelineDefinitionError);
  assert.throws(() => validatePipelineDefinition({
    id: 'large', name: 'Large', triggers: [{ id: 'manual', kind: 'manual' }],
    steps: [{ id: 'run', task: 'tests.run', params: { source: 'x'.repeat(300_000) } }],
  }), PipelineDefinitionError);
});

test('rejects unsupported cron formats and invalid time zones', () => {
  assert.throws(() => validatePipelineDefinition({
    id: 'nightly', name: 'Nightly', triggers: [{ id: 'schedule', kind: 'schedule', scheduleId: 'nightly', cron: 'tomorrow', timeZone: 'Mars/Olympus' }],
    steps: [{ id: 'run', task: 'tests.run' }],
  }), PipelineDefinitionError);
  assert.throws(() => validatePipelineDefinition({
    id: 'nightly', name: 'Nightly', triggers: [{ id: 'schedule', kind: 'schedule', scheduleId: 'nightly', cron: '/5 * * * *' }],
    steps: [{ id: 'run', task: 'tests.run' }],
  }), PipelineDefinitionError);
});

test('builds stable DAG levels and preserves declaration order within a parallel level', () => {
  const value = validatePipelineDefinition({
    id: 'parallel', name: 'Parallel', triggers: [{ id: 'manual', kind: 'manual' }],
    steps: [
      { id: 'lint', task: 'lint' }, { id: 'typecheck', task: 'typecheck' },
      { id: 'tests', task: 'tests', needs: ['lint', 'typecheck'] }, { id: 'package', task: 'package', needs: ['tests'] },
    ],
  });
  assert.deepEqual(orderPipelineSteps(value), [['lint', 'typecheck'], ['tests'], ['package']]);
});

test('rejects unknown dependencies and dependency cycles', () => {
  assert.throws(() => validatePipelineDefinition({
    id: 'broken', name: 'Broken', triggers: [{ id: 'manual', kind: 'manual' }],
    steps: [{ id: 'a', task: 'a', needs: ['missing'] }],
  }), PipelineGraphError);
  assert.throws(() => validatePipelineDefinition({
    id: 'cycle', name: 'Cycle', triggers: [{ id: 'manual', kind: 'manual' }],
    steps: [{ id: 'a', task: 'a', needs: ['b'] }, { id: 'b', task: 'b', needs: ['a'] }],
  }), PipelineGraphError);
});

test('supports globstar, single-segment wildcards and ordered exclusion/re-inclusion', () => {
  assert.equal(matchesOrderedPatterns('src/components/button.ts', ['src/**']), true);
  assert.equal(matchesOrderedPatterns('src/docs/readme.md', ['src/**', '!src/docs/**']), false);
  assert.equal(matchesOrderedPatterns('src/docs/generated/api.md', ['src/**', '!src/docs/**', 'src/docs/generated/**']), true);
  assert.equal(matchesOrderedPatterns('src/a.ts', ['src/*.ts']), true);
  assert.equal(matchesOrderedPatterns('src/nested/a.ts', ['src/*.ts']), false);
});

test('path filters fail open when the changed-file diff is unavailable, but not when it is empty', () => {
  assert.deepEqual(evaluatePathFilter(['src/**'], undefined), { matched: true, degraded: true, reason: 'changed_files_unavailable' });
  assert.deepEqual(evaluatePathFilter(['src/**'], []), { matched: false, degraded: false, reason: 'no_changed_files' });
  assert.deepEqual(evaluatePathFilter(['src/**'], ['README.md']), { matched: false, degraded: false, reason: 'no_path_match' });
});

test('branch and path trigger filters are conjunctive; PR branch uses target branch', () => {
  const trigger = definition().triggers[0]!;
  assert.equal(evaluateTrigger(trigger, pushEvent).matched, true);
  assert.equal(evaluateTrigger(trigger, { ...pushEvent, branch: 'feature/new' }).matched, false);
  assert.equal(evaluateTrigger(trigger, { ...pushEvent, changedFiles: ['README.md'] }).matched, false);
  const prTrigger = { ...trigger, kind: 'pull_request' as const };
  assert.equal(evaluateTrigger(prTrigger, { ...pushEvent, kind: 'pull_request', branch: 'feature/foo', baseBranch: 'main' }).matched, true);
});

test('trigger evaluation records degraded matching rather than silently skipping on missing diffs', () => {
  const result = evaluateTrigger(definition().triggers[0]!, { ...pushEvent, changedFiles: undefined });
  assert.equal(result.matched, true);
  assert.equal(result.degraded, true);
  assert.ok(result.reasons.includes('changed_files_unavailable_fail_open'));
});

test('schedule triggers require the exact scheduler-owned schedule identity', () => {
  const schedule = validatePipelineDefinition({
    id: 'nightly', name: 'Nightly',
    triggers: [{ id: 'daily', kind: 'schedule', scheduleId: 'daily-build', cron: '0 2 * * *', timeZone: 'Africa/Lagos' }],
    steps: [{ id: 'tests', task: 'quality.test' }],
  }).triggers[0]!;
  assert.equal(evaluateTrigger(schedule, { kind: 'schedule', source: 'forge:scheduler', eventId: 'tick-1', scheduleId: 'daily-build' }).matched, true);
  assert.equal(evaluateTrigger(schedule, { kind: 'schedule', source: 'forge:scheduler', eventId: 'tick-2', scheduleId: 'other' }).matched, false);
});


test('generic event triggers require an exact event type match', () => {
  const eventTrigger = validatePipelineDefinition({
    id: 'event-pipeline', name: 'Event pipeline',
    triggers: [{ id: 'audit-event', kind: 'event', eventType: 'identity.user.registered' }],
    steps: [{ id: 'notify', task: 'notifications.dispatch' }],
  }).triggers[0]!;
  assert.equal(evaluateTrigger(eventTrigger, { kind: 'event', source: 'forge:event-bus', eventId: 'evt-1', eventType: 'identity.user.registered' }).matched, true);
  assert.equal(evaluateTrigger(eventTrigger, { kind: 'event', source: 'forge:event-bus', eventId: 'evt-2', eventType: 'identity.sign_in.failed' }).matched, false);
  assert.throws(() => validatePipelineDefinition({
    id: 'event-pipeline', name: 'Event pipeline',
    triggers: [{ id: 'audit-event', kind: 'event' }],
    steps: [{ id: 'notify', task: 'notifications.dispatch' }],
  }), PipelineDefinitionError);
});

test('evaluates a safe, structured condition language without eval', () => {
  const context = { branch: 'main', actor: { role: 'maintainer' }, changedFiles: ['src/app.ts'] };
  assert.equal(evaluateCondition({ op: 'all', conditions: [
    { op: 'eq', field: 'branch', value: 'main' },
    { op: 'in', field: 'actor.role', values: ['maintainer', 'admin'] },
    { op: 'exists', field: 'changedFiles' },
  ] }, context), true);
  assert.equal(evaluateCondition({ op: 'not', condition: { op: 'eq', field: 'branch', value: 'develop' } }, context), true);
  assert.equal(evaluateCondition({ op: 'eq', field: '__proto__.admin', value: true }, context), false);
});

test('dry-run produces a deterministic plan without side effects and explains skips', () => {
  const value = definition();
  const plan = buildDryRunPlan(value, { ...pushEvent, branch: 'release/1.x' });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.sideEffects, false);
  assert.equal(plan.triggered, true);
  assert.deepEqual(plan.parallelGroups, [['lint'], ['test'], ['package']]);
  assert.equal(plan.steps.find((step) => step.stepId === 'test')?.status, 'skipped');
  assert.ok(plan.steps.find((step) => step.stepId === 'test')?.reasons.includes('condition_false'));
  assert.equal(plan.steps.find((step) => step.stepId === 'package')?.status, 'skipped');
  assert.ok(plan.steps.find((step) => step.stepId === 'package')?.reasons.includes('dependency_skipped:test'));
  assert.deepEqual(plan.steps.map((step) => step.stepId), ['lint', 'test', 'package']);
  const nonMatching = buildDryRunPlan(value, { ...pushEvent, branch: 'docs' });
  assert.equal(nonMatching.triggered, false);
  assert.ok(nonMatching.steps.every((step) => step.status === 'skipped'));
});


test('generated pipeline IDs always satisfy the public definition schema', () => {
  const id = newPipelineId();
  assert.match(id, /^pipeline-[0-9a-f-]{36}$/);
  assert.equal(validatePipelineDefinition({
    id, name: 'Generated ID', triggers: [{ id: 'manual', kind: 'manual' }], steps: [{ id: 'test', task: 'quality.test' }],
  }).id, id);
});

test('creates deterministic content hashes for immutable pipeline versions', () => {
  const value = definition();
  const a = createPipelineVersion(value, 1, 'owner', '2026-11-04T00:00:00.000Z');
  const b = createPipelineVersion(value, 1, 'owner', '2026-11-04T00:00:00.000Z');
  assert.equal(a.definitionHash, b.definitionHash);
  assert.equal(a.pipelineId, value.id);
  assert.equal(Object.isFrozen(a.definition), true);
});

test('rollback creates a new version from the selected historical snapshot, never rewrites history', () => {
  const v1 = createPipelineVersion(definition(), 1, 'owner', '2026-11-01T00:00:00.000Z');
  const changed = validatePipelineDefinition({ ...definition(), name: 'Changed build' });
  const v2 = createPipelineVersion(changed, 2, 'owner', '2026-11-02T00:00:00.000Z');
  const rollback = createRollbackVersion([v1, v2], 1, 'owner', '2026-11-03T00:00:00.000Z');
  assert.equal(rollback.version, 3);
  assert.equal(rollback.rollbackOfVersion, 1);
  assert.equal(rollback.definitionHash, v1.definitionHash);
  assert.equal(v1.version, 1);
  assert.equal(v2.definition.name, 'Changed build');
});

test('event idempotency keys are stable and scoped by workspace and pipeline', () => {
  const one = triggerIdempotencyKey('workspace-a', 'web-build', pushEvent);
  assert.equal(one, triggerIdempotencyKey('workspace-a', 'web-build', pushEvent));
  assert.notEqual(one, triggerIdempotencyKey('workspace-b', 'web-build', pushEvent));
  assert.notEqual(one, triggerIdempotencyKey('workspace-a', 'other-pipeline', pushEvent));
});

import { DatabaseSync } from 'node:sqlite';
import { migrateBuildCiSqlite } from '../src/modules/build-ci/migrations.ts';
import { SqliteBuildCiStore } from '../src/modules/build-ci/sqlite-store.ts';
import { SqlitePipelineTemplateStore } from '../src/modules/build-ci/templates.ts';
import { BuildCiService, PipelineAuthorizationError } from '../src/modules/build-ci/store.ts';

test('SQLite store persists immutable versions and append-only rollback snapshots', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrateBuildCiSqlite(db);
  const store = new SqliteBuildCiStore(db);
  const service = new BuildCiService({ store, templates: new SqlitePipelineTemplateStore(db), authorize: async () => true });
  const v1 = await service.createPipeline({ workspaceId: 'ws-a', definition: definition(), actorId: 'owner', createdAt: '2026-11-01T00:00:00.000Z' });
  const edited = validatePipelineDefinition({ ...definition(), name: 'Updated build' });
  const v2 = await service.createPipeline({ workspaceId: 'ws-a', definition: edited, actorId: 'owner', createdAt: '2026-11-02T00:00:00.000Z' });
  const rollback = await service.rollbackPipeline({ workspaceId: 'ws-a', pipelineId: 'web-build', targetVersion: 1, actorId: 'owner', createdAt: '2026-11-03T00:00:00.000Z' });
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(rollback.version, 3);
  assert.equal(rollback.rollbackOfVersion, 1);
  assert.equal((await store.getLatestVersion('ws-a', 'web-build'))?.definitionHash, v1.definitionHash);
  assert.deepEqual((await store.listVersions('ws-a', 'web-build')).map((item) => item.version), [1, 2, 3]);
  assert.throws(() => db.prepare('UPDATE build_pipeline_versions SET created_by = ? WHERE pipeline_id = ?').run('attacker', 'web-build'));
  assert.throws(() => db.prepare('DELETE FROM build_pipeline_versions WHERE pipeline_id = ?').run('web-build'));
  db.close();
});

test('service dry-run reads the durable current version', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrateBuildCiSqlite(db);
  const service = new BuildCiService({ store: new SqliteBuildCiStore(db), templates: new SqlitePipelineTemplateStore(db), authorize: async () => true });
  await service.createPipeline({ workspaceId: 'ws-a', definition: definition(), actorId: 'owner' });
  const before = Number((db.prepare('SELECT COUNT(*) AS count FROM build_pipeline_runs').get() as { count: number }).count);
  const plan = await service.dryRun({ workspaceId: 'ws-a', pipelineId: 'web-build', actorId: 'owner', event: pushEvent });
  const after = Number((db.prepare('SELECT COUNT(*) AS count FROM build_pipeline_runs').get() as { count: number }).count);
  assert.equal(after, before);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.triggered, true);
  assert.equal(plan.sideEffects, false);
  db.close();
});

test('trigger service authorizes, persists once and de-duplicates webhook redelivery', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrateBuildCiSqlite(db);
  const service = new BuildCiService({ store: new SqliteBuildCiStore(db), templates: new SqlitePipelineTemplateStore(db), authorize: async ({ actorId, action }) => actorId === 'owner' || (actorId === 'trusted-webhook' && action === 'trigger') });
  await service.createPipeline({ workspaceId: 'ws-a', definition: definition(), actorId: 'owner' });
  const [first, second] = await Promise.all([
    service.trigger({ workspaceId: 'ws-a', pipelineId: 'web-build', actorId: 'trusted-webhook', event: pushEvent, createdAt: '2026-11-04T00:00:00.000Z' }),
    service.trigger({ workspaceId: 'ws-a', pipelineId: 'web-build', actorId: 'trusted-webhook', event: pushEvent, createdAt: '2026-11-04T00:00:01.000Z' }),
  ]);
  assert.equal(first.queued, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.queued, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.run?.runId, first.run?.runId);
  assert.equal(second.run?.status, 'queued');
  assert.equal((await service.trigger({ workspaceId: 'ws-a', pipelineId: 'web-build', actorId: 'trusted-webhook', event: { ...pushEvent, eventId: 'another', changedFiles: ['README.md'] } })).queued, false);
  await assert.rejects(() => service.trigger({ workspaceId: 'ws-a', pipelineId: 'web-build', actorId: 'untrusted', event: { ...pushEvent, eventId: 'denied' } }), PipelineAuthorizationError);
  db.close();
});

test('pipeline and run records are isolated by workspace', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrateBuildCiSqlite(db);
  const service = new BuildCiService({ store: new SqliteBuildCiStore(db), templates: new SqlitePipelineTemplateStore(db), authorize: async () => true });
  await service.createPipeline({ workspaceId: 'ws-a', definition: definition(), actorId: 'owner' });
  assert.equal(await service.dryRun({ workspaceId: 'ws-b', pipelineId: 'web-build', actorId: 'owner' }).then(() => false, () => true), true);
  db.close();
});


test('service authorizes creation, rollback and dry-run independently of trigger authorization', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrateBuildCiSqlite(db);
  const service = new BuildCiService({
    store: new SqliteBuildCiStore(db),
    templates: new SqlitePipelineTemplateStore(db),
    authorize: async ({ actorId, action }) => actorId === 'owner' && action !== 'trigger',
  });
  await service.createPipeline({ workspaceId: 'ws-a', definition: definition(), actorId: 'owner' });
  await assert.rejects(
    () => service.createPipeline({ workspaceId: 'ws-a', definition: definition({ id: 'other-build' }), actorId: 'attacker' }),
    PipelineAuthorizationError,
  );
  await assert.rejects(
    () => service.rollbackPipeline({ workspaceId: 'ws-a', pipelineId: 'web-build', targetVersion: 1, actorId: 'attacker' }),
    PipelineAuthorizationError,
  );
  await assert.rejects(
    () => service.dryRun({ workspaceId: 'ws-a', pipelineId: 'web-build', actorId: 'attacker' }),
    PipelineAuthorizationError,
  );
  await assert.rejects(
    () => service.trigger({ workspaceId: 'ws-a', pipelineId: 'web-build', actorId: 'owner', event: { kind: 'manual', source: 'forge:manual', eventId: 'not-authorized' } }),
    PipelineAuthorizationError,
  );
  db.close();
});

test('candidate dry-run validates and plans an unsaved definition without persisting versions or runs', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrateBuildCiSqlite(db);
  const service = new BuildCiService({
    store: new SqliteBuildCiStore(db),
    templates: new SqlitePipelineTemplateStore(db),
    authorize: async ({ actorId, action }) => actorId === 'owner' && action === 'dry_run',
  });
  const candidate = definition({ id: 'unsaved-candidate', name: 'Unsaved candidate' });
  const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  const versionsBefore = count('build_pipeline_versions');
  const runsBefore = count('build_pipeline_runs');

  try {
    const plan = await service.dryRunDefinition({
      workspaceId: 'ws-a',
      definition: candidate,
      actorId: 'owner',
      event: pushEvent,
    });
    assert.equal(plan.pipelineId, 'unsaved-candidate');
    assert.equal(plan.dryRun, true);
    assert.equal(plan.sideEffects, false);
    assert.equal(plan.triggered, true);
    assert.equal(count('build_pipeline_versions'), versionsBefore);
    assert.equal(count('build_pipeline_runs'), runsBefore);
    await assert.rejects(
      () => service.dryRunDefinition({ workspaceId: 'ws-a', definition: candidate, actorId: 'attacker' }),
      PipelineAuthorizationError,
    );
    await assert.rejects(
      () => service.dryRunDefinition({ workspaceId: 'ws-a', definition: { ...candidate, shell: 'unsafe' }, actorId: 'owner' }),
      PipelineDefinitionError,
    );
    assert.equal(count('build_pipeline_versions'), versionsBefore);
    assert.equal(count('build_pipeline_runs'), runsBefore);
  } finally {
    db.close();
  }
});

test('SQLite version reads reject a definition that no longer matches its stored content hash', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrateBuildCiSqlite(db);
  const store = new SqliteBuildCiStore(db);
  try {
    const saved = await store.saveVersion({
      workspaceId: 'ws-integrity',
      definition: definition(),
      createdBy: 'owner',
      createdAt: '2026-11-04T15:00:00.000Z',
    });
    db.exec('DROP TRIGGER build_pipeline_versions_block_update');
    db.prepare(`UPDATE build_pipeline_versions SET definition_json = ?
      WHERE workspace_id = ? AND pipeline_id = ? AND version = ?`).run(
      JSON.stringify({ ...saved.definition, name: 'Tampered after persistence' }),
      'ws-integrity', saved.pipelineId, saved.version,
    );
    await assert.rejects(
      () => store.getVersion('ws-integrity', saved.pipelineId, saved.version),
      /failed integrity verification/,
    );
    await assert.rejects(
      () => store.getLatestVersion('ws-integrity', saved.pipelineId),
      /failed integrity verification/,
    );
    await assert.rejects(
      () => store.listVersions('ws-integrity', saved.pipelineId),
      /failed integrity verification/,
    );
  } finally {
    db.close();
  }
});

test('candidate dry-run returns a value-free baseline diff and saved versions expose the same structural comparison', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrateBuildCiSqlite(db);
  const store = new SqliteBuildCiStore(db);
  const service = new BuildCiService({
    store,
    templates: new SqlitePipelineTemplateStore(db),
    authorize: async ({ actorId, action }) => actorId === 'owner' && (action === 'create' || action === 'dry_run' || action === 'read'),
  });
  try {
    const original = definition();
    const v1 = await service.createPipeline({
      workspaceId: 'ws-diff', definition: original, actorId: 'owner',
      createdAt: '2026-11-04T16:00:00.000Z',
    });
    const candidate = validatePipelineDefinition({
      ...original,
      name: 'Web build with security checks',
      triggers: [...original.triggers, { id: 'on-pr', kind: 'pull_request' as const, branches: ['main'] }],
      steps: [...original.steps, { id: 'security', task: 'quality.security', needs: ['test'] }],
    });
    const plan = await service.dryRunDefinition({
      workspaceId: 'ws-diff', definition: candidate, actorId: 'owner', event: pushEvent,
    });
    assert.equal(plan.comparison.baselineVersion, 1);
    assert.equal(plan.comparison.baselineHash, v1.definitionHash);
    assert.equal(plan.comparison.candidateHash.length, 64);
    assert.equal(plan.comparison.diff?.hasChanges, true);
    assert.deepEqual(plan.comparison.diff?.changedFields, ['name']);
    assert.deepEqual(plan.comparison.diff?.triggers.added, [{ id: 'on-pr', kind: 'pull_request' }]);
    assert.deepEqual(plan.comparison.diff?.steps.added, [{ id: 'security', task: 'quality.security' }]);
    assert.equal(JSON.stringify(plan.comparison.diff).includes('Web build with security checks'), false);
    assert.equal(JSON.stringify(plan.comparison.diff).includes('quality.security'), true);

    const v2 = await service.createPipeline({
      workspaceId: 'ws-diff', definition: candidate, actorId: 'owner',
      createdAt: '2026-11-04T16:01:00.000Z',
    });
    const savedDiff = await service.diffPipelineVersions({
      workspaceId: 'ws-diff', pipelineId: 'web-build', fromVersion: 1, toVersion: 2, actorId: 'owner',
    });
    assert.equal(savedDiff.fromHash, v1.definitionHash);
    assert.equal(savedDiff.toHash, v2.definitionHash);
    assert.deepEqual(savedDiff.diff, plan.comparison.diff);

    await assert.rejects(
      () => service.diffPipelineVersions({
        workspaceId: 'ws-diff', pipelineId: 'web-build', fromVersion: 1, toVersion: 2, actorId: 'attacker',
      }),
      PipelineAuthorizationError,
    );
    await assert.rejects(
      () => service.diffPipelineVersions({
        workspaceId: 'ws-diff', pipelineId: 'web-build', fromVersion: 1, toVersion: 0, actorId: 'owner',
      }),
      /positive integers/,
    );
  } finally {
    db.close();
  }
});
