import { createHash } from 'node:crypto';

export interface AccountArtifactReference {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: 'training_asset' | 'model_weights' | 'on_prem_package';
  /** Server-only locator. It is never copied into the exported response. */
  readonly locator: Readonly<Record<string, string | number>>;
}

export interface ExportedAccountArtifact {
  readonly artifactId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly contentBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface AccountArtifactProviderResult {
  readonly artifacts: readonly ExportedAccountArtifact[];
  readonly omittedArtifactIds: readonly string[];
}

/**
 * Server-side adapter contract for exporting bytes held outside the application database.
 * Implementations must enforce owner-scoped retrieval; the core also validates every returned
 * ID, byte length and SHA-256 digest before the bytes enter the account export.
 */
export interface AccountArtifactExportProvider {
  exportByUser(userId: string, references: readonly AccountArtifactReference[]): Promise<AccountArtifactProviderResult>;
}

export interface AccountArtifactExportResult extends AccountArtifactProviderResult {
  readonly complete: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new Error('account artifact export provider returned invalid data: ' + message);
}

/** Resolve and verify external bytes for one authenticated account. No storage locator is returned. */
export async function exportAccountArtifacts(
  userId: string,
  references: readonly AccountArtifactReference[],
  provider: AccountArtifactExportProvider | null,
): Promise<AccountArtifactExportResult> {
  if (typeof userId !== 'string' || userId.trim() === '') invalid('user id is required');
  const expected = new Map<string, AccountArtifactReference>();
  for (const reference of references) {
    if (!isRecord(reference) || reference.ownerId !== userId || typeof reference.id !== 'string' || reference.id.length === 0) {
      invalid('artifact references must be owner-scoped and identified');
    }
    if (expected.has(reference.id)) invalid('duplicate artifact reference');
    expected.set(reference.id, reference);
  }

  if (expected.size === 0) return { artifacts: [], omittedArtifactIds: [], complete: true };
  if (provider === null) return { artifacts: [], omittedArtifactIds: [...expected.keys()].sort(), complete: false };

  const result: unknown = await provider.exportByUser(userId, [...expected.values()]);
  if (!isRecord(result) || !Array.isArray(result.artifacts) || !Array.isArray(result.omittedArtifactIds)) {
    invalid('artifacts and omittedArtifactIds arrays are required');
  }

  const exported = new Set<string>();
  const artifacts: ExportedAccountArtifact[] = [];
  for (const raw of result.artifacts) {
    if (!isRecord(raw)) invalid('artifact entry must be an object');
    const artifactId = raw.artifactId;
    const filename = raw.filename;
    const mediaType = raw.mediaType;
    const contentBase64 = raw.contentBase64;
    const byteLength = raw.byteLength;
    const sha256 = raw.sha256;
    if (typeof artifactId !== 'string' || !expected.has(artifactId) || exported.has(artifactId)) invalid('unexpected or duplicate artifact id');
    if (typeof filename !== 'string' || filename.length < 1 || filename.length > 255 || filename === '.' || filename === '..' || /[\\/\u0000-\u001f]/.test(filename)) invalid('unsafe artifact filename');
    if (typeof mediaType !== 'string' || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mediaType)) invalid('invalid media type');
    if (typeof contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) invalid('artifact content must be canonical base64');
    const bytes = Buffer.from(contentBase64, 'base64');
    if (bytes.toString('base64') !== contentBase64) invalid('artifact base64 is not canonical');
    if (!Number.isSafeInteger(byteLength) || byteLength !== bytes.byteLength) invalid('artifact byte length does not match content');
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) invalid('artifact SHA-256 is invalid');
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== sha256) invalid('artifact SHA-256 does not match content');
    exported.add(artifactId);
    artifacts.push({ artifactId, filename, mediaType, contentBase64, byteLength, sha256 });
  }

  const omitted = new Set<string>();
  for (const id of result.omittedArtifactIds) {
    if (typeof id !== 'string' || !expected.has(id) || omitted.has(id) || exported.has(id)) invalid('unexpected or duplicate omitted artifact id');
    omitted.add(id);
  }
  if (exported.size + omitted.size !== expected.size) invalid('every referenced artifact must be exported or explicitly omitted');
  return {
    artifacts: artifacts.sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
    omittedArtifactIds: [...omitted].sort(),
    complete: omitted.size === 0,
  };
}
