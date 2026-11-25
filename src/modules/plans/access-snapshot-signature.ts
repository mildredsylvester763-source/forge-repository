import { createHmac, createPrivateKey, createPublicKey, sign as signDetached, verify as verifyDetached } from 'node:crypto';
import type { AccessSnapshot } from './engine/access-snapshot-engine.ts';

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const MIN_SECRET_BYTES = 32;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('access snapshot contains a non-JSON value');
    return encoded;
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}';
}

function privateKeyFromSecret(secret: Buffer) {
  if (!Buffer.isBuffer(secret) || secret.length < MIN_SECRET_BYTES) {
    throw new Error('access snapshot signing secret must contain at least 32 bytes');
  }
  const seed = createHmac('sha256', secret).update('FORGE_ACCESS_SNAPSHOT_ED25519_V1', 'utf8').digest();
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export interface PublicAccessSnapshotSignature {
  readonly publicKey: string;
  readonly publicSignature: string;
}

/**
 * Create a client-verifiable Ed25519 signature. The private key is derived with
 * domain separation from the server-only access secret; only the public key leaves
 * the server. The public key is delivered over the authenticated API transport and
 * cached alongside the signed snapshot in platform secure storage.
 */
export function signAccessSnapshot(secret: Buffer, snapshot: AccessSnapshot): PublicAccessSnapshotSignature {
  const privateKey = privateKeyFromSecret(secret);
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url');
  const publicSignature = signDetached(null, Buffer.from(canonicalJson(snapshot), 'utf8'), privateKey).toString('base64url');
  return { publicKey, publicSignature };
}

/** Verify an offline snapshot without exposing the signing secret to the client. */
export function verifyAccessSnapshotSignature(snapshot: unknown, publicKey: string, publicSignature: string): boolean {
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]+$/.test(publicKey) || typeof publicSignature !== 'string' || !/^[A-Za-z0-9_-]+$/.test(publicSignature)) return false;
  try {
    const keyBytes = Buffer.from(publicKey, 'base64url');
    const signatureBytes = Buffer.from(publicSignature, 'base64url');
    if (keyBytes.length !== 44 || signatureBytes.length !== 64) return false;
    const key = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
    return verifyDetached(null, Buffer.from(canonicalJson(snapshot), 'utf8'), key, signatureBytes);
  } catch {
    return false;
  }
}
