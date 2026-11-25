import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { IdentityService, type PublicUser } from '../identity/index.ts';
import type { TrainingDataService } from './training-data-service.ts';

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

/** Every route requires a signed-in user; every record belongs to its owner. */
export function trainingDataRoutes(service: TrainingDataService, identity: IdentityService, cookie: { name: string }): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<PublicUser> => {
    const auth = await identity.authenticate(ctx.cookie(cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/training-data/lake/admit': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, [
          'sourceKind',
          'contentHash',
          'creator',
          'license',
          'derivedFrom',
          'method',
          'sourceTermsScore',
          'consentScore',
          'licenseScore',
          'qualityScore',
          'provenance',
          'provenanceConfidence',
        ]);
        const item = await service.admitLake(user.id, body);
        return { status: 201, body: item };
      },
    },
    '/v1/training-data/lake/compose': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['lakeIds', 'relaxedCreators']);
        const result = await service.composeLakeBatch(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/lake/lineage': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['lakeId']);
        const data = await service.lakeLineage(user.id, body);
        return { status: 200, body: { data, total: data.length } };
      },
    },
    '/v1/training-data/lake/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['page', 'limit']);
        const result = await service.listLakeItems(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/consent/grant': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['workspace', 'user', 'dataType', 'purpose', 'expiresAt']);
        const grant = await service.grantConsent(user.id, body);
        return { status: 201, body: grant };
      },
    },
    '/v1/training-data/consent/revoke': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['workspace', 'user', 'dataType']);
        const result = await service.revokeConsent(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/consent/check': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['workspace', 'user', 'dataType']);
        const result = await service.checkConsent(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/consent/ledger': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['workspace', 'user', 'dataType', 'kind']);
        const data = await service.consentLedgerEvents(user.id, body);
        return { status: 200, body: { data, total: data.length } };
      },
    },
    '/v1/training-data/consent/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['page', 'limit']);
        const result = await service.listConsentGrants(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/synthetic/register': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['provenance', 'generator', 'bases']);
        const record = await service.registerSynthetic(user.id, body);
        return { status: 201, body: record };
      },
    },
    '/v1/training-data/synthetic/chain': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['synId']);
        const data = await service.syntheticChain(user.id, body);
        return { status: 200, body: { data, total: data.length } };
      },
    },
    '/v1/training-data/synthetic/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['page', 'limit']);
        const result = await service.listSynthetic(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/labeling/submit': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['batchId', 'labeler', 'ranking']);
        const label = await service.submitLabel(user.id, body);
        return { status: 201, body: label };
      },
    },
    '/v1/training-data/labeling/borda': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['batchId']);
        const result = await service.bordaTally(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/labeling/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['batchId', 'page', 'limit']);
        const result = await service.listLabels(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/preference/store': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['user', 'item', 'signal']);
        const record = await service.storePreference(user.id, body);
        return { status: 201, body: record };
      },
    },
    '/v1/training-data/preference/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['user', 'page', 'limit']);
        const result = await service.listPreferences(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/codedata/register': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['kind', 'contentHash', 'author', 'parentCode', 'failingTestId']);
        const record = await service.registerCodeData(user.id, body);
        return { status: 201, body: record };
      },
    },
    '/v1/training-data/codedata/deploy': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['codeId', 'toState']);
        const result = await service.deployTransition(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/codedata/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['page', 'limit']);
        const result = await service.listCodeData(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/creative/register': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['creator', 'medium', 'title']);
        const work = await service.registerCreative(user.id, body);
        return { status: 201, body: work };
      },
    },
    '/v1/training-data/creative/approve': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['workId']);
        const result = await service.approveCreative(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/creative/reject': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['workId']);
        const result = await service.rejectCreative(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/creative/publish': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['workId']);
        const result = await service.publishCreative(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/creative/revise': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['workId', 'content']);
        const revision = await service.reviseCreative(user.id, body);
        return { status: 200, body: revision };
      },
    },
    '/v1/training-data/creative/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['page', 'limit']);
        const result = await service.listCreative(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/tokenizer/register': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['corpus', 'vocabSize']);
        const record = await service.registerTokenizer(user.id, body);
        return { status: 201, body: record };
      },
    },
    '/v1/training-data/tokenizer/encode': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['tokId', 'text']);
        const result = await service.encodeText(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/tokenizer/decode': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['tokId', 'indices']);
        const result = await service.decodeText(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/training-data/tokenizer/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['page', 'limit']);
        const result = await service.listTokenizers(user.id, body);
        return { status: 200, body: result };
      },
    },
  };
}
