/** Public surface of the identity module. Other modules import from here and nowhere deeper. */
export { IdentityService, toPublicUser } from './identity-service.ts';
export type { IdentityDeps, PublicUser, PublicSession, RevokeSessionResult, RequestMeta, SignInResult } from './identity-service.ts';
export { IdentityEvents, IDENTITY_EVENT_VERSION } from './events.ts';
export type { IdentityEventType } from './events.ts';
export { assessSignInAnomaly } from './identity-anomaly.ts';
export type { SignInAnomalyAssessment, SignInAnomalySignal, SignInFingerprint } from './identity-anomaly.ts';
export { identityRoutes } from './routes.ts';
export { bearerSessionToken, sessionCredential } from './request-auth.ts';
export { PasswordHasher } from './password-hasher.ts';
export type { HasherConfig, ScryptParams } from './password-hasher.ts';
export { HibpBreachChecker, LocalBlocklistChecker, CompositeBreachChecker } from './breach-check.ts';
export {
  createPasskeyAuthenticationOptions,
  createPasskeyChallenge,
  createPasskeyRegistrationOptions,
  extractPasskeyChallenge,
  validateWebAuthnConfig,
  verifyPasskeyAssertion,
  verifyPasskeyRegistration,
  WebAuthnError,
} from './webauthn.ts';
export type {
  AuthenticationOptionsInput,
  PasskeyAssertionResponse,
  PasskeyRegistrationResponse,
  RegistrationOptionsInput,
  StoredPasskey,
  VerifiedPasskeyAssertion,
  VerifiedPasskeyRegistration,
  WebAuthnAlgorithm,
  WebAuthnConfig,
} from './webauthn.ts';
export {
  InMemoryPasskeyStore,
  PasskeyCredentialExistsError,
  PostgresPasskeyStore,
  SqlitePasskeyStore,
} from './passkey-store.ts';
export type { PasskeyChallengeRecord, PasskeyCredentialRecord, PasskeyStore } from './passkey-store.ts';
export type { BreachChecker, BreachResult } from './breach-check.ts';
export { InMemoryUserStore, EmailTakenError } from './user-store.ts';
export type { UserStore, UserRecord } from './user-store.ts';
export { InMemorySessionStore, SessionService } from './sessions.ts';
export type { SessionStore, SessionRecord, SessionConfig } from './sessions.ts';
export { LoginThrottle, DEFAULT_THROTTLE } from './throttle.ts';
export type { ThrottleConfig } from './throttle.ts';
export { identityMigrations } from './migrations.ts';
export { InMemoryIdentityUnitOfWork } from './unit-of-work.ts';
export type { IdentityUnitOfWork } from './unit-of-work.ts';
export { SqliteIdentityUnitOfWork, SqliteSessionStore, SqliteUserStore } from './sqlite-stores.ts';
export { pgIdentityMigrations } from './postgres-migrations.ts';
export { PostgresIdentityUnitOfWork, PostgresSessionStore, PostgresUserStore } from './postgres-stores.ts';
