import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { IdentityService, type PublicUser } from '../identity/index.ts';
import type { LiveTestingService } from './live-testing-service.ts';

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) throw invalidField(field, 'invalid');
  return value.trim();
}

/** Every route requires a signed-in user; sessions belong to their owner, participants act within their role. */
export function liveTestingRoutes(service: LiveTestingService, identity: IdentityService, cookie: { name: string }): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<PublicUser> => {
    const auth = await identity.authenticate(ctx.cookie(cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/live-testing/personas': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { personas: service.personaCatalog() } };
      },
    },
    '/v1/live-testing/collaboration/roles': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { roles: service.roleCatalog() } };
      },
    },
    '/v1/live-testing/sessions': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const sessions = await service.listSessions(user.id);
        return { status: 200, body: { sessions } };
      },
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const session = await service.createSession(user.id, await ctx.json());
        return { status: 201, body: { session } };
      },
    },
    '/v1/live-testing/sessions/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['sessionId']);
        const detail = await service.getSession(user.id, requireString(body, 'sessionId'));
        return { status: 200, body: detail };
      },
    },
    '/v1/live-testing/sessions/start': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const session = await service.startSession(user.id, await ctx.json());
        return { status: 200, body: { session } };
      },
    },
    '/v1/live-testing/sessions/pause': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const session = await service.pauseSession(user.id, await ctx.json());
        return { status: 200, body: { session } };
      },
    },
    '/v1/live-testing/sessions/resume': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const session = await service.resumeSession(user.id, await ctx.json());
        return { status: 200, body: { session } };
      },
    },
    '/v1/live-testing/sessions/control': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const session = await service.takeControl(user.id, await ctx.json());
        return { status: 200, body: { session } };
      },
    },
    '/v1/live-testing/sessions/hand-back': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const session = await service.handBack(user.id, await ctx.json());
        return { status: 200, body: { session } };
      },
    },
    '/v1/live-testing/sessions/complete': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const session = await service.completeSession(user.id, await ctx.json());
        return { status: 200, body: { session } };
      },
    },
    '/v1/live-testing/sessions/fail': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const session = await service.failSession(user.id, await ctx.json());
        return { status: 200, body: { session } };
      },
    },
    '/v1/live-testing/sessions/cancel': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const session = await service.cancelSession(user.id, await ctx.json());
        return { status: 200, body: { session } };
      },
    },
    '/v1/live-testing/sessions/steps': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const step = await service.recordStep(user.id, await ctx.json());
        return { status: 201, body: { step } };
      },
    },
    '/v1/live-testing/sessions/messages': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const message = await service.postMessage(user.id, await ctx.json());
        return { status: 201, body: { message } };
      },
    },
    '/v1/live-testing/sessions/findings': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const finding = await service.reportFinding(user.id, await ctx.json());
        return { status: 201, body: { finding } };
      },
    },
    '/v1/live-testing/sessions/recording': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['sessionId']);
        const recording = await service.buildRecording(user.id, requireString(body, 'sessionId'));
        return { status: 200, body: recording };
      },
    },
    '/v1/live-testing/sessions/bug-report': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['sessionId']);
        const result = await service.assembleBugReport(user.id, requireString(body, 'sessionId'));
        return { status: 200, body: result };
      },
    },
    '/v1/live-testing/sessions/convert': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['sessionId']);
        const result = await service.convertSessionForUser(user.id, requireString(body, 'sessionId'));
        return { status: 200, body: result };
      },
    },
    '/v1/live-testing/personas/custom': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const persona = await service.createCustomPersona(user.id, await ctx.json());
        return { status: 201, body: { persona } };
      },
    },
    '/v1/live-testing/personas/custom/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        const workspace =
          typeof body.workspace === 'string' && body.workspace.trim().length > 0
            ? body.workspace.trim().slice(0, 64)
            : null;
        const personas = await service.listCustomPersonas(user.id, workspace);
        return { status: 200, body: { personas } };
      },
    },
    '/v1/live-testing/personas/custom/delete': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['personaId']);
        const result = await service.deleteCustomPersona(user.id, requireString(body, 'personaId'));
        return { status: 200, body: result };
      },
    },
    '/v1/live-testing/sessions/participants/invite': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const participant = await service.inviteParticipant(user.id, await ctx.json());
        return { status: 201, body: { participant } };
      },
    },
    '/v1/live-testing/sessions/participants/accept': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['participantId']);
        const participant = await service.acceptInvitation(user.id, requireString(body, 'participantId'));
        return { status: 200, body: { participant } };
      },
    },
    '/v1/live-testing/sessions/participants/revoke': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['participantId']);
        const result = await service.revokeParticipant(user.id, requireString(body, 'participantId'));
        return { status: 200, body: result };
      },
    },
    '/v1/live-testing/sessions/participants/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.listParticipants(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
  };
}
