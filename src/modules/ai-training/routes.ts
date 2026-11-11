import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { IdentityService, sessionCredential, type PublicUser } from '../identity/index.ts';
import type { AiTrainingService } from './ai-training-service.ts';

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

const idOf = (body: Record<string, unknown>, field: string): string => (typeof body[field] === 'string' ? (body[field] as string) : '');

/** Every route requires a signed-in user; assets, runs, suites and experiments belong to their owner. */
export function aiTrainingRoutes(service: AiTrainingService, identity: IdentityService, cookie: { name: string }): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<PublicUser> => {
    const auth = await identity.authenticate(sessionCredential(ctx, cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/ai-training/assets': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const asset = await service.createAsset(user.id, await ctx.json());
        return { status: 201, body: asset };
      },
    },
    '/v1/ai-training/assets/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['page', 'limit', 'kind', 'eligible']);
        const result = await service.listAssets(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/assets/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['id']);
        const asset = await service.getAsset(user.id, idOf(body, 'id'));
        return { status: 200, body: asset };
      },
    },
    '/v1/ai-training/assets/remove': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['id']);
        const result = await service.removeAsset(user.id, idOf(body, 'id'));
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/datasets': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const dataset = await service.buildDataset(user.id, await ctx.json());
        return { status: 201, body: dataset };
      },
    },
    '/v1/ai-training/datasets/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['page', 'limit', 'name']);
        const result = await service.listDatasets(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/datasets/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['id']);
        const dataset = await service.getDataset(user.id, idOf(body, 'id'));
        return { status: 200, body: dataset };
      },
    },
    '/v1/ai-training/runs': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const run = await service.createRun(user.id, await ctx.json());
        return { status: 201, body: run };
      },
    },
    '/v1/ai-training/runs/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['page', 'limit', 'state', 'datasetId']);
        const result = await service.listRuns(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/runs/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['id']);
        const run = await service.getRun(user.id, idOf(body, 'id'));
        return { status: 200, body: run };
      },
    },
    '/v1/ai-training/runs/transition': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const run = await service.transitionRun(user.id, await ctx.json());
        return { status: 200, body: run };
      },
    },
    '/v1/ai-training/runs/checkpoint': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const run = await service.recordRunCheckpoint(user.id, await ctx.json());
        return { status: 200, body: run };
      },
    },
    '/v1/ai-training/runs/cost': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const run = await service.recordRunCost(user.id, await ctx.json());
        return { status: 200, body: run };
      },
    },
    '/v1/ai-training/runs/metric': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const run = await service.recordRunMetric(user.id, await ctx.json());
        return { status: 200, body: run };
      },
    },
    '/v1/ai-training/runs/compare': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.compareRuns(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/eval/suites': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const suite = await service.defineEvalSuite(user.id, await ctx.json());
        return { status: 201, body: suite };
      },
    },
    '/v1/ai-training/eval/suites/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['suiteId', 'version']);
        const suite = await service.getEvalSuite(user.id, body);
        return { status: 200, body: suite };
      },
    },
    '/v1/ai-training/eval/grade': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.gradeEvalSuite(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/eval/panel/vote': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const vote = await service.recordPanelVote(user.id, await ctx.json());
        return { status: 201, body: vote };
      },
    },
    '/v1/ai-training/eval/panel/aggregate': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.aggregatePanelVotes(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/eval/gate': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.applyShipGate(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/safety/batteries': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const battery = await service.defineSafetyBattery(user.id, await ctx.json());
        return { status: 201, body: battery };
      },
    },
    '/v1/ai-training/safety/batteries/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['batteryId']);
        const battery = await service.getSafetyBattery(user.id, idOf(body, 'batteryId'));
        return { status: 200, body: battery };
      },
    },
    '/v1/ai-training/safety/grade': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.gradeSafetyRun(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/safety/ground': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.groundModelClaims(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/safety/contamination': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.checkContamination(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/blind/vote': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const ballot = await service.castBlindVote(user.id, await ctx.json());
        return { status: 201, body: ballot };
      },
    },
    '/v1/ai-training/blind/tally': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.tallyBlindVotes(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/experiments': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const experiment = await service.defineExperiment(user.id, await ctx.json());
        return { status: 201, body: experiment };
      },
    },
    '/v1/ai-training/experiments/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['experimentId']);
        const experiment = await service.getExperiment(user.id, idOf(body, 'experimentId'));
        return { status: 200, body: experiment };
      },
    },
    '/v1/ai-training/experiments/assign': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.assignExperimentVariant(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/experiments/outcome': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.recordExperimentOutcome(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/experiments/tally': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.tallyExperiment(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/agents/events': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const event = await service.recordAgentEvent(user.id, await ctx.json());
        return { status: 201, body: event };
      },
    },
    '/v1/ai-training/agents/scorecards': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.buildAgentScorecards(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/trend/samples': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const sample = await service.recordTrendSample(user.id, await ctx.json());
        return { status: 201, body: sample };
      },
    },
    '/v1/ai-training/trend/build': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.buildEvalTrend(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/mining/batches': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const batch = await service.mineFailureCases(user.id, await ctx.json());
        return { status: 201, body: batch };
      },
    },
    '/v1/ai-training/models/versions': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const record = await service.registerModelVersion(user.id, await ctx.json());
        return { status: 201, body: record };
      },
    },
    '/v1/ai-training/models/versions/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['modelId', 'limit']);
        const result = await service.listModelVersions(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/models/cards': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const card = await service.buildModelCard(user.id, await ctx.json());
        return { status: 201, body: card };
      },
    },
    '/v1/ai-training/models/promote': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.promoteModel(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/serving/scale': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const plan = await service.planScale(user.id, await ctx.json());
        return { status: 201, body: plan };
      },
    },
    '/v1/ai-training/serving/quantize': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const plan = await service.planQuantization(user.id, await ctx.json());
        return { status: 201, body: plan };
      },
    },
    '/v1/ai-training/serving/bundle': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const plan = await service.planDeviceBundle(user.id, await ctx.json());
        return { status: 201, body: plan };
      },
    },
    '/v1/ai-training/serving/route': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const plan = await service.routeCascade(user.id, await ctx.json());
        return { status: 201, body: plan };
      },
    },
    '/v1/ai-training/serving/plans/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['kind', 'limit']);
        const result = await service.listServingPlans(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/ops/cache/lookup': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.cacheLookup(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/ops/cache/admit': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.cacheAdmit(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/ops/streams/start': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const state = await service.streamStart(user.id, await ctx.json());
        return { status: 201, body: state };
      },
    },
    '/v1/ai-training/ops/streams/event': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const state = await service.streamEvent(user.id, await ctx.json());
        return { status: 200, body: state };
      },
    },
    '/v1/ai-training/ops/streams/resume': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.streamResume(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/ops/metrics': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.recordServingMetrics(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/ops/shadow': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.evaluateShadowDeployment(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/ops/rollback': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.planInstantRollback(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/providers': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const provider = await service.upsertGatewayProvider(user.id, await ctx.json());
        return { status: 201, body: provider };
      },
    },
    '/v1/ai-training/gateway/providers/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['limit']);
        const result = await service.listGatewayProviders(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/call': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.recordProviderCall(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/route': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.planGatewayRoute(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/failover': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.planFailoverChain(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/byok': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.registerByokKey(user.id, await ctx.json());
        return { status: 201, body: result };
      },
    },
    '/v1/ai-training/gateway/policy': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.enforceDataPolicy(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/accounting': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.providerAccounting(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/logs': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.recordGatewayLog(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/logs/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['providerId', 'limit']);
        const result = await service.listGatewayLogs(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/retention': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.retentionDecision(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/retention/route': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.planRetentionRoute(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/capabilities': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.upsertCapabilities(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/capabilities/match': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.matchCapabilities(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/toolcall': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.normalizeToolCall(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/schemas': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.registerOutputSchema(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/gateway/schemas/validate': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.validateOutput(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/access/pin': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.pinVersion(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/access/unpin': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.unpinVersion(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/access/resolve': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.resolveVersion(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/access/reserve': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.reserveSlots(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/access/release': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.releaseSlots(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/access/packages': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.buildPackage(user.id, await ctx.json());
        return { status: 201, body: result };
      },
    },
    '/v1/ai-training/access/packages/verify': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.verifyPackage(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/tuning/define': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.createTuningPipeline(user.id, await ctx.json());
        return { status: 201, body: result };
      },
    },
    '/v1/ai-training/tuning/advance': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.advanceTuningStage(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/tuning/status': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.tuningStatus(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/distill/plan': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.planDistillation(user.id, await ctx.json());
        return { status: 201, body: result };
      },
    },
    '/v1/ai-training/distill/advance': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.advanceDistillationStage(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/ai-training/distill/status': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.distillationStatus(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
  };
}
