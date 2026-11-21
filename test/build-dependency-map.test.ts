import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessBuildFeatureSchedule,
  buildDependencyMap,
  type BuildDependencyInputSnapshot,
} from '../src/modules/build-sequence/dependency-map-engine.ts';
import { BuildDependencyMapService, type BuildDependencyLedgerReader } from '../src/modules/build-sequence/dependency-map-service.ts';

const snapshot: BuildDependencyInputSnapshot = {
  features: [
    { featureId: 'app.slice', completed: false, dependencies: [
      { dependencyId: 'core.accounts', kind: 'feature' },
      { dependencyId: 'database', kind: 'capability', satisfied: false },
    ] },
    { featureId: 'core.accounts', completed: true, dependencies: [] },
  ],
};

class LedgerFake implements BuildDependencyLedgerReader {
  value: unknown = snapshot;
  fail = false;
  calls = 0;
  async readDependencySnapshot(): Promise<unknown> {
    this.calls += 1;
    if (this.fail) throw new Error('build ledger unavailable');
    return this.value;
  }
}

test('functional TS-2852: builds a deterministic dependency map from supplied ledger evidence', () => {
  const result = buildDependencyMap(snapshot);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.features.map((feature) => feature.featureId), ['app.slice', 'core.accounts']);
  assert.deepEqual(result.value.features[0]?.dependencies, [
    { dependencyId: 'core.accounts', kind: 'feature', satisfied: true },
    { dependencyId: 'database', kind: 'capability', satisfied: false },
  ]);
  assert.equal(result.value.features[0]?.canSchedule, false);
  assert.equal(result.value.features[1]?.canSchedule, true);
  assert.deepEqual(assessBuildFeatureSchedule(result.value, 'app.slice'), {
    ok: false,
    reason: 'dependencies_unmet',
    unmet: ['database'],
  });
  assert.deepEqual(assessBuildFeatureSchedule(result.value, 'core.accounts'), {
    ok: true,
    featureId: 'core.accounts',
    eligible: true,
  });
  assert.deepEqual(assessBuildFeatureSchedule(result.value, 'missing-feature'), { ok: false, reason: 'feature_unknown' });
});

test('functional TS-2852: a feature dependency is released only when the referenced ledger feature is complete', () => {
  const incomplete = buildDependencyMap({
    features: [
      { featureId: 'feature.a', completed: false, dependencies: [{ dependencyId: 'feature.b', kind: 'feature' }] },
      { featureId: 'feature.b', completed: false, dependencies: [] },
    ],
  });
  assert.equal(incomplete.ok, true);
  if (incomplete.ok) assert.deepEqual(assessBuildFeatureSchedule(incomplete.value, 'feature.a'), {
    ok: false,
    reason: 'dependencies_unmet',
    unmet: ['feature.b'],
  });

  const complete = buildDependencyMap({
    features: [
      { featureId: 'feature.a', completed: false, dependencies: [{ dependencyId: 'feature.b', kind: 'feature' }] },
      { featureId: 'feature.b', completed: true, dependencies: [] },
    ],
  });
  assert.equal(complete.ok, true);
  if (complete.ok) assert.equal(assessBuildFeatureSchedule(complete.value, 'feature.a').ok, true);
});

test('functional TS-2852: missing, duplicate, inconsistent, or unknown dependency evidence fails closed', () => {
  const invalid: unknown[] = [
    null,
    { features: [] , unexpected: true },
    { features: [{ featureId: 'same', completed: false, dependencies: [] }, { featureId: 'same', completed: true, dependencies: [] }] },
    { features: [{ featureId: 'a', completed: false, dependencies: [{ dependencyId: 'missing', kind: 'feature' }] }] },
    { features: [{ featureId: 'a', completed: false, dependencies: [{ dependencyId: 'db', kind: 'capability' }] }] },
    { features: [{ featureId: 'a', completed: false, dependencies: [{ dependencyId: 'b', kind: 'feature', satisfied: true }] }, { featureId: 'b', completed: true, dependencies: [] }] },
    { features: [{ featureId: 'a', completed: false, dependencies: [
      { dependencyId: 'db', kind: 'capability', satisfied: true },
      { dependencyId: 'db', kind: 'capability', satisfied: true },
    ] }] },
    { features: [{ featureId: '', completed: false, dependencies: [] }] },
    { features: [{ featureId: 'a', completed: 'yes', dependencies: [] }] },
  ];
  for (const raw of invalid) assert.deepEqual(buildDependencyMap(raw), { ok: false, reason: 'snapshot_invalid' });
});

test('functional TS-2852: the service consumes only the ledger reader and never schedules blocked work', async () => {
  const ledger = new LedgerFake();
  const service = new BuildDependencyMapService(ledger);
  assert.deepEqual(await service.assessSchedule('app.slice'), { ok: false, reason: 'dependencies_unmet', unmet: ['database'] });
  assert.deepEqual(await service.assessSchedule('core.accounts'), { ok: true, featureId: 'core.accounts', eligible: true });
  assert.equal(ledger.calls, 2);
});

test('functional TS-2852: unavailable or malformed ledger snapshots fail closed', async () => {
  const ledger = new LedgerFake();
  const service = new BuildDependencyMapService(ledger);
  ledger.value = { features: [{ featureId: 'broken', completed: false, dependencies: [{ dependencyId: 'unknown', kind: 'feature' }] }] };
  assert.deepEqual(await service.readMap(), { ok: false, reason: 'ledger_invalid' });
  ledger.fail = true;
  assert.deepEqual(await service.assessSchedule('app.slice'), { ok: false, reason: 'ledger_unavailable' });
});
