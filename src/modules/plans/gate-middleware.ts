import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../kernel/errors.ts';
import { serializeCookie, type HttpResult, type Method, type RouteHandler, type RouteTable } from '../../kernel/http.ts';
import { IdentityService } from '../identity/index.ts';
import { gateForRoute } from './engine/route-gates.ts';
import type { PlansService } from './plans-service.ts';

/**
 * Wraps the merged route table with the PLAN GATE LAW through the ONE access check (Hook 2):
 * every gated route asks canUse, and nothing else decides. A gated route first proves the
 * caller is signed in (401), then asks canUse: a switched-off feature answers 503
 * (feature_off, flipped in config without a release), a plan below the gate answers 402
 * (plan_required, with the feature, gate, current plan and reason). Free and internal rows
 * still pass through canUse so account pauses and feature switches apply. Public identity
 * routes use the same check without a user; IdentityService owns their sign-in throttles.
 */
const DEVICE_COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60;
const DEVICE_COOKIE_MAX_AGE_MS = DEVICE_COOKIE_MAX_AGE_SEC * 1000;
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readDeviceId(token: string | undefined, secret: Buffer): string | null {
  if (token === undefined || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0] ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(parts[1] ?? '')) return null;
  const supplied = Buffer.from(parts[1] ?? '', 'base64url');
  const expected = createHmac('sha256', secret).update(parts[0] ?? '').digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    if (payload.v !== 1 || typeof payload.id !== 'string' || !DEVICE_ID_PATTERN.test(payload.id) ||
      typeof payload.expiresAt !== 'number' || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= Date.now()) return null;
    return payload.id;
  } catch {
    return null;
  }
}

function issueDeviceToken(secret: Buffer): { id: string; token: string } {
  const id = randomUUID();
  const payload = Buffer.from(JSON.stringify({ v: 1, id, expiresAt: Date.now() + DEVICE_COOKIE_MAX_AGE_MS })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return { id, token: payload + '.' + signature };
}

function appendDeviceCookie(result: HttpResult, value: string): HttpResult {
  const existing = result.headers?.['Set-Cookie'];
  const values = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  return { ...result, headers: { ...result.headers, 'Set-Cookie': [...values, value] } };
}

export function applyRouteGates(
  routes: RouteTable,
  plans: PlansService,
  identity: IdentityService,
  cookie: { name: string; secure: boolean; deviceName: string; deviceSecret: Buffer },
): RouteTable {
  const wrapped: RouteTable = {};
  for (const [path, entry] of Object.entries(routes)) {
    const decision = gateForRoute(path);
    if (decision === null) {
      wrapped[path] = entry;
      continue;
    }
    const authRoute = path.startsWith('/v1/auth/');
    const gated: Partial<Record<Method, RouteHandler>> = {};
    for (const method of Object.keys(entry) as Method[]) {
      const handler = entry[method];
      if (handler === undefined) continue;
      gated[method] = async (ctx) => {
        if (authRoute) {
          const verdict = await plans.canUse(null, decision.feature);
          if (!verdict.allowed) {
            if (verdict.reason === 'feature_off') {
              throw new AppError(503, 'feature_off', 'This feature is temporarily switched off.', {
                details: { feature: verdict.feature, gate: verdict.gate, plan: verdict.plan, reason: verdict.reason },
              });
            }
            if (verdict.reason === 'team_seats_required') throw new AppError(402, 'team_seats_required', 'This Team feature requires at least three workspace seats.', { details: { feature: verdict.feature, gate: verdict.gate, plan: verdict.plan, minimumSeats: 3 } });
            throw new AppError(402, 'plan_required', `The ${verdict.feature} feature is not part of the ${verdict.plan} plan.`,
              details: { feature: verdict.feature, gate: verdict.gate, plan: verdict.plan, reason: verdict.reason },
            });
          }
          return handler(ctx);
        }

        const auth = await identity.authenticate(ctx.cookie(cookie.name));
        if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');

        let deviceCookie: string | null = null;
        if (plans.deviceRateLimitEnabled()) {
          let deviceId = readDeviceId(ctx.cookie(cookie.deviceName), cookie.deviceSecret);
          if (deviceId === null) {
            const issued = issueDeviceToken(cookie.deviceSecret);
            deviceId = issued.id;
            deviceCookie = serializeCookie(cookie.deviceName, issued.token, {
              maxAgeSec: DEVICE_COOKIE_MAX_AGE_SEC,
              secure: cookie.secure,
            });
          }
          const deviceLimit = await plans.enforceDeviceRateLimit(deviceId);
          if (!deviceLimit.ok) {
            throw new AppError(429, 'rate_limited', 'Too many requests. Slow down.', {
              details: { scope: 'device', retryAfterMs: deviceLimit.retryAfterMs },
              ...(deviceCookie === null ? {} : { headers: { 'Set-Cookie': deviceCookie } }),
            });
          }
        }

        try {
          const userLimit = await plans.enforceUserRateLimit(auth.user.id);
          if (!userLimit.ok) {
            throw new AppError(429, 'rate_limited', 'Too many requests. Slow down.', {
              details: { scope: 'user', retryAfterMs: userLimit.retryAfterMs },
            });
          }
          const verdict = await plans.canUse(auth.user.id, decision.feature);
          if (!verdict.allowed) {
            if (verdict.reason === 'feature_off') {
              throw new AppError(503, 'feature_off', 'This feature is temporarily switched off.', {
                details: { feature: verdict.feature, gate: verdict.gate, plan: verdict.plan, reason: verdict.reason },
              });
            }
            if (verdict.reason === 'team_seats_required') throw new AppError(402, 'team_seats_required', 'This Team feature requires at least three workspace seats.', { details: { feature: verdict.feature, gate: verdict.gate, plan: verdict.plan, minimumSeats: 3 } });
            throw new AppError(402, 'plan_required', `The ${verdict.feature} feature is not part of the ${verdict.plan} plan.`,
              details: { feature: verdict.feature, gate: verdict.gate, plan: verdict.plan, reason: verdict.reason },
            });
          }
          const result = await handler(ctx);
          return deviceCookie === null ? result : appendDeviceCookie(result, deviceCookie);
        } catch (error) {
          if (deviceCookie !== null && error instanceof AppError) {
            throw new AppError(error.status, error.code, error.message, {
              details: error.details,
              headers: { ...error.headers, 'Set-Cookie': deviceCookie },
            });
          }
          throw error;
        }
      };
    }
    wrapped[path] = gated;
  }
  return wrapped;
}
