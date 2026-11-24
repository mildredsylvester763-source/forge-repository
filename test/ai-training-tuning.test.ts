import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, setPlanForTest, startHarness, type Harness } from './helpers.ts';

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

const TUNING_BODY = {
  pipelineId: 'tune-1',
  method: 'rlhf',
  pairs: [
    { prompt: 'p1', chosen: 'a', rejected: 'b' },
    { prompt: 'p2', chosen: 'c', rejected: 'd' },
    { prompt: 'p1', chosen: 'a', rejected: 'b' },
  ],
  hyperparams: { learningRate: 0.01, beta: 0.1, epochs: 3 },
};

const DISTILL_BODY = {
  planId: 'distill-1',
  teacherModelId: 'teacher-x',
  teacherVersion: 2,
  studentModelId: 'student-y',
  teacherParams: 70000,
  studentParams: 7000,
  samples: [{ prompt: 'q', teacherOutput: 'o' }],
  qualityGate: 0.8,
};

const TRACK_BODY = {
  experimentId: 'track-1',
  config: { lr: 0.01, tags: 'baseline' },
  metrics: ['loss', 'acc'],
};

describe('ai-training tuning, distillation and experiment tracking (AI-015/016/018)', () => {
  it('refuses the new routes without a session', async () => {
    const h = await startHarness();
    try {
      const paths = [
        '/v1/ai-training/tuning/define',
        '/v1/ai-training/tuning/advance',
        '/v1/ai-training/tuning/status',
        '/v1/ai-training/distill/plan',
        '/v1/ai-training/distill/advance',
        '/v1/ai-training/distill/status',
        '/v1/ai-training/tracking/define',
        '/v1/ai-training/tracking/point',
        '/v1/ai-training/tracking/curves',
        '/v1/ai-training/tracking/compare',
      ];
      assert.equal(paths.length, 10);
      for (const path of paths) {
        const res = await h.post(path, {});
        assert.equal(res.status, 401, path);
        assert.equal(await errorCode(res), 'unauthenticated', path);
      }
    } finally {
      await h.close();
    }
  });

  it('runs preference tuning through RLHF stages with the honest verdict law (AI-015)', async () => {
    const h = await startHarness();
    try {
      const register = await h.post('/v1/auth/register', { email: 'tune@forge.test', password: GOOD_PASSWORD, displayName: 'Tuner' });
      assert.equal(register.status, 201);
      await setPlanForTest(h, ((await register.json()) as { user: { id: string } }).user.id, 'enterprise');
      const cookie = sessionCookie(await h.post('/v1/auth/sign-in', { email: 'tune@forge.test', password: GOOD_PASSWORD }));

      const badMethod = await h.post('/v1/ai-training/tuning/define', { ...TUNING_BODY, method: 'ppo' }, { cookie });
      assert.equal(badMethod.status, 400);
      assert.equal(await errorCode(badMethod), 'pipeline-method-unknown:ppo');
      const identical = await h.post('/v1/ai-training/tuning/define', { pipelineId: 'x', method: 'rlhf', pairs: [{ prompt: 'p', chosen: 'same', rejected: 'same' }], hyperparams: TUNING_BODY.hyperparams }, { cookie });
      assert.equal(identical.status, 400);
      assert.equal(await errorCode(identical), 'pipeline-pair-identical:0');
      const badLr = await h.post('/v1/ai-training/tuning/define', { ...TUNING_BODY, hyperparams: { learningRate: 1, beta: 0.1, epochs: 3 } }, { cookie });
      assert.equal(badLr.status, 400);
      assert.equal(await errorCode(badLr), 'pipeline-bad-hyperparams:learningRate');

      const defined = await h.post('/v1/ai-training/tuning/define', TUNING_BODY, { cookie });
      assert.equal(defined.status, 201);
      const defBody = (await defined.json()) as { pipeline: { pipelineId: string; pairCount: number; duplicatesDropped: number; stage: string; stages: string[]; fingerprint: string }; createdAt: number };
      assert.equal(defBody.pipeline.pipelineId, 'tune-1');
      assert.equal(defBody.pipeline.pairCount, 2);
      assert.equal(defBody.pipeline.duplicatesDropped, 1);
      assert.equal(defBody.pipeline.stage, 'collect');
      assert.match(defBody.pipeline.fingerprint, /^ptfp_[0-9a-f]{8}$/);

      const dup = await h.post('/v1/ai-training/tuning/define', TUNING_BODY, { cookie });
      assert.equal(dup.status, 409);
      assert.equal(await errorCode(dup), 'tuning-pipeline-duplicate:tune-1');

      const advance = async (metrics?: Record<string, number>): Promise<{ stage: string; stageIndex: number; complete: boolean; verdict: string | null }> => {
        const res = await h.post('/v1/ai-training/tuning/advance', { pipelineId: 'tune-1', ...(metrics === undefined ? {} : { metrics }) }, { cookie });
        assert.equal(res.status, 200);
        return (await res.json()) as { stage: string; stageIndex: number; complete: boolean; verdict: string | null };
      };
      const s1 = await advance();
      assert.deepEqual({ stage: s1.stage, verdict: s1.verdict }, { stage: 'reward', verdict: null });
      const s2 = await advance();
      assert.deepEqual({ stage: s2.stage, verdict: s2.verdict }, { stage: 'optimize', verdict: null });
      const noMetrics = await h.post('/v1/ai-training/tuning/advance', { pipelineId: 'tune-1' }, { cookie });
      assert.equal(noMetrics.status, 400);
      assert.equal(await errorCode(noMetrics), 'tuning-missing-metrics');
      const s3 = await advance({ rewardMargin: 0.4, acceptanceRate: 0.7 });
      assert.equal(s3.stage, 'evaluate');
      assert.equal(s3.complete, true);
      assert.equal(s3.verdict, 'accepted');
      const status = await h.post('/v1/ai-training/tuning/status', { pipelineId: 'tune-1' }, { cookie });
      assert.equal(status.status, 200);
      assert.equal(((await status.json()) as { verdict: string }).verdict, 'accepted');
    } finally {
      await h.close();
    }
  });

  it('rejects tuning metrics below the verdict law and stages past the end', async () => {
    const h = await startHarness();
    try {
      const register = await h.post('/v1/auth/register', { email: 'tune2@forge.test', password: GOOD_PASSWORD, displayName: 'Tuner 2' });
      await setPlanForTest(h, ((await register.json()) as { user: { id: string } }).user.id, 'enterprise');
      const cookie = sessionCookie(await h.post('/v1/auth/sign-in', { email: 'tune2@forge.test', password: GOOD_PASSWORD }));
      await h.post('/v1/ai-training/tuning/define', TUNING_BODY, { cookie });
      // metrics are only validated when entering evaluate; walking there first
      await h.post('/v1/ai-training/tuning/advance', { pipelineId: 'tune-1' }, { cookie });
      await h.post('/v1/ai-training/tuning/advance', { pipelineId: 'tune-1' }, { cookie });
      const bad = await h.post('/v1/ai-training/tuning/advance', { pipelineId: 'tune-1', metrics: { rewardMargin: 0.4, acceptanceRate: 1.5 } }, { cookie });
      assert.equal(bad.status, 400);
      assert.equal(await errorCode(bad), 'tuning-metrics-invalid:acceptanceRate');
      const rejected = await h.post('/v1/ai-training/tuning/advance', { pipelineId: 'tune-1', metrics: { rewardMargin: -1, acceptanceRate: 0.9 } }, { cookie });
      assert.equal(rejected.status, 200);
      assert.equal(((await rejected.json()) as { verdict: string }).verdict, 'rejected');
      const over = await h.post('/v1/ai-training/tuning/advance', { pipelineId: 'tune-1', metrics: { rewardMargin: 1, acceptanceRate: 1 } }, { cookie });
      assert.equal(over.status, 400);
      assert.equal(await errorCode(over), 'pipeline-stage-invalid');
      const missing = await h.post('/v1/ai-training/tuning/status', { pipelineId: 'ghost' }, { cookie });
      assert.equal(missing.status, 404);
      assert.equal(await errorCode(missing), 'tuning-pipeline-not-found:ghost');
    } finally {
      await h.close();
    }
  });

  it('distills teacher into a smaller student and gates registration on accuracy (AI-016)', async () => {
    const h = await startHarness();
    try {
      const register = await h.post('/v1/auth/register', { email: 'distill@forge.test', password: GOOD_PASSWORD, displayName: 'Distiller' });
      await setPlanForTest(h, ((await register.json()) as { user: { id: string } }).user.id, 'enterprise');
      const cookie = sessionCookie(await h.post('/v1/auth/sign-in', { email: 'distill@forge.test', password: GOOD_PASSWORD }));

      const tooLarge = await h.post('/v1/ai-training/distill/plan', { ...DISTILL_BODY, studentParams: 70000 }, { cookie });
      assert.equal(tooLarge.status, 400);
      assert.equal(await errorCode(tooLarge), 'distillation-student-too-large');
      const badGate = await h.post('/v1/ai-training/distill/plan', { ...DISTILL_BODY, qualityGate: 1 }, { cookie });
      assert.equal(badGate.status, 400);
      assert.equal(await errorCode(badGate), 'distillation-quality-gate-invalid');

      const planned = await h.post('/v1/ai-training/distill/plan', DISTILL_BODY, { cookie });
      assert.equal(planned.status, 201);
      const planBody = (await planned.json()) as { plan: { planId: string; compressionRatio: number; stage: string; fingerprint: string }; createdAt: number };
      assert.equal(planBody.plan.compressionRatio, 0.1);
      assert.equal(planBody.plan.stage, 'generate');
      assert.match(planBody.plan.fingerprint, /^dist_[0-9a-f]{8}$/);

      const dup = await h.post('/v1/ai-training/distill/plan', DISTILL_BODY, { cookie });
      assert.equal(dup.status, 409);
      assert.equal(await errorCode(dup), 'distillation-plan-duplicate:distill-1');

      const advance = async (metrics?: Record<string, number>): Promise<{ stage: string; stageIndex: number; complete: boolean; verdict: string | null }> => {
        const res = await h.post('/v1/ai-training/distill/advance', { planId: 'distill-1', ...(metrics === undefined ? {} : { metrics }) }, { cookie });
        assert.equal(res.status, 200);
        return (await res.json()) as { stage: string; stageIndex: number; complete: boolean; verdict: string | null };
      };
      const s1 = await advance();
      assert.equal(s1.stage, 'compress');
      const needMetrics = await h.post('/v1/ai-training/distill/advance', { planId: 'distill-1' }, { cookie });
      assert.equal(needMetrics.status, 400);
      assert.equal(await errorCode(needMetrics), 'distillation-missing-metrics');
      const s2 = await advance({ studentAccuracy: 0.85 });
      assert.deepEqual({ stage: s2.stage, verdict: s2.verdict }, { stage: 'evaluate', verdict: 'accepted' });
      const s3 = await advance();
      assert.deepEqual({ stage: s3.stage, complete: s3.complete, verdict: s3.verdict }, { stage: 'register', complete: true, verdict: 'accepted' });
      const status = await h.post('/v1/ai-training/distill/status', { planId: 'distill-1' }, { cookie });
      assert.equal(((await status.json()) as { verdict: string }).verdict, 'accepted');
    } finally {
      await h.close();
    }
  });

  it('tracks training experiments point by point with curves and comparisons (AI-018)', async () => {
    const h = await startHarness();
    try {
      const register = await h.post('/v1/auth/register', { email: 'track@forge.test', password: GOOD_PASSWORD, displayName: 'Tracker' });
      await setPlanForTest(h, ((await register.json()) as { user: { id: string } }).user.id, 'enterprise');
      const cookie = sessionCookie(await h.post('/v1/auth/sign-in', { email: 'track@forge.test', password: GOOD_PASSWORD }));

      const badConfig = await h.post('/v1/ai-training/tracking/define', { experimentId: 'x', config: {}, metrics: ['loss'] }, { cookie });
      assert.equal(badConfig.status, 400);
      assert.equal(await errorCode(badConfig), 'experiment-tracking-no-config');
      const dupMetric = await h.post('/v1/ai-training/tracking/define', { experimentId: 'x', config: { a: 1 }, metrics: ['loss', 'loss'] }, { cookie });
      assert.equal(dupMetric.status, 400);
      assert.equal(await errorCode(dupMetric), 'experiment-tracking-metric-duplicate:loss');

      const defined = await h.post('/v1/ai-training/tracking/define', TRACK_BODY, { cookie });
      assert.equal(defined.status, 201);
      const defBody = (await defined.json()) as { experiment: { experimentId: string; pointCount: number; fingerprint: string } };
      assert.equal(defBody.experiment.experimentId, 'track-1');
      assert.equal(defBody.experiment.pointCount, 0);
      assert.match(defBody.experiment.fingerprint, /^ext_[0-9a-f]{8}$/);

      const dup = await h.post('/v1/ai-training/tracking/define', TRACK_BODY, { cookie });
      assert.equal(dup.status, 409);
      assert.equal(await errorCode(dup), 'tracked-experiment-duplicate:track-1');

      const unknownMetric = await h.post('/v1/ai-training/tracking/point', { experimentId: 'track-1', step: 1, metric: 'nope', value: 1 }, { cookie });
      assert.equal(unknownMetric.status, 400);
      assert.equal(await errorCode(unknownMetric), 'experiment-tracking-unknown-metric:nope');
      const badStep = await h.post('/v1/ai-training/tracking/point', { experimentId: 'track-1', step: -1, metric: 'loss', value: 1 }, { cookie });
      assert.equal(badStep.status, 400);
      assert.equal(await errorCode(badStep), 'experiment-tracking-bad-step');

      const p1 = await h.post('/v1/ai-training/tracking/point', { experimentId: 'track-1', step: 1, metric: 'loss', value: 2.5 }, { cookie });
      assert.equal(p1.status, 200);
      assert.deepEqual(await p1.json() as Record<string, unknown>, { step: 1, metric: 'loss', value: 2.5 });
      const p2 = await h.post('/v1/ai-training/tracking/point', { experimentId: 'track-1', step: 2, metric: 'loss', value: 1.5 }, { cookie });
      assert.equal(p2.status, 200);
      const other = await h.post('/v1/ai-training/tracking/define', { experimentId: 'track-2', config: { lr: 0.02 }, metrics: ['loss'] }, { cookie });
      assert.equal(other.status, 201);
      const po = await h.post('/v1/ai-training/tracking/point', { experimentId: 'track-2', step: 1, metric: 'loss', value: 3.0 }, { cookie });
      assert.equal(po.status, 200);

      const curves = await h.post('/v1/ai-training/tracking/curves', { experimentId: 'track-1', metric: 'loss' }, { cookie });
      assert.equal(curves.status, 200);
      const curvesBody = (await curves.json()) as { experimentId: string; curves: Array<{ metric: string; points: Array<{ step: number }> }> };
      assert.equal(curvesBody.experimentId, 'track-1');
      assert.deepEqual(curvesBody.curves.map((c) => c.points.map((p) => p.step)), [[1, 2]]);
      const badCurve = await h.post('/v1/ai-training/tracking/curves', { experimentId: 'track-1', metric: 'nope' }, { cookie });
      assert.equal(badCurve.status, 400);
      assert.equal(await errorCode(badCurve), 'experiment-tracking-unknown-metric:nope');

      const compare = await h.post('/v1/ai-training/tracking/compare', { a: 'track-1', b: 'track-2', metric: 'loss' }, { cookie });
      assert.equal(compare.status, 200);
      assert.deepEqual(await compare.json() as Record<string, unknown>, {
        metric: 'loss',
        a: { experimentId: 'track-1', last: 1.5, count: 2 },
        b: { experimentId: 'track-2', last: 3, count: 1 },
        delta: 1.5,
      });
      const noMetric = await h.post('/v1/ai-training/tracking/compare', { a: 'track-1', b: 'track-2', metric: '' }, { cookie });
      assert.equal(noMetric.status, 400);
      assert.equal(await errorCode(noMetric), 'experiment-tracking-compare-no-metric');
      const missing = await h.post('/v1/ai-training/tracking/curves', { experimentId: 'ghost' }, { cookie });
      assert.equal(missing.status, 404);
      assert.equal(await errorCode(missing), 'tracked-experiment-not-found:ghost');
    } finally {
      await h.close();
    }
  });
});
