import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import { migratePostgres } from '../src/kernel/postgres-migrate.ts';
import {
  InMemoryAiTrainingStore, PostgresAiTrainingStore, SqliteAiTrainingStore,
  aiTrainingMigrations, pgAiTrainingMigrations, type AiTrainingStore,
} from '../src/modules/ai-training/index.ts';
import { identityMigrations, PostgresUserStore, SqliteUserStore } from '../src/modules/identity/index.ts';
import { makeTestPool } from './pg-helpers.ts';

const NOW = 1_800_000_000_000;

async function seedEveryRecord(store: AiTrainingStore, userId: string): Promise<void> {
  await store.createAsset({ userId, kind: 'dataset', classification: 'private', consent: true, quality: 1, title: 'Asset', description: null, storageKey: 'private/object/key', scrubFindings: [], scrubRedactions: 0, tags: ['export'], now: NOW });
  await store.createDataset({ userId, name: 'dataset', version: 1, fingerprint: 'dataset-fp', itemIds: [], itemCount: 0, parentSnapshotId: null, parentVersion: null, summary: {}, now: NOW });
  await store.createRun({ userId, datasetId: 'dataset-id', datasetVersion: 1, datasetFingerprint: 'dataset-fp', plan: {}, budget: 10, runFingerprint: 'run-fp', codeVersion: 'test', seed: 1, environment: 'test', hyperparams: null, now: NOW });
  await store.createEvalSuite({ userId, suiteId: 'suite', version: 1, kind: 'unit', cases: [], fingerprint: 'suite-fp', now: NOW });
  await store.createPanelVote({ userId, suiteId: 'suite', caseId: 'case', panelist: 'panelist', score: 1, now: NOW });
  await store.createSafetyBattery({ userId, batteryId: 'battery', probes: [], now: NOW });
  await store.createSafetyGrade({ userId, batteryId: 'battery', grade: { score: 1 }, now: NOW });
  await store.createBlindBallot({ userId, contestId: 'contest', voterId: 'voter', preference: 'candidate-a', now: NOW });
  await store.createExperiment({ userId, experimentId: 'experiment', variants: ['a', 'b'], minSamplesPerVariant: 1, active: true, now: NOW });
  await store.createExperimentSubject({ userId, experimentId: 'experiment', subjectUserId: 'subject-user', variantId: 'a', now: NOW });
  await store.createAgentEvent({ userId, agentId: 'agent', outcome: 'completed', reverted: false, approved: true, now: NOW });
  await store.createTrendSample({ userId, metricId: 'loss', bucket: '2026-11-25', score: 0.1, now: NOW });
  await store.createMiningBatch({ userId, batchId: 'mining-batch', cases: [], count: 0, duplicatesDropped: 0, now: NOW });
  await store.createModelVersion({ userId, modelId: 'model', version: 1, stage: 'experimental', owners: ['owner'], lineage: {}, weightsFingerprint: 'weights-fp', fingerprint: 'model-fp', now: NOW });
  await store.createModelCard({ userId, modelId: 'model', version: 1, card: { description: 'test' }, cardFingerprint: 'card-fp', now: NOW });
  await store.createModelPromotion({ userId, modelId: 'model', version: 1, fromStage: 'experimental', toStage: 'staging', promotionFingerprint: 'promotion-fp', now: NOW });
  await store.createServingPlan({ userId, modelId: 'model', kind: 'test', plan: {}, fingerprint: 'serving-fp', now: NOW });
  await store.createModelOpsRecord({ userId, kind: 'metrics', modelId: 'model', record: { latencyMs: 1 }, now: NOW });
  await store.saveModelPin({ userId, modelId: 'model', version: 1, modelTier: 'standard', switchedFrom: null, fingerprint: 'pin-fp', now: NOW });
  await store.saveInstanceReservation({ userId, modelId: 'model', slots: 1, poolTotal: 2, freeAfter: 1, fingerprint: 'reservation-fp', now: NOW });
  await store.createOnPremPackage({ userId, modelId: 'model', version: 1, format: 'safetensors', weightsFingerprint: 'weights-fp', quantized: false, licenseTerms: 'test-only', fingerprint: 'package-fp', now: NOW });
  await store.saveGatewayProvider({ userId, providerId: 'provider', costPer1kIn: 1, costPer1kOut: 1, maxTokens: 100, retentionDays: 1, active: true, now: NOW });
  await store.saveByokKey({ userId, providerId: 'provider', keyFingerprint: 'key-fingerprint-only', keyLength: 32, now: NOW });
  await store.createGatewayUsage({ userId, providerId: 'provider', tokensIn: 1, tokensOut: 1, latencyMs: 1, ok: true, now: NOW });
  await store.createGatewayLog({ id: 'gateway-log', userId, providerId: 'provider', modelId: 'model', prompt: '[redacted]', response: '[redacted]', redactionCount: 2, findings: [], contentOmitted: true, loggedAt: NOW });
  await store.saveCapabilityMatrix({ userId, modelId: 'model', capabilities: ['text'], maxContextTokens: 1024, costPer1kIn: 1, costPer1kOut: 1, active: true, fingerprint: 'capability-fp', now: NOW });
  await store.saveOutputSchema({ userId, schemaId: 'schema', fields: {}, fingerprint: 'schema-fp', now: NOW });
}

function assertCompleteOwnerExport(bundle: Awaited<ReturnType<AiTrainingStore['exportByUser']>>, ownerId: string): void {
  for (const [name, records] of Object.entries(bundle)) {
    assert.equal(records.length, 1, name + ' must be included exactly once');
    assert.ok(records.every((record: { userId: string }) => record.userId === ownerId), name + ' must be owner-scoped');
  }
  assert.equal(bundle.byokKeys[0]?.keyFingerprint, 'key-fingerprint-only');
  assert.equal(bundle.gatewayLogs[0]?.prompt, '[redacted]');
}

describe('AI-training account export enumeration (Hook 16)', () => {
  it('exports every owner-scoped AI-training record from the in-memory store', async () => {
    const store = new InMemoryAiTrainingStore();
    await seedEveryRecord(store, 'owner');
    await store.createAsset({ userId: 'other', kind: 'dataset', classification: 'private', consent: true, quality: 1, title: 'Other account', description: null, storageKey: null, scrubFindings: [], scrubRedactions: 0, tags: [], now: NOW });
    const bundle = await store.exportByUser('owner', 100);
    assertCompleteOwnerExport(bundle, 'owner');
    assert.equal(JSON.stringify(bundle).includes('Other account'), false);
  });

  it('exports every owner-scoped AI-training record from SQLite', async () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      migrate(db, 'ai_training', aiTrainingMigrations);
      const users = new SqliteUserStore(db);
      const owner = await users.create({ email: 'sqlite-ai-export-owner@forge.test', displayName: 'Owner', passwordHash: 'test-hash', now: NOW });
      const other = await users.create({ email: 'sqlite-ai-export-other@forge.test', displayName: 'Other', passwordHash: 'test-hash', now: NOW });
      const store = new SqliteAiTrainingStore(db);
      await seedEveryRecord(store, owner.id);
      await store.createAsset({ userId: other.id, kind: 'dataset', classification: 'private', consent: true, quality: 1, title: 'Other account', description: null, storageKey: null, scrubFindings: [], scrubRedactions: 0, tags: [], now: NOW });
      const bundle = await store.exportByUser(owner.id, 100);
      assertCompleteOwnerExport(bundle, owner.id);
      assert.equal(JSON.stringify(bundle).includes('Other account'), false);
    } finally {
      db.close();
    }
  });

  it('exports every owner-scoped AI-training record from PostgreSQL', async () => {
    const t = await makeTestPool();
    try {
      await migratePostgres(t.pool, 'ai_training', pgAiTrainingMigrations);
      const users = new PostgresUserStore(t.pool);
      const owner = await users.create({ email: 'pg-ai-export-owner@forge.test', displayName: 'Owner', passwordHash: 'test-hash', now: NOW });
      const other = await users.create({ email: 'pg-ai-export-other@forge.test', displayName: 'Other', passwordHash: 'test-hash', now: NOW });
      const store = new PostgresAiTrainingStore(t.pool);
      await seedEveryRecord(store, owner.id);
      await store.createAsset({ userId: other.id, kind: 'dataset', classification: 'private', consent: true, quality: 1, title: 'Other account', description: null, storageKey: null, scrubFindings: [], scrubRedactions: 0, tags: [], now: NOW });
      const bundle = await store.exportByUser(owner.id, 100);
      assertCompleteOwnerExport(bundle, owner.id);
      assert.equal(JSON.stringify(bundle).includes('Other account'), false);
    } finally {
      await t.pool.end();
      await t.cleanup();
    }
  });
});
