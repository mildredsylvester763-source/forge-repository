import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildUploadManifest,
  sealUploadManifest,
  verifyManifestIntegrity,
  verifyUploadReceipt,
  type UploadManifest,
} from '../src/kernel/backup-offsite.ts';

const artifact = {
  name: 'forge-20261111T000000000Z.sqlite',
  sha256: 'a'.repeat(64),
  bytes: 123_456,
  createdAt: '2026-11-11T00:00:00.000Z',
};
const target = { kind: 'r2', bucket: 'forge-backups', key: 'backups/forge-20261111T000000000Z.sqlite' };

function built(): Omit<UploadManifest, 'manifestChecksum'> {
  const result = buildUploadManifest(artifact, target, new Date(1_000));
  assert.ok(result.ok);
  return (result as { ok: true; value: Omit<UploadManifest, 'manifestChecksum'> }).value;
}

describe('CO-096 upload manifest build', () => {
  it('builds a manifest for a verified backup and refuses every bad input by name', () => {
    const manifest = built();
    assert.equal(manifest.target.bucket, 'forge-backups');
    assert.equal(manifest.uploadedAt, new Date(1_000).toISOString());
    assert.match(JSON.stringify(buildUploadManifest({ ...artifact, name: 'dump.sqlite' }, target, new Date(1_000))), /manifest_bad_backup_name/);
    assert.match(JSON.stringify(buildUploadManifest({ ...artifact, sha256: 'nothex' }, target, new Date(1_000))), /manifest_bad_checksum/);
    assert.match(JSON.stringify(buildUploadManifest({ ...artifact, bytes: 0 }, target, new Date(1_000))), /manifest_bad_size/);
    assert.match(JSON.stringify(buildUploadManifest({ ...artifact, bytes: 1.5 }, target, new Date(1_000))), /manifest_bad_size/);
    assert.match(JSON.stringify(buildUploadManifest({ ...artifact, createdAt: 'yesterday' }, target, new Date(1_000))), /manifest_bad_created_at/);
    assert.match(JSON.stringify(buildUploadManifest(artifact, { ...target, bucket: '' }, new Date(1_000))), /manifest_bad_target/);
    assert.match(JSON.stringify(buildUploadManifest(artifact, { ...target, key: 'other/file.sqlite' }, new Date(1_000))), /manifest_key_artifact_mismatch/);
  });
});

describe('CO-096 manifest integrity and receipt verification', () => {
  it('a sealed manifest verifies; an edited one does not', () => {
    const manifest = sealUploadManifest(built());
    assert.deepEqual(verifyManifestIntegrity(manifest), { ok: true });
    const edited = { ...manifest, bytes: 1 };
    assert.match(JSON.stringify(verifyManifestIntegrity(edited)), /manifest_checksum_mismatch/);
    const unsealed = { ...manifest, manifestChecksum: 'z'.repeat(64) };
    assert.match(JSON.stringify(verifyManifestIntegrity(unsealed)), /manifest_checksum_missing/);
  });

  it('the receipt must match the manifest exactly', () => {
    const manifest = sealUploadManifest(built());
    assert.deepEqual(verifyUploadReceipt(manifest, { key: manifest.target.key, bytes: manifest.bytes, uploadedAt: '2026-11-11T00:05:00.000Z' }), { ok: true });
    assert.match(JSON.stringify(verifyUploadReceipt(manifest, { key: 'backups/other.sqlite', bytes: manifest.bytes, uploadedAt: '2026-11-11T00:05:00.000Z' })), /receipt_key_mismatch/);
    assert.match(JSON.stringify(verifyUploadReceipt(manifest, { key: manifest.target.key, bytes: 1, uploadedAt: '2026-11-11T00:05:00.000Z' })), /receipt_size_mismatch/);
    assert.match(JSON.stringify(verifyUploadReceipt(manifest, { key: manifest.target.key, bytes: manifest.bytes, uploadedAt: 'soon' })), /receipt_bad_uploaded_at/);
  });

  it('sealing is deterministic: the same manifest seals to the same checksum', () => {
    assert.equal(sealUploadManifest(built()).manifestChecksum, sealUploadManifest(built()).manifestChecksum);
  });
});
