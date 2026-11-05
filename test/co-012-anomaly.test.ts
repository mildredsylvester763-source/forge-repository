import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessSignInAnomaly } from '../src/modules/identity/identity-anomaly.ts';

describe('CO-012 observe-only sign-in anomaly assessment', () => {
  const existing = [
    { ip: '192.0.2.10', userAgent: 'FORGE Android 1.0' },
    { ip: '192.0.2.20', userAgent: 'FORGE Desktop 1.0' },
  ] as const;

  it('does not report an anomaly for an observed active-session device', () => {
    assert.deepEqual(
      assessSignInAnomaly({ ip: '192.0.2.10', userAgent: 'FORGE Android 1.0' }, existing),
      { baseline: 'active_sessions', signals: [] },
    );
  });

  it('flags a new IP while recognizing a previously active user agent', () => {
    assert.deepEqual(
      assessSignInAnomaly({ ip: '198.51.100.7', userAgent: 'FORGE Android 1.0' }, existing),
      {
        baseline: 'active_sessions',
        signals: ['new_active_session_ip', 'new_active_session_device'],
      },
    );
  });

  it('flags a new user agent without making an authorization decision', () => {
    const result = assessSignInAnomaly({ ip: '192.0.2.10', userAgent: 'New browser' }, existing);
    assert.deepEqual(result, {
      baseline: 'active_sessions',
      signals: ['new_active_session_user_agent', 'new_active_session_device'],
    });
    assert.equal('blocked' in result, false);
    assert.equal('riskScore' in result, false);
  });

  it('reports no baseline when the account has no active sessions', () => {
    assert.deepEqual(
      assessSignInAnomaly({ ip: '192.0.2.10', userAgent: 'FORGE Android 1.0' }, []),
      { baseline: 'none', signals: [] },
    );
  });

  it('does not infer signals from missing client metadata', () => {
    assert.deepEqual(
      assessSignInAnomaly({ ip: 'unknown', userAgent: '' }, existing),
      { baseline: 'insufficient_metadata', signals: [] },
    );
  });

  it('returns signal names only, never the supplied IP or user-agent values', () => {
    const result = assessSignInAnomaly({ ip: '198.51.100.77', userAgent: 'Private Browser 9.2' }, existing);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('198.51.100.77'), false);
    assert.equal(serialized.includes('Private Browser 9.2'), false);
  });
});
