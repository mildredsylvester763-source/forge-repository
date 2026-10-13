/**
 * The identity module's published event contract (a small schema registry, CO-067).
 * Other modules (policy, graph, audit views, AI agents) subscribe to these; they never reach into identity internals.
 * Payloads never contain passwords, hashes, tokens, or raw email addresses.
 */
export const IdentityEvents = {
  UserRegistered: 'identity.user.registered',
  RegistrationRejected: 'identity.registration.rejected',
  SignInSucceeded: 'identity.sign_in.succeeded',
  SignInFailed: 'identity.sign_in.failed',
  SignInThrottled: 'identity.sign_in.throttled',
  SignedOut: 'identity.sign_out.completed',
  PasswordCompromisedDetected: 'identity.password.compromised_detected',
  BreachCheckSkipped: 'identity.password.breach_check_skipped',
} as const;

export type IdentityEventType = (typeof IdentityEvents)[keyof typeof IdentityEvents];
export const IDENTITY_EVENT_VERSION = 1;
