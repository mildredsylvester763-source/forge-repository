import type { Clock } from '../../kernel/clock.ts';
import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { serializeCookie } from '../../kernel/http.ts';
import { parseFields } from '../../kernel/validate.ts';
import { bearerSessionToken, sessionCredential } from './request-auth.ts';
import type { IdentityService, RequestMeta } from './identity-service.ts';

export interface CookieSettings {
  name: string;
  secure: boolean;
}

const meta = (ctx: RequestContext): RequestMeta => ({ ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });

export function identityRoutes(identity: IdentityService, cookie: CookieSettings, clock: Clock): RouteTable {
  const clearCookie = serializeCookie(cookie.name, '', { maxAgeSec: 0, secure: cookie.secure });

  return {
    '/v1/auth/register': {
      POST: async (ctx): Promise<HttpResult> => {
        const body = parseFields(await ctx.json(), {
          email: { max: 320 },
          password: { max: 1024 },
          displayName: { max: 200, optional: true },
        });
        const user = await identity.register(body, meta(ctx));
        return { status: 201, body: { user } };
      },
    },

    '/v1/auth/sign-in': {
      POST: async (ctx): Promise<HttpResult> => {
        const body = parseFields(await ctx.json(), { email: { max: 320 }, password: { max: 1024 } });
        const result = await identity.signIn(body, meta(ctx));
        const maxAgeSec = (result.sessionExpiresAt - clock()) / 1000;
        return {
          status: 200,
          body: { user: result.user, passwordChangeRequired: result.passwordChangeRequired },
          headers: { 'Set-Cookie': serializeCookie(cookie.name, result.sessionToken, { maxAgeSec, secure: cookie.secure }) },
        };
      },
    },

    '/v1/auth/native/sign-in': {
      POST: async (ctx): Promise<HttpResult> => {
        const body = parseFields(await ctx.json(), { email: { max: 320 }, password: { max: 1024 } });
        const result = await identity.signIn(body, meta(ctx));
        return {
          status: 200,
          body: {
            user: result.user,
            tokenType: 'Bearer',
            sessionToken: result.sessionToken,
            expiresAt: new Date(result.sessionExpiresAt).toISOString(),
            passwordChangeRequired: result.passwordChangeRequired,
          },
        };
      },
    },

    '/v1/auth/sign-out': {
      POST: async (ctx): Promise<HttpResult> => {
        const hasAuthorization = ctx.header('authorization') !== undefined;
        const token = sessionCredential(ctx, cookie.name);
        if (hasAuthorization && !token) throw new AppError(401, 'unauthenticated', 'Sign in required.');
        await identity.signOut(token, meta(ctx));
        return { status: 204, ...(hasAuthorization ? {} : { headers: { 'Set-Cookie': clearCookie } }) };
      },
    },

    '/v1/auth/native/sign-out': {
      POST: async (ctx): Promise<HttpResult> => {
        const token = bearerSessionToken(ctx);
        if (!token) throw new AppError(401, 'unauthenticated', 'A bearer session token is required.');
        await identity.signOut(token, meta(ctx));
        return { status: 204 };
      },
    },

    '/v1/auth/sessions': {
      GET: async (ctx): Promise<HttpResult> => {
        const sessions = await identity.listSessions(sessionCredential(ctx, cookie.name));
        return { status: 200, body: { sessions } };
      },
    },

    '/v1/auth/sessions/revoke': {
      POST: async (ctx): Promise<HttpResult> => {
        const body = parseFields(await ctx.json(), { sessionId: { max: 64 } });
        const result = await identity.revokeSession(sessionCredential(ctx, cookie.name), body.sessionId, meta(ctx));
        return {
          status: 200,
          body: { revoked: result.revoked },
          ...(result.revokedCurrentSession && ctx.header('authorization') === undefined ? { headers: { 'Set-Cookie': clearCookie } } : {}),
        };
      },
    },

    '/v1/auth/me': {
      GET: async (ctx): Promise<HttpResult> => {
        const auth = await identity.authenticate(sessionCredential(ctx, cookie.name));
        if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
        return { status: 200, body: { user: auth.user } };
      },
    },
  };
}
