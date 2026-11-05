import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { serializeCookie } from '../../kernel/http.ts';
import { parseFields } from '../../kernel/validate.ts';
import { sessionCredential } from './request-auth.ts';
import type { IdentityService, RequestMeta } from './identity-service.ts';
import type { PasskeyService } from './passkey-service.ts';
import type { PasskeyAssertionResponse, PasskeyRegistrationResponse } from './webauthn.ts';
import type { CookieSettings } from './routes.ts';

const meta = (ctx: RequestContext): RequestMeta => ({ ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'invalid_request', 'The request body must be an object.');
  }
  return value as Record<string, unknown>;
}
function nestedString(value: unknown, key: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new AppError(400, 'invalid_request', 'The passkey response is malformed.', {
      details: { field: key, reason: 'invalid_string' },
    });
  }
  return value;
}
function registrationResponse(value: unknown): PasskeyRegistrationResponse {
  const body = objectBody(value);
  const response = objectBody(body.response);
  const id = nestedString(body.id, 'id', 1400);
  const rawId = nestedString(body.rawId, 'rawId', 1400);
  const type = nestedString(body.type, 'type', 32);
  const clientDataJSON = nestedString(response.clientDataJSON, 'response.clientDataJSON', 24_000);
  const attestationObject = nestedString(response.attestationObject, 'response.attestationObject', 100_000);
  let transports: string[] | undefined;
  if (response.transports !== undefined) {
    if (!Array.isArray(response.transports) || response.transports.length > 8 ||
      response.transports.some((transport) => typeof transport !== 'string' || transport.length > 32)) {
      throw new AppError(400, 'invalid_request', 'The passkey transports are malformed.');
    }
    transports = response.transports as string[];
  }
  return {
    id, rawId, type,
    response: { clientDataJSON, attestationObject, ...(transports ? { transports } : {}) },
  };
}
function assertionResponse(value: unknown): PasskeyAssertionResponse {
  const body = objectBody(value);
  const response = objectBody(body.response);
  const id = nestedString(body.id, 'id', 1400);
  const rawId = nestedString(body.rawId, 'rawId', 1400);
  const type = nestedString(body.type, 'type', 32);
  const clientDataJSON = nestedString(response.clientDataJSON, 'response.clientDataJSON', 24_000);
  const authenticatorData = nestedString(response.authenticatorData, 'response.authenticatorData', 100_000);
  const signature = nestedString(response.signature, 'response.signature', 2_000);
  let userHandle: string | null | undefined;
  if (response.userHandle === null) userHandle = null;
  else if (response.userHandle !== undefined) userHandle = nestedString(response.userHandle, 'response.userHandle', 128);
  return {
    id, rawId, type,
    response: {
      clientDataJSON,
      authenticatorData,
      signature,
      ...(userHandle !== undefined ? { userHandle } : {}),
    },
  };
}

export function passkeyRoutes(
  passkeys: PasskeyService,
  identity: IdentityService,
  cookie: CookieSettings,
): RouteTable {
  const requireUser = async (ctx: RequestContext) => {
    const auth = await identity.authenticate(sessionCredential(ctx, cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/auth/passkeys': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        return { status: 200, body: { passkeys: await passkeys.listForUser(user.id) } };
      },
    },
    '/v1/auth/passkeys/registration/options': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        return { status: 200, body: await passkeys.beginRegistration(user) };
      },
    },
    '/v1/auth/passkeys/registration/complete': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const response = registrationResponse(await ctx.json());
        const credential = await passkeys.completeRegistration(user, response, meta(ctx));
        return { status: 201, body: { passkey: credential } };
      },
    },
    '/v1/auth/passkeys/authentication/options': {
      POST: async (): Promise<HttpResult> => ({ status: 200, body: await passkeys.beginAuthentication() }),
    },
    '/v1/auth/passkeys/authentication/complete': {
      POST: async (ctx): Promise<HttpResult> => {
        const response = assertionResponse(await ctx.json());
        const result = await passkeys.completeAuthentication(response, meta(ctx));
        const maxAgeSec = (result.sessionExpiresAt - Date.now()) / 1000;
        return {
          status: 200,
          body: { user: result.user, passwordChangeRequired: result.passwordChangeRequired },
          headers: { 'Set-Cookie': serializeCookie(cookie.name, result.sessionToken, { maxAgeSec, secure: cookie.secure }) },
        };
      },
    },
    '/v1/auth/passkeys/remove': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { credentialId: { max: 1400 } });
        await passkeys.removeForUser(user.id, body.credentialId, meta(ctx));
        return { status: 204 };
      },
    },
  };
}
