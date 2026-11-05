import { createHash } from 'node:crypto';
import { AppError } from '../../kernel/errors.ts';
import type { EventDraft } from '../../kernel/events.ts';
import type { Clock } from '../../kernel/clock.ts';
import type { IdentityService, PublicUser, RequestMeta, SignInResult } from './identity-service.ts';
import { IdentityEvents, IDENTITY_EVENT_VERSION } from './events.ts';
import {
  createPasskeyAuthenticationOptions,
  createPasskeyChallenge,
  createPasskeyRegistrationOptions,
  extractPasskeyChallenge,
  verifyPasskeyAssertion,
  verifyPasskeyRegistration,
  validateWebAuthnConfig,
  WebAuthnError,
  type PasskeyAssertionResponse,
  type PasskeyRegistrationResponse,
  type WebAuthnConfig,
} from './webauthn.ts';
import { PasskeyCredentialExistsError, type PasskeyCredentialRecord, type PasskeyStore } from './passkey-store.ts';

const CHALLENGE_TTL_MS = 5 * 60_000;
const INVALID_CREDENTIALS = () => new AppError(401, 'invalid_credentials', 'Invalid passkey credentials.');

export interface PasskeyServiceConfig {
  readonly rpId: string | null;
  readonly origins: readonly string[];
  readonly rpName: string;
}
export interface PublicPasskey {
  readonly credentialId: string;
  readonly algorithm: number;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  readonly transports: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

function challengeDigest(challenge: string): string {
  return createHash('sha256').update(challenge, 'utf8').digest('hex');
}
function credentialReference(credentialId: string): string {
  return createHash('sha256').update(credentialId, 'utf8').digest('hex').slice(0, 20);
}
function webAuthnRequestError(error: unknown): AppError {
  if (error instanceof WebAuthnError) {
    return new AppError(400, 'invalid_passkey_response', 'The passkey response could not be verified.', {
      details: { reason: error.code },
    });
  }
  return new AppError(400, 'invalid_passkey_response', 'The passkey response could not be verified.');
}
function publicRecord(record: PasskeyCredentialRecord): PublicPasskey {
  return {
    credentialId: record.credentialId,
    algorithm: record.algorithm,
    backupEligible: record.backupEligible,
    backedUp: record.backedUp,
    transports: [...record.transports],
    createdAt: new Date(record.createdAt).toISOString(),
    lastUsedAt: record.lastUsedAt === null ? null : new Date(record.lastUsedAt).toISOString(),
  };
}

export class PasskeyService {
  private readonly store: PasskeyStore;
  private readonly identity: IdentityService;
  private readonly clock: Clock;
  private readonly config: PasskeyServiceConfig;

  constructor(options: { store: PasskeyStore; identity: IdentityService; clock: Clock; config: PasskeyServiceConfig }) {
    this.store = options.store;
    this.identity = options.identity;
    this.clock = options.clock;
    this.config = options.config;
  }

  private webAuthnConfig(): WebAuthnConfig {
    if (!this.config.rpId || this.config.origins.length === 0) {
      throw new AppError(503, 'passkeys_not_configured', 'Passkey sign-in is not configured for this deployment.');
    }
    const config: WebAuthnConfig = {
      rpId: this.config.rpId,
      origins: this.config.origins,
      rpName: this.config.rpName,
    };
    try {
      validateWebAuthnConfig(config);
    } catch (error) {
      throw new AppError(503, 'passkeys_not_configured', 'Passkey relying-party configuration is invalid.', {
        details: { reason: error instanceof WebAuthnError ? error.code : 'invalid_configuration' },
      });
    }
    return config;
  }

  async beginRegistration(user: PublicUser) {
    const config = this.webAuthnConfig();
    const challenge = createPasskeyChallenge();
    const now = this.clock();
    await this.store.createChallenge({
      challengeHash: challengeDigest(challenge),
      purpose: 'registration',
      userId: user.id,
      createdAt: now,
      expiresAt: now + CHALLENGE_TTL_MS,
    });
    return createPasskeyRegistrationOptions({
      challenge,
      userId: user.id,
      userName: user.email,
      displayName: user.displayName,
      rpId: config.rpId,
      rpName: config.rpName,
      timeoutMs: CHALLENGE_TTL_MS,
    });
  }

  async completeRegistration(user: PublicUser, response: PasskeyRegistrationResponse, meta: RequestMeta): Promise<PublicPasskey> {
    const config = this.webAuthnConfig();
    let challenge: string;
    let verified;
    try {
      challenge = extractPasskeyChallenge(response.response.clientDataJSON);
      const consumed = await this.store.consumeChallenge(challengeDigest(challenge), 'registration', user.id, this.clock());
      if (!consumed) throw new AppError(400, 'passkey_challenge_invalid', 'The passkey registration challenge is missing, expired, or already used.');
      verified = verifyPasskeyRegistration(response, { challenge, config });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw webAuthnRequestError(error);
    }

    const record: PasskeyCredentialRecord = {
      ...verified,
      userId: user.id,
      createdAt: this.clock(),
      lastUsedAt: null,
    };
    const event: EventDraft = {
      type: IdentityEvents.PasskeyRegistered,
      version: IDENTITY_EVENT_VERSION,
      actor: { kind: 'user', id: user.id },
      subject: { type: 'user', id: user.id },
      payload: {
        credentialRef: credentialReference(record.credentialId),
        algorithm: record.algorithm,
        backupEligible: record.backupEligible,
        transports: [...record.transports],
      },
      correlationId: meta.requestId,
    };
    try {
      await this.store.createCredential(record, event);
    } catch (error) {
      if (error instanceof PasskeyCredentialExistsError) {
        throw new AppError(409, 'passkey_already_registered', 'This passkey is already registered.');
      }
      throw error;
    }
    return publicRecord(record);
  }

  async beginAuthentication() {
    const config = this.webAuthnConfig();
    const challenge = createPasskeyChallenge();
    const now = this.clock();
    await this.store.createChallenge({
      challengeHash: challengeDigest(challenge),
      purpose: 'authentication',
      userId: null,
      createdAt: now,
      expiresAt: now + CHALLENGE_TTL_MS,
    });
    return createPasskeyAuthenticationOptions({ challenge, rpId: config.rpId, timeoutMs: CHALLENGE_TTL_MS });
  }

  async completeAuthentication(response: PasskeyAssertionResponse, meta: RequestMeta): Promise<SignInResult> {
    const config = this.webAuthnConfig();
    let challenge: string;
    let credentialId: string;
    try {
      challenge = extractPasskeyChallenge(response.response.clientDataJSON);
      const consumed = await this.store.consumeChallenge(challengeDigest(challenge), 'authentication', null, this.clock());
      if (!consumed) throw INVALID_CREDENTIALS();
      // The verifier performs canonical base64url and id/rawId equality checks.
      if (response.type !== 'public-key' || response.id !== response.rawId) throw INVALID_CREDENTIALS();
      credentialId = response.rawId;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw INVALID_CREDENTIALS();
    }

    const credential = await this.store.findCredentialById(credentialId);
    if (!credential) throw INVALID_CREDENTIALS();
    let verified;
    try {
      verified = verifyPasskeyAssertion(response, {
        challenge,
        config,
        credential: {
          credentialId: credential.credentialId,
          publicKeySpki: credential.publicKeySpki,
          algorithm: credential.algorithm,
          signCount: credential.signCount,
          backupEligible: credential.backupEligible,
          backedUp: credential.backedUp,
          userHandle: credential.userId,
        },
      });
    } catch {
      throw INVALID_CREDENTIALS();
    }

    const updated = await this.store.updateAfterAssertion({
      userId: credential.userId,
      credentialId: credential.credentialId,
      signCount: verified.signCount,
      backedUp: verified.backedUp,
      now: this.clock(),
    });
    if (!updated) throw INVALID_CREDENTIALS();
    return this.identity.signInWithPasskey(credential.userId, meta);
  }

  async listForUser(userId: string): Promise<PublicPasskey[]> {
    return (await this.store.listCredentialsForUser(userId)).map(publicRecord);
  }

  async removeForUser(userId: string, credentialId: string, meta: RequestMeta): Promise<void> {
    if (!/^[A-Za-z0-9_-]{22,1366}$/.test(credentialId)) {
      throw new AppError(400, 'invalid_credential_id', 'A valid passkey credential ID is required.');
    }
    const event: EventDraft = {
      type: IdentityEvents.PasskeyRemoved,
      version: IDENTITY_EVENT_VERSION,
      actor: { kind: 'user', id: userId },
      subject: { type: 'user', id: userId },
      payload: { credentialRef: credentialReference(credentialId) },
      correlationId: meta.requestId,
    };
    const removed = await this.store.deleteCredentialForUser(userId, credentialId, event);
    if (!removed) throw new AppError(404, 'passkey_not_found', 'The passkey could not be found.');
  }
}
