import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import type { SyncConflict, SyncEntity, SyncInput, SyncResolveResult, SyncResult } from '../../kernel/offline-sync.ts';
import { sessionCredential } from '../identity/request-auth.ts';

interface AuthenticatedIdentity {
  authenticate(token: string | undefined): Promise<{ user: { id: string } } | null>;
}

interface OfflineSyncApi {
  apply(ownerId: string, input: SyncInput): Promise<SyncResult>;
  getEntity(ownerId: string, entityType: string, entityId: string): Promise<SyncEntity | null>;
  listOpenConflicts(ownerId: string, limit?: number): Promise<SyncConflict[]>;
  resolveConflict(
    ownerId: string,
    conflictId: string,
    resolution: 'keep_current' | 'accept_incoming',
    resolvedBy: string,
  ): Promise<SyncResolveResult>;
}

interface CookieSettings { name: string; }

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

function requiredString(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw invalidField(field, 'invalid');
  return value;
}

function mapSyncError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof Error && error.name === 'OfflineSyncError' && 'code' in error) {
    const code = String((error as Error & { code: unknown }).code);
    const status = code === 'conflict_not_found' ? 404
      : ['operation_id_reused', 'operation_sequence_reused', 'conflict_changed', 'conflict_already_resolved'].includes(code) ? 409
      : 400;
    throw new AppError(status, code, error.message, { cause: error });
  }
  throw error;
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    return mapSyncError(error);
  }
}

/** Offline synchronization is always scoped to the authenticated owner; clients cannot choose owner IDs. */
export function offlineSyncRoutes(
  service: OfflineSyncApi,
  identity: AuthenticatedIdentity,
  cookie: CookieSettings,
): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<{ id: string }> => {
    const auth = await identity.authenticate(sessionCredential(ctx, cookie.name));
    if (!auth?.user?.id) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/sync/operations': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = await ctx.json();
        rejectUnknownFields(body, ['clientId', 'sequence', 'entityType', 'entityId', 'baseVersion', 'kind', 'payload', 'causalClock']);
        const result = await call(() => service.apply(user.id, body as unknown as SyncInput));
        return { status: result.status === 'conflict' ? 409 : 200, body: { result } };
      },
    },
    '/v1/sync/entities/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = await ctx.json();
        rejectUnknownFields(body, ['entityType', 'entityId']);
        const entityType = requiredString(body, 'entityType', 64);
        const entityId = requiredString(body, 'entityId', 128);
        if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(entityType)) throw invalidField('entityType', 'invalid');
        const entity = await call(() => service.getEntity(user.id, entityType, entityId));
        return { status: 200, body: { entity } };
      },
    },
    '/v1/sync/conflicts': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const conflicts = await call(() => service.listOpenConflicts(user.id));
        return { status: 200, body: { conflicts } };
      },
    },
    '/v1/sync/conflicts/resolve': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = await ctx.json();
        rejectUnknownFields(body, ['conflictId', 'resolution']);
        const conflictId = requiredString(body, 'conflictId', 64);
        const resolution = requiredString(body, 'resolution', 32);
        if (resolution !== 'keep_current' && resolution !== 'accept_incoming') throw invalidField('resolution', 'invalid');
        const result = await call(() => service.resolveConflict(user.id, conflictId, resolution, user.id));
        return { status: 200, body: { result } };
      },
    },
  };
}
