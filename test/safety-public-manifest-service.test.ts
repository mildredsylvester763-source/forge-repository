import assert from 'node:assert/strict';
import test from 'node:test';
import { SAFETY_CATALOG } from '../src/modules/safety/safety-catalog.ts';
import { IMMUTABLE_FLOOR, SAFETY_CATEGORIES } from '../src/modules/safety/engine/toggle-state-engine.ts';
import { buildSafetyPublicManifest } from '../src/modules/safety/safety-public-manifest-service.ts';

test('functional TS-800: public manifest covers canonical safety definitions and the immutable floor', () => {
  const result = buildSafetyPublicManifest();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.schemaVersion, 1);
  assert.equal(result.manifest.coverage, 'canonical_policy_definitions_only');
  assert.deepEqual(result.manifest.systems.map((row) => row.id), SAFETY_CATEGORIES);
  const catalogFloor = SAFETY_CATALOG.find((row) => row.id === IMMUTABLE_FLOOR.id)!;
  assert.deepEqual(result.manifest.immutableFloor, {
    id: catalogFloor.id,
    label: catalogFloor.label,
    description: catalogFloor.description,
    enabled: true,
    mutable: false,
  });
  assert.match(result.manifest.sha256, /^[a-f0-9]{64}$/);
});

test('functional TS-800: manifest content and fingerprint are deterministic and contain no live-state claim', () => {
  const first = buildSafetyPublicManifest();
  const second = buildSafetyPublicManifest();
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal('states' in first.manifest, false);
    assert.equal('enabled' in first.manifest.systems[0]!, false);
    assert.equal('plan' in first.manifest, false);
  }
});

test('functional TS-800: malformed, duplicate, missing, and extra catalog entries fail closed', () => {
  assert.deepEqual(buildSafetyPublicManifest(SAFETY_CATALOG.slice(1)), { ok: false, reason: 'catalog_invalid' });
  assert.deepEqual(buildSafetyPublicManifest([...SAFETY_CATALOG, SAFETY_CATALOG[0]!]), { ok: false, reason: 'catalog_invalid' });
  assert.deepEqual(buildSafetyPublicManifest(SAFETY_CATALOG.map((row, index) => index === 0 ? { ...row, description: '' } : row)), { ok: false, reason: 'catalog_invalid' });
  assert.deepEqual(buildSafetyPublicManifest(SAFETY_CATALOG.map((row, index) => index === 0 ? { ...row, extra: true } as typeof row : row)), { ok: false, reason: 'catalog_invalid' });
});
