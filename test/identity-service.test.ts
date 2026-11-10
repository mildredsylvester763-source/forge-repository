import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EventDraft, EventEnvelope, EventStore } from '../src/kernel/events.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { IdentityService, type IdentityDeps } from '../src/modules/identity/identity-service.ts';
import { IdentityEvents } from '../src/modules/identity/events.ts';
import type { BreachChecker } from '../src/modules/identity/breach-check.ts';
import type { PasswordHasher } from '../src/modules/identity/password-hasher.ts';
import type { SessionRecord, SessionService } from '../src/modules/identity/sessions.ts';
import type { LoginThrottle } from '../src/modules/identity/throttle.ts';
import type { IdentityUnitOfWork } from '../src/modules/identity/unit-of-work.ts';
import type { UserRecord, UserStore } from '../src/modules/identity/user-store.ts';

describe('CO-001 identity service breach-check outage handling', () => {
  it('records a skipped sign-in recheck and still issues the valid session', async () => {
    const now = 1_800_000_000_000;
    const user: UserRecord = {
      id: 'user-co001',
      email: 'owner@example.test',
      displayName: 'Owner',
      passwordHash: 'stored-hash',
      status: 'active',
      createdAt: now - 10_000,
      updatedAt: now - 10_000,
      passwordChangedAt: now - 10_000,
      passwordCompromisedAt: null,
      version: 1,
    };
    const session: SessionRecord = {
      idHash: 'a'.repeat(64),
      userId: user.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 3_600_000,
      ip: '192.0.2.10',
      userAgent: 'CO-001-test',
      revokedAt: null,
      revokedReason: null,
    };
    const recorded: EventDraft[] = [];
    let sessionStarted = false;

    const deps = {
      users: {
        findByEmail: async () => user,
      } as unknown as UserStore,
      sessions: {
        prepare: async () => ({ token: 'test-session-token', session, maxPerUser: 3 }),
        listActiveForUser: async () => [],
      } as unknown as SessionService,
      hasher: {
        verify: async () => true,
        needsRehash: () => false,
      } as unknown as PasswordHasher,
      breach: {
        check: async () => ({ status: 'unavailable', reason: 'timeout' }),
      } as BreachChecker,
      events: {
        append: async (draft: EventDraft) => {
          recorded.push(draft);
          return {} as EventEnvelope;
        },
      } as unknown as EventStore,
      uow: {
        startSession: async () => {
          sessionStarted = true;
        },
      } as unknown as IdentityUnitOfWork,
      throttle: {
        checkIp: () => ({ allowed: true, retryAfterMs: 0 }),
        checkAccount: () => ({ locked: false, retryAfterMs: 0 }),
        recordSuccess: () => undefined,
      } as unknown as LoginThrottle,
      clock: () => now,
      logger: silentLogger,
      auditKey: Buffer.alloc(32, 7),
      breachMode: 'fail-closed' as const,
      checkBreachOnSignIn: true,
    } satisfies IdentityDeps;

    const service = new IdentityService(deps);
    const result = await service.signIn(
      { email: user.email, password: 'correct horse battery' },
      { ip: '192.0.2.10', userAgent: 'CO-001-test', requestId: 'co001-outage-test' },
    );

    assert.equal(result.user.id, user.id);
    assert.equal(result.sessionToken, 'test-session-token');
    assert.equal(result.passwordChangeRequired, false);
    assert.equal(sessionStarted, true);

    const skipped = recorded.find((event) => event.type === IdentityEvents.BreachCheckSkipped);
    assert.ok(skipped, 'the unavailable optional check must be auditable');
    assert.equal(skipped?.payload.stage, 'sign_in');
    assert.equal(skipped?.payload.cause, 'timeout');
    assert.equal(skipped?.actor.id, user.id);
  });

  it('records new active-session fingerprints as advisory anomaly signals', async () => {
    const now = 1_800_000_100_000;
    const user: UserRecord = {
      id: 'user-co012',
      email: 'anomaly-owner@example.test',
      displayName: 'Anomaly Owner',
      passwordHash: 'stored-hash',
      status: 'active',
      createdAt: now - 10_000,
      updatedAt: now - 10_000,
      passwordChangedAt: now - 10_000,
      passwordCompromisedAt: null,
      version: 1,
    };
    const previous: SessionRecord = {
      idHash: 'b'.repeat(64),
      userId: user.id,
      createdAt: now - 20_000,
      lastSeenAt: now - 5_000,
      expiresAt: now + 3_600_000,
      ip: '192.0.2.20',
      userAgent: 'Known browser',
      revokedAt: null,
      revokedReason: null,
    };
    const next: SessionRecord = {
      ...previous,
      idHash: 'c'.repeat(64),
      ip: '198.51.100.45',
      userAgent: 'New browser',
      createdAt: now,
      lastSeenAt: now,
    };
    const recorded: EventDraft[] = [];
    const deps = {
      users: { findByEmail: async () => user } as unknown as UserStore,
      sessions: {
        listActiveForUser: async () => [previous],
        prepare: async () => ({ token: 'test-session-token', session: next, maxPerUser: 3 }),
      } as unknown as SessionService,
      hasher: {
        verify: async () => true,
        needsRehash: () => false,
      } as unknown as PasswordHasher,
      breach: { check: async () => ({ status: 'clean' }) } as BreachChecker,
      events: {
        append: async (draft: EventDraft) => {
          recorded.push(draft);
          return {} as EventEnvelope;
        },
      } as unknown as EventStore,
      uow: { startSession: async () => undefined } as unknown as IdentityUnitOfWork,
      throttle: {
        checkIp: () => ({ allowed: true, retryAfterMs: 0 }),
        checkAccount: () => ({ locked: false, retryAfterMs: 0 }),
        recordSuccess: () => undefined,
      } as unknown as LoginThrottle,
      clock: () => now,
      logger: silentLogger,
      auditKey: Buffer.alloc(32, 7),
      breachMode: 'fail-closed' as const,
      checkBreachOnSignIn: false,
    } satisfies IdentityDeps;

    const service = new IdentityService(deps);
    await service.signIn(
      { email: user.email, password: 'correct horse battery' },
      { ip: next.ip, userAgent: next.userAgent, requestId: 'co012-anomaly-test' },
    );

    const anomaly = recorded.find((event) => event.type === IdentityEvents.SignInAnomalyObserved);
    assert.ok(anomaly, 'a changed active-session fingerprint must emit an anomaly observation');
    assert.deepEqual(anomaly?.payload, {
      baseline: 'active_sessions',
      signals: [
        'new_active_session_ip',
        'new_active_session_user_agent',
        'new_active_session_device',
      ],
    });
    assert.equal(JSON.stringify(anomaly?.payload).includes(next.ip), false);
    assert.equal(JSON.stringify(anomaly?.payload).includes(next.userAgent), false);
  });

  it('creates the normal audited session for a verified passkey without using the password hasher', async () => {
    const now = 1_800_000_200_000;
    const user: UserRecord = {
      id: 'user-passkey-signin',
      email: 'passkey-owner@example.test',
      displayName: 'Passkey Owner',
      passwordHash: 'never-read-for-passkey',
      status: 'active',
      createdAt: now - 10_000,
      updatedAt: now - 10_000,
      passwordChangedAt: now - 10_000,
      passwordCompromisedAt: null,
      version: 1,
    };
    const session: SessionRecord = {
      idHash: 'e'.repeat(64),
      userId: user.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 3_600_000,
      ip: '192.0.2.30',
      userAgent: 'CO-002 passkey test',
      revokedAt: null,
      revokedReason: null,
    };
    const recorded: EventDraft[] = [];
    let sessionStarted = false;
    let verifyCalled = false;
    const deps = {
      users: { findById: async () => user } as unknown as UserStore,
      sessions: {
        prepare: async () => ({ token: 'passkey-session-token', session, maxPerUser: 3 }),
        listActiveForUser: async () => [],
      } as unknown as SessionService,
      hasher: {
        verify: async () => { verifyCalled = true; return false; },
        needsRehash: () => { verifyCalled = true; return false; },
      } as unknown as PasswordHasher,
      breach: { check: async () => ({ status: 'clean' }) } as BreachChecker,
      events: {
        append: async (draft: EventDraft) => { recorded.push(draft); return {} as EventEnvelope; },
      } as unknown as EventStore,
      uow: {
        startSession: async (args: { event: EventDraft }) => { sessionStarted = true; recorded.push(args.event); },
      } as unknown as IdentityUnitOfWork,
      throttle: {
        checkIp: () => ({ allowed: true, retryAfterMs: 0 }),
        checkAccount: () => ({ locked: false, retryAfterMs: 0 }),
        recordSuccess: () => undefined,
        recordFailure: () => undefined,
      } as unknown as LoginThrottle,
      clock: () => now,
      logger: silentLogger,
      auditKey: Buffer.alloc(32, 9),
      breachMode: 'fail-closed' as const,
      checkBreachOnSignIn: true,
    } satisfies IdentityDeps;

    const service = new IdentityService(deps);
    const result = await service.signInWithPasskey(user.id, {
      ip: session.ip, userAgent: session.userAgent, requestId: 'co002-passkey-signin-test',
    });

    assert.equal(result.user.id, user.id);
    assert.equal(result.sessionToken, 'passkey-session-token');
    assert.equal(sessionStarted, true);
    assert.equal(verifyCalled, false, 'passkey sign-in must not try to verify a password');
    const signIn = recorded.find((entry) => entry.type === IdentityEvents.SignInSucceeded);
    assert.equal(signIn?.payload.authenticationMethod, 'passkey');
  });

});
