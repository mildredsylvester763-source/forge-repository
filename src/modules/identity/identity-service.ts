import { createHmac } from 'node:crypto';
import type { Clock } from '../../kernel/clock.ts';
import { AppError, retryAfterHeader } from '../../kernel/errors.ts';
import type { EventDraft, EventStore, Actor, Subject } from '../../kernel/events.ts';
import type { Logger } from '../../kernel/logger.ts';
import type { BreachChecker } from './breach-check.ts';
import { normalizeEmail } from './email.ts';
import { assessSignInAnomaly, type SignInAnomalyAssessment } from './identity-anomaly.ts';
import { IDENTITY_EVENT_VERSION, IdentityEvents, type IdentityEventType } from './events.ts';
import { evaluatePassword, normalizePassword } from './password-policy.ts';
import type { PasswordHasher } from './password-hasher.ts';
import type { SessionService } from './sessions.ts';
import type { LoginThrottle } from './throttle.ts';
import type { IdentityUnitOfWork } from './unit-of-work.ts';
import { EmailTakenError, type UserRecord, type UserStore } from './user-store.ts';
import type { TrustedDeviceService } from './trusted-devices.ts';
import type { TrustedDeviceRecord } from './trusted-devices.ts';
import type { TotpFactorService, TotpEnrollmentStart } from './totp-service.ts';
import { TotpFactorError } from './totp-service.ts';

export interface RequestMeta {
  ip: string;
  userAgent: string;
  requestId: string;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface IdentityDeps {
  users: UserStore;
  sessions: SessionService;
  hasher: PasswordHasher;
  breach: BreachChecker;
  events: EventStore;
  uow: IdentityUnitOfWork;
  throttle: LoginThrottle;
  clock: Clock;
  logger: Logger;
  auditKey: Buffer;
  breachMode: 'fail-closed' | 'fail-open';
  checkBreachOnSignIn: boolean;
  trustedDevices?: TrustedDeviceService;
  totp?: TotpFactorService;
}

export interface SignInResult {
  user: PublicUser;
  sessionToken: string;
  sessionExpiresAt: number;
  passwordChangeRequired: boolean;
}

export interface PublicSession {
  sessionId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
  isCurrent: boolean;
}

export interface RevokeSessionResult {
  revoked: boolean;
  revokedCurrentSession: boolean;
}

export interface PublicTrustedDevice {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export interface TrustDeviceResult {
  deviceId: string;
  deviceToken: string;
}

export interface TrustDeviceInput {
  label?: string | null;
  password?: string;
}

export interface TotpEnrollmentInput {
  displayName?: string;
}

export interface TotpEnrollmentResult {
  secret: string;
  provisioningUri: string;
  expiresAt: string;
}

export interface TotpVerificationInput {
  code: string;
}

export interface TotpVerificationResult {
  verified: boolean;
}

export interface TotpDisableInput {
  code: string;
}

export interface TotpDisableResult {
  disabled: boolean;
}

export const toPublicUser = (u: UserRecord): PublicUser => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  createdAt: new Date(u.createdAt).toISOString(),
});

const INVALID_CREDENTIALS = () => new AppError(401, 'invalid_credentials', 'Invalid email or password.');

function tooManyAttempts(retryAfterMs: number): AppError {
  return new AppError(429, 'too_many_attempts', 'Too many attempts. Try again later.', { headers: retryAfterHeader(retryAfterMs) });
}

function cleanDisplayName(raw: string): string | null {
  const name = raw.normalize('NFKC').trim();
  if (name.length < 1 || [...name].length > 80) return null;
  if (/[\u0000-\u001F\u007F]/.test(name)) return null;
  return name;
}

export class IdentityService {
  private readonly d: IdentityDeps;

  constructor(deps: IdentityDeps) {
    this.d = deps;
  }

  /** Keyed, truncated hash of an email: lets the audit log correlate attempts without storing the address. */
  private fingerprint(value: string): string {
    return createHmac('sha256', this.d.auditKey).update(value, 'utf8').digest('hex').slice(0, 32);
  }

  private draft(type: IdentityEventType, actor: Actor, subject: Subject, payload: Record<string, unknown>, meta: RequestMeta): EventDraft {
    return { type, version: IDENTITY_EVENT_VERSION, actor, subject, payload, correlationId: meta.requestId };
  }

  private async emit(type: IdentityEventType, actor: Actor, subject: Subject, payload: Record<string, unknown>, meta: RequestMeta): Promise<void> {
    await this.d.events.append(this.draft(type, actor, subject, payload, meta));
  }

  /** For events describing a refusal: a logging failure must not hide the refusal from the client. */
  private async emitBestEffort(...args: Parameters<IdentityService['emit']>): Promise<void> {
    try {
      await this.emit(...args);
    } catch (err) {
      this.d.logger.error('audit append failed', { type: args[0], err });
    }
  }

  async register(input: { email: string; password: string; displayName?: string | undefined }, meta: RequestMeta): Promise<PublicUser> {
    const gate = this.d.throttle.checkIp('register', meta.ip);
    if (!gate.allowed) throw tooManyAttempts(gate.retryAfterMs);

    const email = normalizeEmail(input.email);
    if (!email) throw new AppError(400, 'invalid_email', 'Enter a valid email address.');
    const fingerprint = this.fingerprint(email);
    const anon: Actor = { kind: 'anonymous', id: meta.ip };
    const subject: Subject = { type: 'account_fingerprint', id: fingerprint };

    const displayName = cleanDisplayName(input.displayName ?? email.split('@')[0] ?? '');
    if (!displayName) throw new AppError(400, 'invalid_display_name', 'Display name must be 1 to 80 characters.');

    const violations = evaluatePassword(input.password, { email });
    if (violations.length > 0) {
      await this.emitBestEffort(IdentityEvents.RegistrationRejected, anon, subject, { reason: 'password_policy', codes: violations.map((v) => v.code) }, meta);
      throw new AppError(422, 'password_policy_violation', 'The password does not meet the requirements.', { details: { violations } });
    }

    const password = normalizePassword(input.password);
    const breach = await this.d.breach.check(password);
    if (breach.status === 'breached') {
      await this.emitBestEffort(IdentityEvents.RegistrationRejected, anon, subject, { reason: 'password_breached' }, meta);
      throw new AppError(422, 'password_breached', 'This password has appeared in a known data breach. Choose a different one.');
    }
    if (breach.status === 'unavailable') {
      if (this.d.breachMode === 'fail-closed') {
        await this.emitBestEffort(IdentityEvents.RegistrationRejected, anon, subject, { reason: 'breach_check_unavailable', cause: breach.reason }, meta);
        throw new AppError(503, 'breach_check_unavailable', 'We could not verify this password right now. Try again shortly.', { headers: { 'Retry-After': '30' } });
      }
      await this.emitBestEffort(IdentityEvents.BreachCheckSkipped, anon, subject, { cause: breach.reason, stage: 'register' }, meta);
    }

    // Always hash before touching the store so "email taken" costs the same as a fresh signup.
    const passwordHash = await this.d.hasher.hash(password);
    let user: UserRecord;
    try {
      // Account and "registered" event are saved in one transaction: both exist, or neither does.
      user = await this.d.uow.registerUser({ email, displayName, passwordHash, now: this.d.clock() }, (created) =>
        this.draft(IdentityEvents.UserRegistered, { kind: 'user', id: created.id }, { type: 'user', id: created.id }, { emailFingerprint: fingerprint }, meta),
      );
    } catch (err) {
      if (err instanceof EmailTakenError) {
        await this.emitBestEffort(IdentityEvents.RegistrationRejected, anon, subject, { reason: 'duplicate_email' }, meta);
        throw new AppError(409, 'email_unavailable', 'That email cannot be used.');
      }
      throw err;
    }
    return toPublicUser(user);
  }

  async signIn(input: { email: string; password: string; deviceToken?: string }, meta: RequestMeta): Promise<SignInResult> {
    const anon: Actor = { kind: 'anonymous', id: meta.ip };

    const ipGate = this.d.throttle.checkIp('signin', meta.ip);
    if (!ipGate.allowed) {
      await this.emitBestEffort(IdentityEvents.SignInThrottled, anon, { type: 'ip', id: meta.ip }, { scope: 'ip' }, meta);
      throw tooManyAttempts(ipGate.retryAfterMs);
    }

    const email = normalizeEmail(input.email);
    const password = normalizePassword(input.password);
    // Unparseable emails are tracked too, so every input follows the same code path.
    const fingerprint = this.fingerprint(email ?? `invalid:${input.email.toLowerCase()}`);
    const subject: Subject = { type: 'account_fingerprint', id: fingerprint };

    const lock = this.d.throttle.checkAccount(fingerprint);
    if (lock.locked) {
      await this.emitBestEffort(IdentityEvents.SignInThrottled, anon, subject, { scope: 'account' }, meta);
      throw tooManyAttempts(lock.retryAfterMs);
    }

    const user = email ? await this.d.users.findByEmail(email) : null;
    let passwordOk = false;
    if (user) passwordOk = await this.d.hasher.verify(password, user.passwordHash);
    else await this.d.hasher.verifyDummy(password);

    if (!user || !passwordOk || user.status !== 'active') {
      this.d.throttle.recordFailure(fingerprint);
      const reason = !user ? 'unknown_account' : !passwordOk ? 'bad_password' : 'account_disabled';
      await this.emitBestEffort(IdentityEvents.SignInFailed, anon, subject, { reason }, meta);
      throw INVALID_CREDENTIALS();
    }

    // Check if device is trusted for MFA bypass
    let deviceTrusted = false;
    if (this.d.trustedDevices && user && input.deviceToken) {
      deviceTrusted = await this.d.trustedDevices.isTrusted(user.id, input.deviceToken);
    }

    // Check if user has MFA enabled
    let mfaRequired = false;
    if (this.d.totp) {
      const totpStatus = await this.d.totp.status(user.id);
      mfaRequired = totpStatus === 'active';
    }

    // If MFA is required and device is not trusted, require MFA
    if (mfaRequired && !deviceTrusted) {
      throw new AppError(403, 'mfa_required', 'Multi-factor authentication is required.');
    }

    this.d.throttle.recordSuccess(fingerprint);
    const now = this.d.clock();

    let rehashed = false;
    let current = user;
    const userUpdate = this.d.hasher.needsRehash(user.passwordHash)
      ? { userId: user.id, patch: { passwordHash: await this.d.hasher.hash(password) }, now }
      : undefined;
    if (userUpdate) rehashed = true;

    let compromised = current.passwordCompromisedAt !== null;
    if (!compromised && this.d.checkBreachOnSignIn) {
      const breach = await this.d.breach.check(password);
      if (breach.status === 'breached') {
        current = await this.d.uow.markPasswordCompromised({
          userId: current.id,
          now,
          event: (marked) => this.draft(
            IdentityEvents.PasswordCompromisedDetected,
            { kind: 'user', id: marked.id },
            { type: 'user', id: marked.id },
            { exposures: breach.count },
            meta,
          ),
        });
        compromised = current.passwordCompromisedAt !== null;
      } else if (breach.status === 'unavailable') {
        // A breach-service outage must not block an otherwise valid sign-in, but it must be visible.
        await this.emitBestEffort(
          IdentityEvents.BreachCheckSkipped,
          { kind: 'user', id: current.id },
          { type: 'user', id: current.id },
          { cause: breach.reason, stage: 'sign_in' },
          meta,
        );
      }
    }

    // Use only the account's currently active sessions as a baseline. The detector is advisory
    // and must never turn a telemetry-store outage into a sign-in outage.
    let anomaly: SignInAnomalyAssessment = { baseline: 'none', signals: [] };
    try {
      const activeSessions = await this.d.sessions.listActiveForUser(current.id);
      anomaly = assessSignInAnomaly({ ip: meta.ip, userAgent: meta.userAgent }, activeSessions);
    } catch (err) {
      anomaly = { baseline: 'insufficient_metadata', signals: [] };
      this.d.logger.error('sign-in anomaly assessment unavailable', { err });
    }

    // Session and "signed in" event are saved in one transaction: no session ever exists without its audit record.
    const { token, session, maxPerUser } = await this.d.sessions.prepare(current.id, { ip: meta.ip, userAgent: meta.userAgent });
    await this.d.uow.startSession({
      session,
      maxPerUser,
      ...(userUpdate ? { userUpdate } : {}),
      event: this.draft(
        IdentityEvents.SignInSucceeded,
        { kind: 'user', id: current.id },
        { type: 'user', id: current.id },
        { sessionRef: session.idHash.slice(0, 12), rehashed, passwordChangeRequired: compromised },
        meta,
      ),
    });

    if (anomaly.signals.length > 0) {
      await this.emitBestEffort(
        IdentityEvents.SignInAnomalyObserved,
        { kind: 'user', id: current.id },
        { type: 'user', id: current.id },
        { baseline: anomaly.baseline, signals: anomaly.signals },
        meta,
      );
    }

    return { user: toPublicUser(current), sessionToken: token, sessionExpiresAt: session.expiresAt, passwordChangeRequired: compromised };
  }

  async signOut(token: string | undefined, meta: RequestMeta): Promise<void> {
    const prepared = this.d.sessions.prepareRevoke(token);
    if (!prepared) return;
    await this.d.uow.endSession({
      idHash: prepared.idHash,
      now: prepared.now,
      event: (session) => this.draft(
        IdentityEvents.SignedOut,
        { kind: 'user', id: session.userId },
        { type: 'user', id: session.userId },
        { sessionRef: session.idHash.slice(0, 12) },
        meta,
      ),
    });
  }

  /** List active sessions for the authenticated account without exposing bearer tokens. */
  async listSessions(token: string | undefined): Promise<PublicSession[]> {
    const current = await this.d.sessions.validate(token);
    if (!current) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const owner = await this.d.users.findById(current.userId);
    if (!owner || owner.status !== 'active') throw new AppError(401, 'unauthenticated', 'Sign in required.');

    const sessions = await this.d.sessions.listActiveForUser(owner.id);
    return sessions.map((session) => ({
      sessionId: session.idHash,
      createdAt: new Date(session.createdAt).toISOString(),
      lastSeenAt: new Date(session.lastSeenAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      ip: session.ip,
      userAgent: session.userAgent,
      isCurrent: session.idHash === current.idHash,
    }));
  }

  /** Revoke one session owned by the authenticated account; foreign IDs are indistinguishable from missing IDs. */
  async revokeSession(token: string | undefined, sessionId: string, meta: RequestMeta): Promise<RevokeSessionResult> {
    if (!/^[a-f0-9]{64}$/i.test(sessionId)) {
      throw new AppError(400, 'invalid_session_id', 'A valid session ID is required.');
    }
    const current = await this.d.sessions.validate(token);
    if (!current) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const owner = await this.d.users.findById(current.userId);
    if (!owner || owner.status !== 'active') throw new AppError(401, 'unauthenticated', 'Sign in required.');

    const target = await this.d.sessions.findActiveForUser(owner.id, sessionId.toLowerCase());
    if (!target) throw new AppError(404, 'session_not_found', 'The session could not be found.');

    const revoked = await this.d.uow.endSession({
      idHash: target.idHash,
      now: this.d.clock(),
      reason: 'session_manager',
      event: (session) => this.draft(
        IdentityEvents.SessionRevoked,
        { kind: 'user', id: owner.id },
        { type: 'session', id: session.idHash.slice(0, 12) },
        { sessionRef: session.idHash.slice(0, 12), reason: 'session_manager' },
        meta,
      ),
    });

    return {
      revoked: revoked !== null,
      revokedCurrentSession: revoked !== null && target.idHash === current.idHash,
    };
  }

  /** Trust a device for future MFA bypass. Requires password verification. */
  async trustDevice(token: string | undefined, input: TrustDeviceInput, meta: RequestMeta): Promise<TrustDeviceResult | null> {
    if (!this.d.trustedDevices) {
      throw new AppError(501, 'not_implemented', 'Trusted devices are not configured.');
    }

    const current = await this.d.sessions.validate(token);
    if (!current) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const owner = await this.d.users.findById(current.userId);
    if (!owner || owner.status !== 'active') throw new AppError(401, 'unauthenticated', 'Sign in required.');

    // Require password verification before trusting a device
    if (input.password) {
      const passwordOk = await this.d.hasher.verify(input.password, owner.passwordHash);
      if (!passwordOk) {
        await this.emitBestEffort(
          IdentityEvents.DeviceTrustFailed,
          { kind: 'user', id: owner.id },
          { type: 'user', id: owner.id },
          { reason: 'bad_password' },
          meta,
        );
        throw new AppError(401, 'invalid_credentials', 'Invalid password.');
      }
    } else {
      // If no password provided, require MFA to be enabled and verified
      // This will be implemented when MFA integration is added
      throw new AppError(400, 'password_required', 'Password is required to trust a device.');
    }

    const now = this.d.clock();
    const result = await this.d.trustedDevices.trustDevice(owner.id, input.label ?? null, now);
    if (!result) {
      throw new AppError(429, 'device_limit_reached', 'Maximum number of trusted devices reached.');
    }

    await this.emitBestEffort(
      IdentityEvents.DeviceTrusted,
      { kind: 'user', id: owner.id },
      { type: 'device', id: result.deviceId },
      { label: input.label ?? null },
      meta,
    );

    return result;
  }

  /** List all trusted devices for the authenticated account. */
  async listTrustedDevices(token: string | undefined): Promise<PublicTrustedDevice[]> {
    if (!this.d.trustedDevices) {
      throw new AppError(501, 'not_implemented', 'Trusted devices are not configured.');
    }

    const current = await this.d.sessions.validate(token);
    if (!current) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const owner = await this.d.users.findById(current.userId);
    if (!owner || owner.status !== 'active') throw new AppError(401, 'unauthenticated', 'Sign in required.');

    const devices = await this.d.trustedDevices.listDevices(owner.id);
    return devices.map((device) => ({
      id: device.id,
      label: device.label,
      createdAt: new Date(device.createdAt).toISOString(),
      lastUsedAt: device.lastUsedAt ? new Date(device.lastUsedAt).toISOString() : null,
      expiresAt: new Date(device.expiresAt).toISOString(),
    }));
  }

  /** Revoke a trusted device. */
  async revokeTrustedDevice(token: string | undefined, deviceId: string): Promise<boolean> {
    if (!this.d.trustedDevices) {
      throw new AppError(501, 'not_implemented', 'Trusted devices are not configured.');
    }

    const current = await this.d.sessions.validate(token);
    if (!current) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const owner = await this.d.users.findById(current.userId);
    if (!owner || owner.status !== 'active') throw new AppError(401, 'unauthenticated', 'Sign in required.');

    return this.d.trustedDevices.revokeDevice(owner.id, deviceId);
  }

  /** Check if a device token is trusted for the given user. */
  async isDeviceTrusted(userId: string, deviceToken: string): Promise<boolean> {
    if (!this.d.trustedDevices) return false;
    return this.d.trustedDevices.isTrusted(userId, deviceToken);
  }

  /** Complete a passkey-authenticated sign-in without running password-only checks. */
  async signInWithPasskey(userId: string, meta: RequestMeta): Promise<SignInResult> {
    const anon: Actor = { kind: 'anonymous', id: meta.ip };
    const ipGate = this.d.throttle.checkIp('signin', meta.ip);
    if (!ipGate.allowed) {
      await this.emitBestEffort(IdentityEvents.SignInThrottled, anon, { type: 'ip', id: meta.ip }, { scope: 'ip' }, meta);
      throw tooManyAttempts(ipGate.retryAfterMs);
    }

    const fingerprint = this.fingerprint('passkey:' + userId);
    const subject: Subject = { type: 'account_fingerprint', id: fingerprint };
    const lock = this.d.throttle.checkAccount(fingerprint);
    if (lock.locked) {
      await this.emitBestEffort(IdentityEvents.SignInThrottled, anon, subject, { scope: 'account' }, meta);
      throw tooManyAttempts(lock.retryAfterMs);
    }

    const user = await this.d.users.findById(userId);
    if (!user || user.status !== 'active') {
      this.d.throttle.recordFailure(fingerprint);
      await this.emitBestEffort(IdentityEvents.SignInFailed, anon, subject, { reason: 'invalid_passkey_account' }, meta);
      throw INVALID_CREDENTIALS();
    }
    this.d.throttle.recordSuccess(fingerprint);

    let anomaly: SignInAnomalyAssessment = { baseline: 'none', signals: [] };
    try {
      const activeSessions = await this.d.sessions.listActiveForUser(user.id);
      anomaly = assessSignInAnomaly({ ip: meta.ip, userAgent: meta.userAgent }, activeSessions);
    } catch (err) {
      anomaly = { baseline: 'insufficient_metadata', signals: [] };
      this.d.logger.error('passkey sign-in anomaly assessment unavailable', { err });
    }

    const { token, session, maxPerUser } = await this.d.sessions.prepare(user.id, { ip: meta.ip, userAgent: meta.userAgent });
    const passwordChangeRequired = user.passwordCompromisedAt !== null;
    await this.d.uow.startSession({
      session,
      maxPerUser,
      event: this.draft(
        IdentityEvents.SignInSucceeded,
        { kind: 'user', id: user.id },
        { type: 'user', id: user.id },
        { sessionRef: session.idHash.slice(0, 12), rehashed: false, passwordChangeRequired, authenticationMethod: 'passkey' },
        meta,
      ),
    });

    if (anomaly.signals.length > 0) {
      await this.emitBestEffort(
        IdentityEvents.SignInAnomalyObserved,
        { kind: 'user', id: user.id },
        { type: 'user', id: user.id },
        { baseline: anomaly.baseline, signals: anomaly.signals },
        meta,
      );
    }

    return { user: toPublicUser(user), sessionToken: token, sessionExpiresAt: session.expiresAt, passwordChangeRequired };
  }

  /** Begin TOTP enrollment for the authenticated account. */
  async beginTotpEnrollment(token: string | undefined, input: TotpEnrollmentInput, meta: RequestMeta): Promise<TotpEnrollmentResult> {
    if (!this.d.totp) {
      throw new AppError(501, 'not_implemented', 'TOTP is not configured.');
    }

    const current = await this.d.sessions.validate(token);
    if (!current) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const owner = await this.d.users.findById(current.userId);
    if (!owner || owner.status !== 'active') throw new AppError(401, 'unauthenticated', 'Sign in required.');

    // Use display name for authenticator app label instead of user ID
    const displayName = input.displayName ?? owner.displayName ?? owner.email.split('@')[0] ?? owner.id;

    const result = await this.d.totp.beginEnrollment(owner.id, displayName);
    await this.emitBestEffort(
      IdentityEvents.TotpEnrollmentStarted,
      { kind: 'user', id: owner.id },
      { type: 'user', id: owner.id },
      {},
      meta,
    );

    return {
      secret: result.secret,
      provisioningUri: result.provisioningUri,
      expiresAt: result.expiresAt,
    };
  }

  /** Confirm TOTP enrollment with a code. */
  async confirmTotpEnrollment(token: string | undefined, input: TotpVerificationInput): Promise<TotpVerificationResult> {
    if (!this.d.totp) {
      throw new AppError(501, 'not_implemented', 'TOTP is not configured.');
    }

    const current = await this.d.sessions.validate(token);
    if (!current) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const owner = await this.d.users.findById(current.userId);
    if (!owner || owner.status !== 'active') throw new AppError(401, 'unauthenticated', 'Sign in required.');

    try {
      const verified = await this.d.totp.confirmEnrollment(owner.id, input.code);
      if (verified) {
        await this.emitBestEffort(
          IdentityEvents.TotpEnrollmentConfirmed,
          { kind: 'user', id: owner.id },
          { type: 'user', id: owner.id },
          {},
          meta,
        );
      }
      return { verified };
    } catch (err) {
      if (err instanceof TotpFactorError && err.code === 'too_many_attempts') {
        await this.emitBestEffort(
          IdentityEvents.TotpThrottled,
          { kind: 'user', id: owner.id },
          { type: 'user', id: owner.id },
          { retryAfterMs: err.message.match(/\d+/)?.[0] ?? '0' },
          meta,
        );
      }
      throw err;
    }
  }

  /** Cancel TOTP enrollment. */
  async cancelTotpEnrollment(token: string | undefined, meta: RequestMeta): Promise<boolean> {
    if (!this.d.totp) {
      throw new AppError(501, 'not_implemented', 'TOTP is not configured.');
    }

    const current = await this.d.sessions.validate(token);
    if (!current) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const owner = await this.d.users.findById(current.userId);
    if (!owner || owner.status !== 'active') throw new AppError(401, 'unauthenticated', 'Sign in required.');

    const cancelled = await this.d.totp.cancelEnrollment(owner.id);
    if (cancelled) {
      await this.emitBestEffort(
        IdentityEvents.TotpEnrollmentCancelled,
        { kind: 'user', id: owner.id },
        { type: 'user', id: owner.id },
        {},
        meta,
      );
    }
    return cancelled;
  }

  /** Verify a TOTP code. */
  async verifyTotpCode(token: string | undefined, input: TotpVerificationInput, meta: RequestMeta): Promise<TotpVerificationResult> {
    if (!this.d.totp) {
      throw new AppError(501, 'not_implemented', 'TOTP is not configured.');
    }

    const current = await this.d.sessions.validate(token);
    if (!current) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const owner = await this.d.users.findById(current.userId);
    if (!owner || owner.status !== 'active') throw new AppError(401, 'unauthenticated', 'Sign in required.');

    try {
      const verified = await this.d.totp.verifyAndConsume(owner.id, input.code);
      if (verified) {
        await this.emitBestEffort(
          IdentityEvents.TotpVerificationSucceeded,
          { kind: 'user', id: owner.id },
          { type: 'user', id: owner.id },
          {},
          meta,
        );
      } else {
        await this.emitBestEffort(
          IdentityEvents.TotpVerificationFailed,
          { kind: 'user', id: owner.id },
          { type: 'user', id: owner.id },
          { reason: 'invalid_code' },
          meta,
        );
      }
      return { verified };
    } catch (err) {
      if (err instanceof TotpFactorError && err.code === 'too_many_attempts') {
        await this.emitBestEffort(
          IdentityEvents.TotpThrottled,
          { kind: 'user', id: owner.id },
          { type: 'user', id: owner.id },
          { retryAfterMs: err.message.match(/\d+/)?.[0] ?? '0' },
          meta,
        );
      }
      throw err;
    }
  }

  /** Disable TOTP for the authenticated account. */
  async disableTotp(token: string | undefined, input: TotpDisableInput, meta: RequestMeta): Promise<TotpDisableResult> {
    if (!this.d.totp) {
      throw new AppError(501, 'not_implemented', 'TOTP is not configured.');
    }

    const current = await this.d.sessions.validate(token);
    if (!current) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const owner = await this.d.users.findById(current.userId);
    if (!owner || owner.status !== 'active') throw new AppError(401, 'unauthenticated', 'Sign in required.');

    const disabled = await this.d.totp.disable(owner.id, input.code);
    if (disabled) {
      await this.emitBestEffort(
        IdentityEvents.TotpDisabled,
        { kind: 'user', id: owner.id },
        { type: 'user', id: owner.id },
        {},
        meta,
      );
    }
    return { disabled };
  }

  /** Get TOTP status for the authenticated account. */
  async getTotpStatus(token: string | undefined): Promise<{ status: 'disabled' | 'pending' | 'active' }> {
    if (!this.d.totp) {
      throw new AppError(501, 'not_implemented', 'TOTP is not configured.');
    }

    const current = await this.d.sessions.validate(token);
    if (!current) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const owner = await this.d.users.findById(current.userId);
    if (!owner || owner.status !== 'active') throw new AppError(401, 'unauthenticated', 'Sign in required.');

    const status = await this.d.totp.status(owner.id);
    return { status };
  }

  /** Server-side session check used by every protected route (CO-030). Returns null for any failure. */
  async authenticate(token: string | undefined): Promise<{ user: PublicUser; sessionExpiresAt: number } | null> {
    const session = await this.d.sessions.validate(token);
    if (!session) return null;
    const user = await this.d.users.findById(session.userId);
    if (!user || user.status !== 'active') return null;
    return { user: toPublicUser(user), sessionExpiresAt: session.expiresAt };
  }
}

export { TotpFactorService, TotpFactorError } from './totp-service.ts';
export type { TotpEnrollmentStart } from './totp-service.ts';
