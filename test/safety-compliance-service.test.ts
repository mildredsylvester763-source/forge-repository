import assert from 'node:assert/strict';
import test from 'node:test';
import { IMMUTABLE_FLOOR, SAFETY_CATEGORIES } from '../src/modules/safety/engine/toggle-state-engine.ts';
import {
  evaluateSafetyComplianceMap,
  type SafetyComplianceMap,
  type SafetyComplianceReport,
  type SafetyComplianceSystemId,
} from '../src/modules/safety/engine/compliance-mapping-engine.ts';
import {
  SAFETY_COMPLIANCE_FEATURE_ID,
  SafetyComplianceService,
  type SafetyComplianceRepository,
} from '../src/modules/safety/safety-compliance-service.ts';

const allSystems: readonly SafetyComplianceSystemId[] = [...SAFETY_CATEGORIES, IMMUTABLE_FLOOR.id];

function completeMap(): SafetyComplianceMap {
  return Object.freeze({
    mapId: 'fixture-compliance-map',
    version: 'fixture-revision-a',
    entries: Object.freeze(allSystems.map((systemId, index) => {
      const kind = index === 0 ? 'law' as const : 'duty' as const;
      return Object.freeze({
        systemId,
        bases: Object.freeze([Object.freeze({
          basisId: `basis-${systemId}`,
          kind,
          sourceId: `source-${systemId}`,
          reference: `reference-${systemId}`,
          rationale: `test rationale for ${systemId}`,
          ...(kind === 'law' ? { jurisdiction: 'fixture-jurisdiction' } : {}),
        })]),
      });
    })),
  });
}

class MemoryComplianceRepository implements SafetyComplianceRepository {
  mapping: unknown | null;
  readonly reports: SafetyComplianceReport[] = [];
  failRead = false;
  failAudit = false;
  constructor(mapping: unknown | null) { this.mapping = mapping; }
  async loadCurrentMap(): Promise<unknown | null> {
    if (this.failRead) throw new Error('map repository unavailable');
    return this.mapping;
  }
  async appendReleaseCheck(report: SafetyComplianceReport): Promise<void> {
    if (this.failAudit) throw new Error('compliance audit unavailable');
    this.reports.push(report);
  }
}

test('functional TS-791: every safety category and the immutable floor must have an identified law/duty source', async () => {
  const mapping = completeMap();
  const evaluated = evaluateSafetyComplianceMap(mapping);
  assert.equal(evaluated.ok, true);
  if (!evaluated.ok) return;
  assert.equal(evaluated.value.releaseAllowed, true);
  assert.equal(evaluated.value.mapId, mapping.mapId);
  assert.equal(evaluated.value.version, mapping.version);
  assert.deepEqual(evaluated.value.unmappedSystems, []);
  assert.equal(evaluated.value.mappedSystems.length, allSystems.length);
  assert.ok(evaluated.value.mappedSystems.every((row) => row.bases.length > 0 && row.bases.every((basis) => basis.sourceId.length > 0 && basis.reference.length > 0 && basis.rationale.length > 0)));
  assert.equal(SAFETY_COMPLIANCE_FEATURE_ID, 'TS-791');

  const repository = new MemoryComplianceRepository(mapping);
  const service = new SafetyComplianceService(repository);
  const release = await service.checkRelease();
  assert.equal(release.ok, true);
  if (release.ok) assert.equal(release.releaseAllowed, true);
  assert.equal(repository.reports.length, 1);
});

test('functional TS-791: empty or missing basis records name the uncovered system and block release', () => {
  const withoutBasis = completeMap();
  const emptyEntry = { ...withoutBasis, entries: withoutBasis.entries.map((entry) => entry.systemId === 'minor_ceiling' ? { ...entry, bases: [] } : entry) };
  const result = evaluateSafetyComplianceMap(emptyEntry);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.releaseAllowed, false);
  assert.deepEqual(result.value.unmappedSystems, ['minor_ceiling']);
  assert.ok(!result.value.mappedSystems.some((entry) => entry.systemId === 'minor_ceiling'));

  const missingEntry = { ...withoutBasis, entries: withoutBasis.entries.filter((entry) => entry.systemId !== 'jurisdictional_compliance') };
  const missing = evaluateSafetyComplianceMap(missingEntry);
  assert.equal(missing.ok, true);
  if (missing.ok) assert.deepEqual(missing.value.unmappedSystems, ['jurisdictional_compliance']);
});

test('functional TS-791: absent map flags every system and remains an auditable blocked release report', async () => {
  const missing = evaluateSafetyComplianceMap(null);
  assert.equal(missing.ok, true);
  if (missing.ok) {
    assert.equal(missing.value.releaseAllowed, false);
    assert.deepEqual(missing.value.unmappedSystems, allSystems);
  }
  const repository = new MemoryComplianceRepository(null);
  const result = await new SafetyComplianceService(repository).checkRelease();
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.releaseAllowed, false);
  assert.equal(repository.reports.length, 1);
  assert.equal(repository.reports[0]?.unmappedSystems.length, allSystems.length);
});

test('functional TS-791: malformed mappings and duplicate source records fail closed', () => {
  const valid = completeMap();
  const badBasis = structuredClone(valid) as unknown as { mapId: string; version: string; entries: Array<{ systemId: string; bases: Array<Record<string, unknown>> }> };
  badBasis.entries[0]!.bases[0]!.sourceId = '';
  assert.deepEqual(evaluateSafetyComplianceMap(badBasis), { ok: false, reason: 'invalid_compliance_basis:content' });

  const duplicate = structuredClone(valid) as unknown as { mapId: string; version: string; entries: Array<{ systemId: string; bases: Array<Record<string, unknown>> }> };
  duplicate.entries[1]!.bases[0]!.basisId = duplicate.entries[0]!.bases[0]!.basisId;
  assert.deepEqual(evaluateSafetyComplianceMap(duplicate), { ok: false, reason: 'duplicate_compliance_basis:basis-content' });

  const unknownSystem = { ...valid, entries: [...valid.entries, { systemId: 'unregistered' as SafetyComplianceSystemId, bases: [] }] };
  assert.deepEqual(evaluateSafetyComplianceMap(unknownSystem), { ok: false, reason: 'invalid_compliance_entry' });
});

test('functional TS-791: unavailable mapping or audit persistence blocks release', async () => {
  const unavailable = new MemoryComplianceRepository(completeMap());
  unavailable.failRead = true;
  assert.deepEqual(await new SafetyComplianceService(unavailable).checkRelease(), { ok: false, releaseAllowed: false, reason: 'compliance_data_unavailable' });

  const auditUnavailable = new MemoryComplianceRepository(completeMap());
  auditUnavailable.failAudit = true;
  assert.deepEqual(await new SafetyComplianceService(auditUnavailable).checkRelease(), { ok: false, releaseAllowed: false, reason: 'compliance_audit_unavailable' });
});
