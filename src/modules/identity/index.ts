/** Public surface of the identity module. Other modules import from here and nowhere deeper. */
export { IdentityService, toPublicUser } from './identity-service.ts';
export type { IdentityDeps, PublicUser, RequestMeta, SignInResult } from './identity-service.ts';
export { IdentityEvents, IDENTITY_EVENT_VERSION } from './events.ts';
export type { IdentityEventType } from './events.ts';
export { identityRoutes } from './routes.ts';
export { PasswordHasher } from './password-hasher.ts';
export type { HasherConfig, ScryptParams } from './password-hasher.ts';
export { HibpBreachChecker, LocalBlocklistChecker, CompositeBreachChecker } from './breach-check.ts';
export type { BreachChecker, BreachResult } from './breach-check.ts';
export { InMemoryUserStore } from './user-store.ts';
export type { UserStore, UserRecord } from './user-store.ts';
export { InMemorySessionStore, SessionService } from './sessions.ts';
export type { SessionStore, SessionRecord, SessionConfig } from './sessions.ts';
export { LoginThrottle, DEFAULT_THROTTLE } from './throttle.ts';
export type { ThrottleConfig } from './throttle.ts';
