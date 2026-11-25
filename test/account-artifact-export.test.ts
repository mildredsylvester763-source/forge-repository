import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { GOOD_PASSWORD, sessionCookie, startHarness } from './helpers.ts';
import { SqliteAiTrainingStore } from '../src/modules/ai-training/index.ts';
import type { AccountArtifactExportProvider } from '../src/modules/plans/index.ts';

async function signedInUser(h: Awaited<ReturnType<typeof startHarness>>, email: string): Promise<string> {
  const registered = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'Artifact Export Tester' });
  assert.equal(registered.status, 201);
  const signedIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signedIn.status, 200);
  return sessionCookie(signedIn);
}

describe('Hook 16 external artifact export contract', () => {
  it('exports owner-scoped training assets, model weights and on-prem packages with verified bytes', async () => {
    const bytes = Buffer.from('private artifact bytes');
    const provider: AccountArtifactExportProvider = {
      exportByUser: async (userId, references) => {
        assert.ok(userId.length > 0);
        assert.equal(references.length, 3);
        assert.ok(references.every((reference) => reference.ownerId === userId));
        assert.equal(references.find((reference) => reference.kind === 'training_asset')?.locator.storageKey, 'private/object/key');
        return {
          artifacts: references.map((reference) => ({
            artifactId: reference.id,
            filename: reference.kind + '.bin',
            mediaType: 'application/octet-stream',
            contentBase64: bytes.toString('base64'),
            byteLength: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          })),
          omittedArtifactIds: [],
        };
      },
    };
    const h = await startHarness({ FORGE_DATABASE_PATH: ':memory:' }, { signInPerMinute: 100_000, registerPerMinute: 100_000 }, { accountArtifactExport: provider });
    try {
      const cookie = await signedInUser(h, 'artifact-export-owner@forge.test');
      const db = h.app.db;
      assert.ok(db);
      const store = new SqliteAiTrainingStore(db);
      const user = await h.app.identity.authenticate(cookie);
      assert.ok(user);
      await store.createAsset({
        userId: user.user.id, kind: 'dataset', classification: 'private', consent: true, quality: 1,
        title: 'Private dataset', description: null, storageKey: 'private/object/key',
        scrubFindings: [], scrubRedactions: 0, tags: ['export'], now: h.clock.now,
      });
      await store.createModelVersion({
        userId: user.user.id, modelId: 'model-a', version: 1, stage: 'experimental', owners: ['owner'],
        lineage: {}, weightsFingerprint: 'weights-fingerprint', fingerprint: 'model-fingerprint', now: h.clock.now,
      });
      await store.createOnPremPackage({
        userId: user.user.id, modelId: 'model-a', version: 1, format: 'safetensors',
        weightsFingerprint: 'weights-fingerprint', quantized: false, licenseTerms: 'test fixture',
        fingerprint: 'package-fingerprint', now: h.clock.now,
      });

      const response = await h.post('/v1/account/export', {}, { cookie });
      assert.equal(response.status, 200);
      const bundle = await response.json() as {
        artifacts: Array<{ artifactId: string; contentBase64: string; byteLength: number; sha256: string }>;
        modules: { aiTraining: { assets: Array<Record<string, unknown>> } };
        exportCoverage: { complete: boolean; omitted: string[] };
      };
      assert.equal(bundle.artifacts.length, 3);
      assert.ok(bundle.artifacts.every((artifact) => artifact.contentBase64 === bytes.toString('base64')));
      assert.ok(bundle.artifacts.every((artifact) => artifact.byteLength === bytes.byteLength));
      assert.ok(bundle.artifacts.every((artifact) => artifact.sha256 === createHash('sha256').update(bytes).digest('hex')));
      assert.equal(bundle.exportCoverage.complete, true);
      assert.equal(bundle.exportCoverage.omitted.some((item) => item.includes('artifact')), false);
      assert.equal(Object.hasOwn(bundle.modules.aiTraining.assets[0] ?? {}, 'storageKey'), false);
      assert.equal(JSON.stringify(bundle).includes('private/object/key'), false);
    } finally {
      await h.close();
    }
  });

  it('reports external artifacts as omitted when no storage adapter is configured', async () => {
    const h = await startHarness({ FORGE_DATABASE_PATH: ':memory:' });
    try {
      const cookie = await signedInUser(h, 'artifact-export-missing-provider@forge.test');
      const db = h.app.db;
      assert.ok(db);
      const store = new SqliteAiTrainingStore(db);
      const user = await h.app.identity.authenticate(cookie);
      assert.ok(user);
      await store.createAsset({
        userId: user.user.id, kind: 'dataset', classification: 'private', consent: true, quality: 1,
        title: 'Private dataset', description: null, storageKey: 'private/object/key',
        scrubFindings: [], scrubRedactions: 0, tags: [], now: h.clock.now,
      });
      const response = await h.post('/v1/account/export', {}, { cookie });
      assert.equal(response.status, 200);
      const bundle = await response.json() as { artifacts: unknown[]; exportCoverage: { complete: boolean; omitted: string[] } };
      assert.equal(bundle.artifacts.length, 0);
      assert.equal(bundle.exportCoverage.complete, false);
      assert.ok(bundle.exportCoverage.omitted.some((item) => item.includes('1 referenced artifact')));
      assert.equal(JSON.stringify(bundle).includes('private/object/key'), false);
    } finally {
      await h.close();
    }
  });
});
