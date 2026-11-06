import { isIP } from 'node:net';
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

function normalizedIp(value: string): string | null {
  const ip = value.trim();
  return ip && isIP(ip) !== 0 ? ip : null;
}

function normalizedUserAgent(value: string): string | null {
  const userAgent = value.trim();
  return userAgent && userAgent.toLowerCase() !== 'unknown' && userAgent.length <= 512 ? userAgent : null;
}

/**
 * Observe differences from the account's active-session baseline.
 *
 * This is deliberately a signal detector, not an authorization or blocking policy:
 * thresholds, automated challenges, notifications and account lock actions are not inferred.
 * Raw IP and user-agent values are never copied into the result. Each dimension is compared
 * only when both the current request and at least one baseline session contain usable metadata.
 */
export function assessSignInAnomaly(
  current: SignInFingerprint,
  activeSessions: readonly Pick<SessionRecord, 'ip' | 'userAgent'>[],
): SignInAnomalyAssessment {
  if (activeSessions.length === 0) return { baseline: 'none', signals: [] };

  const currentIp = normalizedIp(current.ip);
  const currentUserAgent = normalizedUserAgent(current.userAgent);
  const baseline = activeSessions.map((session) => ({
    ip: normalizedIp(session.ip),
    userAgent: normalizedUserAgent(session.userAgent),
  }));
  const baselineIps = baseline.flatMap((session) => session.ip ? [session.ip] : []);
  const baselineUserAgents = baseline.flatMap((session) => session.userAgent ? [session.userAgent] : []);
  const baselineDevices = baseline.filter((session): session is { ip: string; userAgent: string } =>
    session.ip !== null && session.userAgent !== null);

  if (!currentIp && !currentUserAgent) return { baseline: 'insufficient_metadata', signals: [] };
  if (baselineIps.length === 0 && baselineUserAgents.length === 0) {
    return { baseline: 'insufficient_metadata', signals: [] };
  }

  const signals: SignInAnomalySignal[] = [];
  if (currentIp && baselineIps.length > 0 && !baselineIps.includes(currentIp)) {
    signals.push('new_active_session_ip');
  }
  if (currentUserAgent && baselineUserAgents.length > 0 && !baselineUserAgents.includes(currentUserAgent)) {
    signals.push('new_active_session_user_agent');
  }
  if (currentIp && currentUserAgent && baselineDevices.length > 0 &&
      !baselineDevices.some((session) => session.ip === currentIp && session.userAgent === currentUserAgent)) {
    signals.push('new_active_session_device');
  }

  return { baseline: 'active_sessions', signals };
}
