import { verifyAccessSnapshot as verifySnapshotShape, type AccessSnapshot } from './engine/access-snapshot-engine.ts';

export interface ClientAccessSnapshotEnvelope {
  readonly snapshot: AccessSnapshot;
  readonly publicKey: string;
  readonly publicSignature: string;
}

export interface CachedAccessSnapshot {
  readonly userId: string;
  readonly snapshot: AccessSnapshot;
  readonly publicKey: string;
  readonly publicSignature: string;
  /** Server time minus local time at the request start; protected by the secure store. */
  readonly serverTimeOffsetMs: number;
  /** Last accepted local wall-clock value, used to reject clock rollback between offline reads. */
  readonly lastLocalNow: number;
}

/** Implement with Keychain/Keystore or an equivalent encrypted, device-protected store. */
export interface AccessSnapshotSecureStore {
  get(userId: string): Promise<CachedAccessSnapshot | null>;
  set(userId: string, snapshot: CachedAccessSnapshot): Promise<void>;
  clear(userId: string): Promise<void>;
}

/** The transport must use authenticated TLS and map only genuine connectivity loss to OfflineError. */
export interface AccessSnapshotTransport {
  fetch(userId: string): Promise<ClientAccessSnapshotEnvelope>;
}

export interface AccessSnapshotSignatureVerifier {
  verify(snapshot: AccessSnapshot, publicSignature: string, publicKey: string): Promise<boolean> | boolean;
}

export interface AccessSnapshotClock {
  now(): number;
}

export class AccessSnapshotOfflineError extends Error {
  constructor(message = 'Access snapshot endpoint is offline') { super(message); this.name = 'AccessSnapshotOfflineError'; }
}

export class AccessSnapshotRejectedError extends Error {
  constructor(message = 'The server rejected this account or access snapshot') { super(message); this.name = 'AccessSnapshotRejectedError'; }
}

export class AccessSnapshotUnavailableError extends Error {
  constructor(message = 'No unexpired offline access snapshot is available') { super(message); this.name = 'AccessSnapshotUnavailableError'; }
}

export class AccessSnapshotInvalidError extends Error {
  constructor(message = 'The cached access snapshot is invalid') { super(message); this.name = 'AccessSnapshotInvalidError'; }
}

export interface ClientAccessResult {
  readonly snapshot: AccessSnapshot;
  readonly remainingMs: number;
  readonly source: 'network' | 'cache';
  /** False only when the online snapshot was valid but secure persistence failed. */
  readonly cachePersisted: boolean;
}

/**
 * Platform-neutral Hook 9 client lifecycle. The host must provide authenticated HTTPS
 * transport, a public-key signature verifier and a secure persistent store. HMAC secrets
 * never enter the client. Only a verified, unexpired snapshot can grant offline access.
 */
export class ClientAccessSnapshotCache {
  private readonly store: AccessSnapshotSecureStore;
  private readonly transport: AccessSnapshotTransport;
  private readonly verifier: AccessSnapshotSignatureVerifier;
  private readonly clock: AccessSnapshotClock;

  constructor(deps: { store: AccessSnapshotSecureStore; transport: AccessSnapshotTransport; verifier: AccessSnapshotSignatureVerifier; clock: AccessSnapshotClock }) {
    this.store = deps.store;
    this.transport = deps.transport;
    this.verifier = deps.verifier;
    this.clock = deps.clock;
  }

  /** Prefer a fresh server snapshot; use the cache only for a classified connectivity failure. */
  async getAccess(userId: string): Promise<ClientAccessResult> {
    this.assertUserId(userId);
    const requestStartedAt = this.clock.now();
    try {
      const envelope = await this.transport.fetch(userId);
      const responseReceivedAt = this.clock.now();
      return await this.acceptRemote(userId, envelope, requestStartedAt, responseReceivedAt);
    } catch (error) {
      if (error instanceof AccessSnapshotOfflineError) return this.readCached(userId);
      if (error instanceof AccessSnapshotRejectedError) await this.store.clear(userId);
      throw error;
    }
  }

  /** Read a cached snapshot without attempting a network request. */
  async readCached(userId: string): Promise<ClientAccessResult> {
    this.assertUserId(userId);
    const cached = await this.store.get(userId);
    if (cached === null) throw new AccessSnapshotUnavailableError();
    if (cached.userId !== userId || cached.snapshot.userId !== userId || !Number.isSafeInteger(cached.lastLocalNow) || !Number.isSafeInteger(cached.serverTimeOffsetMs)) {
      await this.store.clear(userId);
      throw new AccessSnapshotInvalidError('Cached snapshot belongs to a different account');
    }
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || now < cached.lastLocalNow) {
      await this.store.clear(userId);
      throw new AccessSnapshotInvalidError('Local clock moved backwards or cached time metadata is invalid');
    }
    let signatureValid = false;
    try { signatureValid = await this.verifier.verify(cached.snapshot, cached.publicSignature, cached.publicKey); } catch { signatureValid = false; }
    if (!signatureValid) {
      await this.store.clear(userId);
      throw new AccessSnapshotInvalidError('Cached snapshot signature is invalid');
    }
    const estimatedServerNow = now + cached.serverTimeOffsetMs;
    if (!Number.isSafeInteger(estimatedServerNow) || estimatedServerNow < 0) {
      await this.store.clear(userId);
      throw new AccessSnapshotInvalidError('Cached server-time estimate is invalid');
    }
    const checked = verifySnapshotShape(cached.snapshot, estimatedServerNow);
    if (!checked.ok) {
      await this.store.clear(userId);
      if (checked.reason.startsWith('snapshot-expired:')) throw new AccessSnapshotUnavailableError('Cached access snapshot has expired');
      throw new AccessSnapshotInvalidError(checked.reason);
    }
    await this.store.set(userId, { ...cached, lastLocalNow: now });
    return { snapshot: checked.value.snapshot, remainingMs: checked.value.remainingMs, source: 'cache', cachePersisted: true };
  }

  /** Call on sign-out, account switch, device revocation or an explicit local reset. */
  async clear(userId: string): Promise<void> {
    this.assertUserId(userId);
    await this.store.clear(userId);
  }

  private async acceptRemote(userId: string, envelope: ClientAccessSnapshotEnvelope, requestStartedAt: number, responseReceivedAt: number): Promise<ClientAccessResult> {
    if (!Number.isSafeInteger(requestStartedAt) || !Number.isSafeInteger(responseReceivedAt) || responseReceivedAt < requestStartedAt) {
      await this.store.clear(userId);
      throw new AccessSnapshotInvalidError('Local clock changed during snapshot refresh');
    }
    if (typeof envelope !== 'object' || envelope === null || typeof envelope.publicKey !== 'string' || typeof envelope.publicSignature !== 'string' || typeof envelope.snapshot !== 'object' || envelope.snapshot === null || envelope.snapshot.userId !== userId) {
      await this.store.clear(userId);
      throw new AccessSnapshotInvalidError('Server returned a snapshot for a different account');
    }
    let signatureValid = false;
    try { signatureValid = await this.verifier.verify(envelope.snapshot, envelope.publicSignature, envelope.publicKey); } catch { signatureValid = false; }
    if (!signatureValid) {
      await this.store.clear(userId);
      throw new AccessSnapshotInvalidError('Server snapshot signature is invalid');
    }
    // Using request start makes the estimate conservative: network latency consumes, rather than extends, the TTL.
    const serverTimeOffsetMs = envelope.snapshot.issuedAt - requestStartedAt;
    if (!Number.isSafeInteger(serverTimeOffsetMs)) {
      await this.store.clear(userId);
      throw new AccessSnapshotInvalidError('Server-time offset is invalid');
    }
    const estimatedServerNow = responseReceivedAt + serverTimeOffsetMs;
    const checked = verifySnapshotShape(envelope.snapshot, estimatedServerNow);
    if (!checked.ok) {
      await this.store.clear(userId);
      throw new AccessSnapshotInvalidError(checked.reason);
    }
    const cached: CachedAccessSnapshot = {
      userId, snapshot: envelope.snapshot, publicKey: envelope.publicKey, publicSignature: envelope.publicSignature,
      serverTimeOffsetMs, lastLocalNow: responseReceivedAt,
    };
    let cachePersisted = true;
    try { await this.store.set(userId, cached); } catch {
      await this.store.clear(userId);
      cachePersisted = false;
    }
    return { snapshot: checked.value.snapshot, remainingMs: checked.value.remainingMs, source: 'network', cachePersisted };
  }

  private assertUserId(userId: string): void {
    if (typeof userId !== 'string' || userId.trim() === '') throw new AccessSnapshotInvalidError('A user id is required');
  }
}
