import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { AppError } from '../src/kernel/errors.ts';
import { InMemoryEventStore } from '../src/kernel/events.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { IdentityEvents } from '../src/modules/identity/events.ts';
import { InMemoryPasskeyStore } from '../src/modules/identity/passkey-store.ts';
import { PasskeyService } from '../src/modules/identity/passkey-service.ts';
import type { IdentityService, PublicUser, SignInResult } from '../src/modules/identity/identity-service.ts';
import type { StoredPasskey } from '../src/modules/identity/webauthn.ts';
import type { LoginThrottle } from '../src/modules/identity/throttle.ts';

const now = 1_800_000_100_000;
const user: PublicUser = {
  id: 'user-passkey-123',
  email: 'owner@example.test',
  displayName: 'Owner',
  createdAt: new Date(now - 1000).toISOString(),
};
const config = { rpId: 'forge.example', origins: ['https://forge.example'], rpName: 'FORGE' };
const meta = { ip: '192.0.2.9', userAgent: 'CO-002 test', requestId: 'co-002-service-test' };
const throttle = { checkIp: () => ({ allowed: true, retryAfterMs: 0 }) } as unknown as LoginThrottle;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest();
function assertAppError(operation: () => Promise<unknown>, status: number, code: string) {
  return assert.rejects(operation, (error: unknown) =>
    error instanceof AppError && error.status === status && error.code === code
  );
}
function clientData(challenge: string): Buffer {
  return Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: config.origins[0], crossOrigin: false }));
}
function authenticatorData(rpId: string, counter: number): Buffer {
  const bytes = Buffer.alloc(37);
  createHash('sha256').update(rpId).digest().copy(bytes, 0);
  bytes[32] = 0x05;
  bytes.writeUInt32BE(counter, 33);
  return bytes;
}

describe('CO-002 passkey service lifecycle', () => {
  it('requires deployment RP settings before issuing WebAuthn options', async () => {
    const events = new InMemoryEventStore({ clock: () => now, logger: silentLogger });
    const store = new InMemoryPasskeyStore(events);
    const identity = { signInWithPasskey: async () => { throw new Error('not used'); } } as unknown as IdentityService;
    const service = new PasskeyService({
      store, identity, throttle, clock: () => now,
      config: { rpId: null, origins: [], rpName: 'FORGE' },
    });
    await assertAppError(() => service.beginAuthentication(meta), 503, 'passkeys_not_configured');
  });

  it('rate limits passkey challenge operations without consuming the password sign-in bucket', async () => {
    const events = new InMemoryEventStore({ clock: () => now, logger: silentLogger });
    const store = new InMemoryPasskeyStore(events);
    let bucketSeen = '';
    const denied = {
      checkIp: (bucket: string) => {
        bucketSeen = bucket;
        return { allowed: false, retryAfterMs: 12_000 };
      },
    } as unknown as LoginThrottle;
    const identity = { signInWithPasskey: async () => { throw new Error('not used'); } } as unknown as IdentityService;
    const service = new PasskeyService({ store, identity, throttle: denied, clock: () => now, config });
    await assertAppError(() => service.beginAuthentication(meta), 429, 'too_many_attempts');
    assert.equal(bucketSeen, 'passkey');
  });

  it('issues owner-bound registration challenges and consumes them after a failed response', async () => {
    const events = new InMemoryEventStore({ clock: () => now, logger: silentLogger });
    const store = new InMemoryPasskeyStore(events);
    const identity = { signInWithPasskey: async () => { throw new Error('not used'); } } as unknown as IdentityService;
    const service = new PasskeyService({ store, identity, throttle, clock: () => now, config });
    const options = await service.beginRegistration(user, meta);
    assert.equal(options.rp.id, config.rpId);
    assert.equal(options.user.name, user.email);
    assert.equal(options.timeout, 120_000);

    const rawId = randomBytes(32).toString('base64url');
    const response = {
      id: rawId,
      rawId,
      type: 'public-key',
      response: {
        clientDataJSON: Buffer.from(JSON.stringify({
          type: 'webauthn.create', challenge: options.challenge, origin: config.origins[0],
        })).toString('base64url'),
        attestationObject: Buffer.from([0]).toString('base64url'),
      },
    };
    await assertAppError(() => service.completeRegistration(user, response, meta), 400, 'invalid_passkey_response');
    await assertAppError(() => service.completeRegistration(user, response, meta), 400, 'passkey_challenge_invalid');
    assert.equal((await events.readFrom(1, 10)).length, 0, 'invalid registration must not create an audit event');
  });

  it('authenticates a discoverable passkey, advances its counter, and rejects challenge replay', async () => {
    const events = new InMemoryEventStore({ clock: () => now, logger: silentLogger });
    const store = new InMemoryPasskeyStore(events);
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const credentialId = randomBytes(32).toString('base64url');
    const stored: StoredPasskey = {
      credentialId,
      publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      algorithm: -7,
      signCount: 0,
      backupEligible: false,
      backedUp: false,
      userHandle: user.id,
    };
    await store.createCredential({
      ...stored,
      userId: user.id,
      transports: ['internal'],
      createdAt: now,
      lastUsedAt: null,
    }, {
      type: IdentityEvents.PasskeyRegistered,
      version: 1,
      actor: { kind: 'user', id: user.id },
      subject: { type: 'user', id: user.id },
      payload: { credentialRef: 'test' },
    });

    let authenticatedUser: string | null = null;
    const session: SignInResult = {
      user,
      sessionToken: 'x'.repeat(43),
      sessionExpiresAt: now + 3_600_000,
      passwordChangeRequired: false,
    };
    const identity = {
      signInWithPasskey: async (userId: string) => {
        authenticatedUser = userId;
        return session;
      },
    } as unknown as IdentityService;
    const service = new PasskeyService({ store, identity, throttle, clock: () => now + 1000, config });
    const options = await service.beginAuthentication(meta);
    const client = clientData(options.challenge);
    const authData = authenticatorData(config.rpId, 1);
    const signedBytes = Buffer.concat([authData, hash(client)]);
    const signature = sign('sha256', signedBytes, privateKey).toString('base64url');
    const response = {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: client.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature,
        userHandle: Buffer.from(user.id).toString('base64url'),
      },
    };

    const result = await service.completeAuthentication(response, meta);
    assert.equal(authenticatedUser, user.id);
    assert.equal(result.sessionToken, session.sessionToken);
    assert.equal((await store.findCredentialById(credentialId))?.signCount, 1);
    const audit = await events.readFrom(1, 10);
    assert.ok(audit.some((entry) => entry.type === IdentityEvents.PasskeyAuthenticated), 'counter advancement must append a passkey authentication event');
    await assertAppError(() => service.completeAuthentication(response, meta), 401, 'invalid_credentials');
  });

  it('lists only public credential metadata and removes only credentials owned by the user', async () => {
    const events = new InMemoryEventStore({ clock: () => now, logger: silentLogger });
    const store = new InMemoryPasskeyStore(events);
    const identity = { signInWithPasskey: async () => { throw new Error('not used'); } } as unknown as IdentityService;
    const service = new PasskeyService({ store, identity, clock: () => now, config });
    const credentialId = randomBytes(32).toString('base64url');
    await store.createCredential({
      credentialId, userId: user.id, publicKeySpki: Buffer.from('private-not-returned').toString('base64'),
      algorithm: -7, signCount: 0, backupEligible: false, backedUp: false, transports: ['internal'],
      createdAt: now, lastUsedAt: null,
    }, {
      type: IdentityEvents.PasskeyRegistered, version: 1,
      actor: { kind: 'user', id: user.id }, subject: { type: 'user', id: user.id }, payload: { credentialRef: 'safe' },
    });
    const listed = await service.listForUser(user.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.credentialId, credentialId);
    assert.equal(Object.hasOwn(listed[0] ?? {}, 'publicKeySpki'), false);
    await assertAppError(() => service.removeForUser('someone-else', credentialId, meta), 404, 'passkey_not_found');
    await service.removeForUser(user.id, credentialId, meta);
    assert.equal((await service.listForUser(user.id)).length, 0);
  });
});
