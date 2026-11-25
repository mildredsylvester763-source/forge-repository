import { createHash } from 'node:crypto';

/**
 * CO-096 — the off-site upload manifest and receipt verification.
 *
 * A backup that never left the machine is not a backup. The manifest is the small,
 * verifiable record of WHAT was uploaded WHERE, and the receipt check proves the
 * upload that came back is the upload that was sent. Pure functions: the actual
 * transfer is the R2 adapter's job (same S3 API as the anchor), driven by ops.
 */

export interface BackupArtifact {
  /** Backup file name, e.g. forge-20261111T000000000Z.sqlite */
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly createdAt: string;
}

export interface OffsiteTarget {
  /** e.g. r2 */
  readonly kind: string;
  readonly bucket: string;
  /** Object key the artifact is stored under, e.g. backups/forge-20261111T000000000Z.sqlite */
  readonly key: string;
}

export interface UploadManifest {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly target: OffsiteTarget;
  readonly uploadedAt: string;
  /** sha256 over the canonical manifest WITHOUT this field — the manifest checks itself. */
  readonly manifestChecksum: string;
}

export type ManifestBuild =
  | { ok: true; value: Omit<UploadManifest, 'manifestChecksum'> }
  | { ok: false; reason: string };

const BACKUP_NAME = /^forge-\d{8}T\d{9}Z\.sqlite$/;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Pure: builds the upload manifest for one verified backup (checksum added by sealUploadManifest). */
export function buildUploadManifest(artifact: BackupArtifact, target: OffsiteTarget, now: Date): ManifestBuild {
  if (!BACKUP_NAME.test(artifact.name)) return { ok: false, reason: 'manifest_bad_backup_name' };
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) return { ok: false, reason: 'manifest_bad_checksum' };
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) return { ok: false, reason: 'manifest_bad_size' };
  if (Number.isNaN(Date.parse(artifact.createdAt))) return { ok: false, reason: 'manifest_bad_created_at' };
  if (!target.bucket || !target.key) return { ok: false, reason: 'manifest_bad_target' };
  if (!target.key.endsWith(artifact.name)) return { ok: false, reason: 'manifest_key_artifact_mismatch' };
  return {
    ok: true,
    value: {
      name: artifact.name,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      createdAt: artifact.createdAt,
      target,
      uploadedAt: now.toISOString(),
    },
  };
}

/** Pure: seals a built manifest with its self-checksum. */
export function sealUploadManifest(manifest: Omit<UploadManifest, 'manifestChecksum'>): UploadManifest {
  return { ...manifest, manifestChecksum: sha256Hex(stableStringify(manifest)) };
}

export interface UploadReceipt {
  readonly key: string;
  readonly bytes: number;
  readonly uploadedAt: string;
}

export type ReceiptCheck = { ok: true } | { ok: false; reason: string };

/** Pure: proves the provider's receipt matches what the manifest says was sent. */
export function verifyUploadReceipt(manifest: UploadManifest, receipt: UploadReceipt): ReceiptCheck {
  if (receipt.key !== manifest.target.key) return { ok: false, reason: 'receipt_key_mismatch' };
  if (receipt.bytes !== manifest.bytes) return { ok: false, reason: 'receipt_size_mismatch' };
  if (Number.isNaN(Date.parse(receipt.uploadedAt))) return { ok: false, reason: 'receipt_bad_uploaded_at' };
  return { ok: true };
}

/** Pure: re-checks a manifest's own checksum (detects a manifest edited in flight). */
export function verifyManifestIntegrity(manifest: UploadManifest): ReceiptCheck {
  const { manifestChecksum, ...rest } = manifest;
  if (!/^[a-f0-9]{64}$/.test(manifestChecksum)) return { ok: false, reason: 'manifest_checksum_missing' };
  if (sha256Hex(stableStringify(rest)) !== manifestChecksum) return { ok: false, reason: 'manifest_checksum_mismatch' };
  return { ok: true };
}
