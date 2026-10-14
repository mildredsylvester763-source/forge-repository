import { createHmac } from 'node:crypto';
import type { Clock } from '../../kernel/clock.ts';
import { AppError, retryAfterHeader } from '../../kernel/errors.ts';
import type { EventDraft, EventStore, Actor, Subject } from '../../kernel/events.ts';
import type { Logger } from '../../kernel/logger.ts';
import type { BreachChecker } from './breach-check.ts';
import { normalizeEmail } from './email.ts';
import { IDENTITY_EVENT_VERSION, IdentityEvents, type IdentityEventType } from './events.ts';
import { evaluatePassword, normalizePassword } from './password-policy.ts';
import type { PasswordHasher } from './password-hasher.ts';
import type { SessionService } from './sessions.ts';
import type { LoginThrottle } from './throttle.ts';
import type { IdentityUnitOfWork } from './unit-of-work.ts';
import { EmailTakenError, type UserRecord, type UserStore } from './user-store.ts';

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
}

export interface SignInResult {
  user: PublicUser;
  sessionToken: string;
  sessionExpiresAt: number;
  passwordChangeRequired: boolean;
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

  async signIn(input: { email: string; password: string }, meta: RequestMeta): Promise<SignInResult> {
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

    this.d.throttle.recordSuccess(fingerprint);
    const now = this.d.clock();

    let rehashed = false;
    let current = user;
    if (this.d.hasher.needsRehash(user.passwordHash)) {
      current = await this.d.users.update(user.id, { passwordHash: await this.d.hasher.hash(password) }, now);
      rehashed = true;
    }

    let compromised = current.passwordCompromisedAt !== null;
    if (!compromised && this.d.checkBreachOnSignIn) {
      const breach = await this.d.breach.check(password);
      if (breach.status === 'breached') {
        current = await this.d.users.update(current.id, { passwordCompromisedAt: now }, now);
        compromised = true;
        await this.emitBestEffort(IdentityEvents.PasswordCompromisedDetected, { kind: 'user', id: current.id }, { type: 'user', id: current.id }, { exposures: breach.count }, meta);
      }
    }

    // Session and "signed in" event are saved in one transaction: no session ever exists without its audit record.
    const { token, session, revokeIdHashes } = await this.d.sessions.prepare(current.id, { ip: meta.ip, userAgent: meta.userAgent });
    await this.d.uow.startSession({
      session,
      revokeIdHashes,
      event: this.draft(
        IdentityEvents.SignInSucceeded,
        { kind: 'user', id: current.id },
        { type: 'user', id: current.id },
        { sessionRef: session.idHash.slice(0, 12), rehashed, passwordChangeRequired: compromised },
        meta,
      ),
    });

    return { user: toPublicUser(current), sessionToken: token, sessionExpiresAt: session.expiresAt, passwordChangeRequired: compromised };
  }

  async signOut(token: string | undefined, meta: RequestMeta): Promise<void> {
    const record = await this.d.sessions.revoke(token, 'user_sign_out');
    if (record) {
      await this.emitBestEffort(IdentityEvents.SignedOut, { kind: 'user', id: record.userId }, { type: 'user', id: record.userId }, { sessionRef: record.idHash.slice(0, 12) }, meta);
    }
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
