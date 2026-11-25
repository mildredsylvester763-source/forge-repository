import type { RequestContext } from '../../kernel/http.ts';

const BEARER_TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/i;

/** Return a syntactically valid opaque session token from Authorization, if supplied. */
export function bearerSessionToken(ctx: Pick<RequestContext, 'header'>): string | undefined {
  const authorization = ctx.header('authorization');
  if (authorization === undefined) return undefined;
  return BEARER_TOKEN.exec(authorization.trim())?.[1];
}

/**
 * Prefer an explicitly supplied Authorization header. A malformed bearer header fails closed;
 * it must never silently fall back to a different browser cookie session.
 */
export function sessionCredential(
  ctx: Pick<RequestContext, 'header' | 'cookie'>,
  cookieName: string,
): string | undefined {
  return ctx.header('authorization') === undefined
    ? ctx.cookie(cookieName)
    : bearerSessionToken(ctx);
}
