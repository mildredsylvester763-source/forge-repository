import type { SessionRecord } from './sessions.ts';

export type SignInAnomalySignal =
  | 'new_active_session_ip'
  | 'new_active_session_user_agent'
  | 'new_active_session_device';

export interface SignInFingerprint {
  ip: string;
  userAgent: string;
}

export interface SignInAnomalyAssessment {
  /** A baseline is limited to sessions currently active under the identity session policy. */
  baseline: 'active_sessions' | 'none' | 'insufficient_metadata';
  signals: SignInAnomalySignal[];
}

/**
 * Observe differences from the account's active-session baseline.
 *
 * This is deliberately a signal detector, not an authorization or blocking policy:
 * thresholds, automated challenges, notifications and account lock actions are not inferred.
 * Raw IP and user-agent values are never copied into the result.
 */
export function assessSignInAnomaly(
  current: SignInFingerprint,
  activeSessions: readonly Pick<SessionRecord, 'ip' | 'userAgent'>[],
): SignInAnomalyAssessment {
  if (activeSessions.length === 0) return { baseline: 'none', signals: [] };

  const ip = current.ip.trim();
  const userAgent = current.userAgent.trim();
  if (!ip || ip === 'unknown' || !userAgent) {
    return { baseline: 'insufficient_metadata', signals: [] };
  }

  const knownIp = activeSessions.some((session) => session.ip === ip);
  const knownUserAgent = activeSessions.some((session) => session.userAgent === userAgent);
  const knownDevice = activeSessions.some((session) => session.ip === ip && session.userAgent === userAgent);
  const signals: SignInAnomalySignal[] = [];

  if (!knownIp) signals.push('new_active_session_ip');
  if (!knownUserAgent) signals.push('new_active_session_user_agent');
  if (!knownDevice) signals.push('new_active_session_device');

  return { baseline: 'active_sessions', signals };
}
