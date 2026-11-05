import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { InMemoryEventStore } from '../src/kernel/events.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { SqliteEventStore } from '../src/kernel/sqlite-events.ts';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import { identityMigrations } from '../src/modules/identity/migrations.ts';
import {
  InMemoryPasskeyStore,
  PasskeyCredentialExistsError,
  SqlitePasskeyStore,
  type PasskeyChallengeRecord,
  type PasskeyCredentialRecord,
} from '../src/modules/identity/passkey-store.ts';

const now = 1_800_000_000_000;
const event = (type: 'identity.passkey.registered' | 'identity.passkey.removed', userId: string) => ({
  type,
  version: 1,
  actor: { kind: 'user' as const, id: userId },
  subject: { type: 'user', id: userId },
  payload: { credentialRef: 'a'.repeat(20) },
  correlationId: 'co-002-passkey-store-test',
});
const challenge = (raw: string, purpose: 'registration' | 'authentication', userId: string | null): PasskeyChallengeRecord => ({
  challengeHash: createHash('sha256').update(raw).digest('hex'),
  purpose,
  userId,
  createdAt: now,
  expiresAt: now + 60_000,
});
const credential = (userId: string): PasskeyCredentialRecord => ({
  credentialId: randomBytes(32).toString('base64url'),
  userId,
  publicKeySpki: Buffer.from('public-key-test').toString('base64'),
  algorithm: -7,
  signCount: 0,
  backupEligible: false,
  backedUp: false,
  transports: ['internal'],
  createdAt: now,
  lastUsedAt: null,
});

describe('CO-002 passkey storage', () => {
  it('keeps challenge purposes and owners separate and consumes a valid challenge exactly once', async () => {
    const events = new InMemoryEventStore({ clock: () => now, logger: silentLogger });
    const store = new InMemoryPasskeyStore(events);
    await store.createChallenge(challenge('registration-one', 'registration', 'user-a'));
    assert.equal(await store.consumeChallenge(challenge('registration-one').challengeHash, 'authentication', null, now), null);
    assert.equal(await store.consumeChallenge(challenge('registration-one').challengeHash, 'registration', 'user-b', now), null);
    const used = await store.consumeChallenge(challenge('registration-one').challengeHash, 'registration', 'user-a', now);
    assert.equal(used?.userId, 'user-a');
    assert.equal(await store.consumeChallenge(challenge('registration-one').challengeHash, 'registration', 'user-a', now), null);
  });

  it('expires challenges and rejects malformed challenge metadata', async () => {
    const events = new InMemoryEventStore({ clock: () => now, logger: silentLogger });
    const store = new InMemoryPasskeyStore(events);
    await store.createChallenge(challenge('authentication-expired', 'authentication', null));
    const hash = challenge('authentication-expired', 'authentication', null).challengeHash;
    assert.equal(await store.consumeChallenge(hash, 'authentication', null, now + 60_000), null);
    await assert.rejects(() => store.createChallenge({ ...challenge('bad', 'registration', null) }), /registration challenges require a user ID/);
  });

  it('keeps credential ownership, updates counters monotonically, and audits create/remove', async () => {
    const events = new InMemoryEventStore({ clock: () => now, logger: silentLogger });
    const store = new InMemoryPasskeyStore(events);
    const record = credential('user-a');
    await store.createCredential(record, event('identity.passkey.registered', 'user-a'));
    await assert.rejects(() => store.createCredential(record, event('identity.passkey.registered', 'user-a')), PasskeyCredentialExistsError);
    assert.equal((await store.listCredentialsForUser('user-b')).length, 0);
    assert.equal(await store.updateAfterAssertion({ userId: 'user-b', credentialId: record.credentialId, signCount: 1, backedUp: false, now: now + 1 }), false);
    assert.equal(await store.updateAfterAssertion({ userId: 'user-a', credentialId: record.credentialId, signCount: 3, backedUp: false, now: now + 2 }), true);
    assert.equal(await store.updateAfterAssertion({ userId: 'user-a', credentialId: record.credentialId, signCount: 2, backedUp: false, now: now + 3 }), false);
    assert.equal((await store.findCredentialById(record.credentialId))?.signCount, 3);
    assert.equal(await store.deleteCredentialForUser('user-b', record.credentialId, event('identity.passkey.removed', 'user-b')), false);
    assert.equal(await store.deleteCredentialForUser('user-a', record.credentialId, event('identity.passkey.removed', 'user-a')), true);
    const committed = await events.readFrom(1, 20);
    assert.deepEqual(committed.map((entry) => entry.type), ['identity.passkey.registered', 'identity.passkey.removed']);
  });

  it('persists credentials and atomically rolls them back when the audit append fails', async () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      const events = new SqliteEventStore({ db, clock: () => now, logger: silentLogger });
      const users = db.prepare('INSERT INTO users (id,email,display_name,password_hash,status,created_at,updated_at,password_changed_at,password_compromised_at,version) VALUES (?,?,?,?,?,?,?,?,?,?)');
      users.run('user-a', 'owner@example.test', 'Owner', 'hash', 'active', now, now, now, null, 1);
      const store = new SqlitePasskeyStore({ db, events });
      const record = credential('user-a');
      await store.createCredential(record, event('identity.passkey.registered', 'user-a'));
      assert.equal((await store.findCredentialById(record.credentialId))?.userId, 'user-a');
      assert.equal((await store.listCredentialsForUser('user-a')).length, 1);

      db.exec(\`CREATE TRIGGER reject_passkey_audit BEFORE INSERT ON events
        WHEN NEW.type = 'identity.passkey.registered'
        BEGIN SELECT RAISE(ABORT, 'injected passkey audit failure'); END;\`);
      const rejected = credential('user-a');
      await assert.rejects(
        () => store.createCredential(rejected, event('identity.passkey.registered', 'user-a')),
        /injected passkey audit failure/,
      );
      assert.equal(await store.findCredentialById(rejected.credentialId), null, 'failed audit append must roll back the credential');
      db.exec('DROP TRIGGER reject_passkey_audit');

      assert.equal(await store.updateAfterAssertion({ userId: 'user-a', credentialId: record.credentialId, signCount: 4, backedUp: false, now: now + 10 }), true);
      assert.equal((await store.findCredentialById(record.credentialId))?.signCount, 4);
      assert.equal(await store.deleteCredentialForUser('user-a', record.credentialId, event('identity.passkey.removed', 'user-a')), true);
      assert.equal(await store.findCredentialById(record.credentialId), null);
      assert.equal((await events.readFrom(1, 20)).length, 2);
      assert.equal((await events.verify()).ok, true);
    } finally {
      db.close();
    }
  });
});
