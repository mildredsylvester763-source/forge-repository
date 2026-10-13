import type { Clock } from '../../kernel/clock.ts';
import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { serializeCookie } from '../../kernel/http.ts';
import { parseFields } from '../../kernel/validate.ts';
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

    '/v1/auth/sign-out': {
      POST: async (ctx): Promise<HttpResult> => {
        await identity.signOut(ctx.cookie(cookie.name), meta(ctx));
        return { status: 204, headers: { 'Set-Cookie': clearCookie } };
      },
    },

    '/v1/auth/me': {
      GET: async (ctx): Promise<HttpResult> => {
        const auth = await identity.authenticate(ctx.cookie(cookie.name));
        if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
        return { status: 200, body: { user: auth.user } };
      },
    },
  };
}
