import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { encodeBase32, generateTotpSecret, totpProvisioningUri, verifyTotpCode, type TotpOptions } from './totp.ts';
import type { TotpFactorRecord, TotpFactorStore } from './totp-store.ts';

export class TotpFactorError extends Error {
  readonly code: 'factor_exists' | 'factor_missing' | 'factor_not_active' | 'secret_unavailable';

  constructor(code: TotpFactorError['code'], message: string) {
    super(message);
    this.name = 'TotpFactorError';
    this.code = code;
  }
}

export interface TotpEnrollmentStart {
  readonly secret: string;
  readonly provisioningUri: string;
  readonly expiresAt: string;
}

function validateUserId(userId: string): void {
  if (typeof userId !== 'string' || userId.length < 1 || userId.length > 128) throw new TypeError('TOTP user ID is invalid');
}

function associatedData(userId: string): Buffer {
  return Buffer.from('FORGE:TOTP:secret:v1:' + userId, 'utf8');
}

export class TotpFactorService {
  private readonly store: TotpFactorStore;
  private readonly key: Buffer;
  private readonly clock: () => number;
  private readonly issuer: string;
  private readonly options: TotpOptions;
  private readonly windowSteps: number;
  private readonly enrollmentTtlMs: number;

  constructor(options: {
    store: TotpFactorStore;
    encryptionKey: Uint8Array;
    clock: () => number;
    issuer: string;
    totp: TotpOptions;
    windowSteps: number;
    enrollmentTtlMs?: number;
  }) {
    if (options.encryptionKey.length !== 32) throw new TypeError('TOTP encryption key must be exactly 32 bytes');
    if (typeof options.issuer !== 'string' || !options.issuer.trim() || options.issuer.length > 128) {
      throw new TypeError('TOTP issuer is invalid');
    }
    if (!Number.isSafeInteger(options.windowSteps) || options.windowSteps < 0 || options.windowSteps > 2) {
      throw new TypeError('TOTP verification window must be between 0 and 2 steps');
    }
    this.enrollmentTtlMs = options.enrollmentTtlMs ?? 600_000;
    if (!Number.isSafeInteger(this.enrollmentTtlMs) || this.enrollmentTtlMs < 60_000 || this.enrollmentTtlMs > 1_800_000) {
      throw new TypeError('TOTP enrollment lifetime must be between 1 and 30 minutes');
    }
    this.store = options.store;
    this.key = Buffer.from(options.encryptionKey);
    this.clock = options.clock;
    this.issuer = options.issuer;
    this.options = { ...options.totp };
    this.windowSteps = options.windowSteps;
    // Validate the option tuple through the same URI builder used during enrollment.
    totpProvisioningUri(this.issuer, 'validation', generateTotpSecret(), this.options);
  }

  private encrypt(userId: string, secret: Uint8Array): { encryptedSecret: string; iv: string; authTag: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(associatedData(userId));
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
    return {
      encryptedSecret: encrypted.toString('base64url'),
      iv: iv.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
    };
  }

  private decrypt(record: TotpFactorRecord): Buffer {
    try {
      const iv = Buffer.from(record.iv, 'base64url');
      const tag = Buffer.from(record.authTag, 'base64url');
      const ciphertext = Buffer.from(record.encryptedSecret, 'base64url');
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 20 || ciphertext.length > 64) {
        throw new Error('invalid encrypted TOTP metadata');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(associatedData(record.userId));
      decipher.setAuthTag(tag);
      const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (secret.length < 20 || secret.length > 64) throw new Error('invalid decrypted TOTP secret size');
      return secret;
    } catch {
      throw new TotpFactorError('secret_unavailable', 'The TOTP factor secret could not be decrypted.');
    }
  }

  async beginEnrollment(userId: string, accountName: string): Promise<TotpEnrollmentStart> {
    validateUserId(userId);
    const now = this.clock();
    await this.store.deleteExpiredPending(userId, now);
    const secret = generateTotpSecret();
    const encrypted = this.encrypt(userId, secret);
    const record: TotpFactorRecord = {
      userId,
      ...encrypted,
      options: this.options,
      status: 'pending',
      createdAt: now,
      expiresAt: now + this.enrollmentTtlMs,
      confirmedAt: null,
      lastAcceptedStep: -1,
    };
    if (!await this.store.createPending(record)) {
      throw new TotpFactorError('factor_exists', 'A TOTP factor is already enrolled or pending for this account.');
    }
    return {
      secret: encodeBase32(secret),
      provisioningUri: totpProvisioningUri(this.issuer, accountName, secret, this.options),
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  async confirmEnrollment(userId: string, candidate: string): Promise<boolean> {
    validateUserId(userId);
    const record = await this.store.findForUser(userId);
    if (!record || record.status !== 'pending') return false;
    const now = this.clock();
    if (record.expiresAt <= now) {
      await this.store.deleteExpiredPending(userId, now);
      return false;
    }
    const secret = this.decrypt(record);
    const match = verifyTotpCode(secret, candidate, now, record.options, this.windowSteps);
    if (!match) return false;
    return this.store.activatePending(userId, record.createdAt, match.matchedStep, now);
  }

  async verifyAndConsume(userId: string, candidate: string): Promise<boolean> {
    validateUserId(userId);
    const record = await this.store.findForUser(userId);
    if (!record || record.status !== 'active') return false;
    const secret = this.decrypt(record);
    const match = verifyTotpCode(secret, candidate, this.clock(), record.options, this.windowSteps);
    if (!match || match.matchedStep <= record.lastAcceptedStep) return false;
    return this.store.consumeStep(userId, record.lastAcceptedStep, match.matchedStep, this.clock());
  }

  async disable(userId: string, candidate: string): Promise<boolean> {
    if (!await this.verifyAndConsume(userId, candidate)) return false;
    return this.store.deleteActive(userId);
  }

  async cancelEnrollment(userId: string): Promise<boolean> {
    validateUserId(userId);
    return this.store.deletePending(userId);
  }

  async status(userId: string): Promise<'disabled' | 'pending' | 'active'> {
    validateUserId(userId);
    const record = await this.store.findForUser(userId);
    if (!record) return 'disabled';
    if (record.status === 'pending' && record.expiresAt <= this.clock()) {
      await this.store.deleteExpiredPending(userId, this.clock());
      return 'disabled';
    }
    return record.status;
  }
}
