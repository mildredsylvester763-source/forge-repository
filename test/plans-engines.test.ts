import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadConfig } from '../src/config.ts';
import {
  canUse,
  DEFAULT_PLAN,
  ENGINE_BY_FEATURE,
  FEATURE_GATES,
  gateForRoute,
  isPlanId,
  PLAN_IDS,
  ROUTE_GATES,
  type GateId,
  type PlanId,
} from '../src/modules/plans/index.ts';

const accessPolicy = loadConfig({ FORGE_ENV: 'test' }).plans.accessPolicy;

/** The PLAN GATE LAW, pinned: one gate per feature, plans cumulative, Studio covers Team, internal never sold. */
describe('plans engine (PLAN GATE LAW)', () => {
  it('walks the plan ladder: cumulative plans, Studio covers Team but never Enterprise', () => {
    const ladder: Array<{ plan: PlanId; gates: Record<GateId, boolean> }> = [
      { plan: 'free', gates: { free: true, plus: false, pro: false, team: false, enterprise: false, internal: true, engine: true, not_tiered: true } },
      { plan: 'plus', gates: { free: true, plus: true, pro: false, team: false, enterprise: false, internal: true, engine: true, not_tiered: true } },
      { plan: 'pro', gates: { free: true, plus: true, pro: true, team: false, enterprise: false, internal: true, engine: true, not_tiered: true } },
      { plan: 'studio', gates: { free: true, plus: true, pro: true, team: true, enterprise: false, internal: true, engine: true, not_tiered: true } },
      { plan: 'team', gates: { free: true, plus: true, pro: true, team: true, enterprise: false, internal: true, engine: true, not_tiered: true } },
      { plan: 'enterprise', gates: { free: true, plus: true, pro: true, team: true, enterprise: true, internal: true, engine: true, not_tiered: true } },
    ];
    for (const row of ladder) {
      for (const [gate, allowed] of Object.entries(row.gates) as Array<[GateId, boolean]>) {
        const verdict = canUse(
          { plan: row.plan, enginePasses: [] },
          { featureId: gate === 'engine' ? 'TQ-027' : 'CO-001', planFrom: gate,
            ...(gate === 'engine' ? { engineTag: 'creative' } : {}) },
          accessPolicy,
        );
        assert.equal(verdict.allowed, allowed, row.plan + ' x ' + gate);
      }
    }
  });

  it('pins the catalog gate counts (201 features, one gate each)', () => {
    const counts: Record<string, number> = {};
    for (const gate of Object.values(FEATURE_GATES)) counts[gate] = (counts[gate] ?? 0) + 1;
    assert.equal(Object.keys(FEATURE_GATES).length, 201);
    assert.deepEqual(counts, { free: 85, internal: 54, pro: 25, enterprise: 16, team: 10, plus: 10, engine: 1 });
  });

  it('pins spot-checked gates from the With-Plans catalog', () => {
    const pinned: Array<[string, string]> = [
      ['CO-001', 'free'],
      ['CO-004', 'enterprise'],
      ['CO-010', 'plus'],
      ['CO-020', 'team'],
      ['CO-063', 'internal'],
      ['AI-045', 'pro'],
      ['AI-050', 'plus'],
      ['AI-052', 'team'],
      ['AI-054', 'enterprise'],
      ['TQ-027', 'engine'],
      ['TQ-036', 'pro'],
      ['TQ-040', 'pro'],
    ];
    for (const [feature, gate] of pinned) assert.equal(FEATURE_GATES[feature], gate, feature);
  });

  it('keeps unpaid engines open at Free limits without unlocking paid engine features', () => {
    assert.equal(ENGINE_BY_FEATURE['TQ-027'], 'creative');
    assert.equal(FEATURE_GATES['TQ-027'], 'engine');

    const free = canUse(
      { plan: 'free', enginePasses: [] },
      { featureId: 'TQ-027', planFrom: 'engine', engineTag: 'creative' },
      accessPolicy,
    );
    assert.equal(free.allowed, true);
    assert.equal(free.accessMode, 'engine_free');
    assert.equal(free.reason, 'engine_free_limits');
    assert.equal(free.limits.creditsPerWindow, 40);
    assert.equal(free.limits.windowMs, 5 * 60 * 60 * 1000);
    assert.equal(free.limits.monthlyCredits, 600);
    assert.equal(free.limits.monthlyCostCapUsd, 0.20);
    assert.equal(free.limits.models, 'free_only');
    assert.equal(free.limits.quality, 'free');
    assert.equal(free.limits.outputSize, 'free');
    assert.equal(free.limits.paidOnlyFeatures, false);
    assert.equal(free.creditScope, 'engine:creative');
    assert.match(free.message, /Creative pass needed/);

    const paidPlanWithoutPass = canUse(
      { plan: 'enterprise', enginePasses: [] },
      { featureId: 'TQ-027', planFrom: 'engine', engineTag: 'creative' },
      accessPolicy,
    );
    assert.equal(paidPlanWithoutPass.allowed, true);
    assert.equal(paidPlanWithoutPass.accessMode, 'engine_free');

    const paidPass = canUse(
      { plan: 'free', enginePasses: ['creative'] },
      { featureId: 'TQ-027', planFrom: 'engine', engineTag: 'creative' },
      accessPolicy,
    );
    assert.equal(paidPass.allowed, true);
    assert.equal(paidPass.accessMode, 'engine_paid');
    assert.equal(paidPass.reason, 'unlocked');
    assert.equal(paidPass.creditScope, 'engine:creative');

    const wrongPass = canUse(
      { plan: 'enterprise', enginePasses: ['music'] },
      { featureId: 'TQ-027', planFrom: 'engine', engineTag: 'creative' },
      accessPolicy,
    );
    assert.equal(wrongPass.allowed, true);
    assert.equal(wrongPass.accessMode, 'engine_free');

    const includedInPlan = canUse(
      { plan: 'studio', enginePasses: [] },
      { featureId: 'TQ-027', planFrom: 'engine', engineTag: 'creative' },
      { ...accessPolicy, enginesIncludedByPlan: { studio: ['creative'] } },
    );
    assert.equal(includedInPlan.allowed, true);
    assert.equal(includedInPlan.accessMode, 'engine_paid');
  });

  it('keeps engine credit scopes separate and exposes the Not tiered catalogue value', () => {
    const creative = canUse(
      { plan: 'pro', enginePasses: [] },
      { featureId: 'TQ-027', planFrom: 'engine', engineTag: 'creative' },
      accessPolicy,
    );
    const general = canUse(
      { plan: 'free', enginePasses: [] },
      { featureId: 'CO-001', planFrom: 'free' },
      accessPolicy,
    );
    const notTiered = canUse(
      { plan: 'free', enginePasses: [] },
      { featureId: 'NEW-001', planFrom: 'not_tiered' },
      accessPolicy,
    );
    assert.equal(creative.creditScope, 'engine:creative');
    assert.equal(general.creditScope, 'general');
    assert.equal(notTiered.allowed, true);
    assert.equal(notTiered.reason, 'not_tiered');
  });

  it('pins plan ids and the free default', () => {
    assert.deepEqual([...PLAN_IDS], ['free', 'plus', 'pro', 'studio', 'team', 'enterprise']);
    assert.equal(DEFAULT_PLAN, 'free');
    assert.equal(isPlanId('pro'), true);
    assert.equal(isPlanId('diamond'), false);
    assert.equal(isPlanId(42), false);
  });

  it('pins every wired route to a catalog feature (268 routes)', () => {
    assert.equal(Object.keys(ROUTE_GATES).length, 268);
    for (const [path, feature] of Object.entries(ROUTE_GATES)) {
      assert.notEqual(FEATURE_GATES[feature], undefined, path + ' -> ' + feature);
    }
  });

  it('pins spot-checked route mappings', () => {
    const pinned: Array<[string, string, string]> = [
      ['/v1/ai-training/gateway/byok', 'AI-050', 'plus'],
      ['/v1/web-search/domain-rules', 'AI-061', 'team'],
      ['/v1/live-testing/sessions/creative', 'TQ-027', 'engine'],
      ['/v1/orchestrator/handoffs', 'AI-076', 'pro'],
      ['/v1/tasks/parallel/conflicts', 'AI-083', 'pro'],
      ['/v1/training-data/lake/admit', 'AI-001', 'internal'],
      ['/v1/auth/register', 'CO-001', 'free'],
      ['/v1/test-quality/matrix/plan', 'TQ-040', 'pro'],
      ['/v1/test-generation/property/plan', 'TQ-034', 'pro'],
      ['/v1/search-integrity/packs', 'AI-072', 'plus'],
    ];
    for (const [path, feature, gate] of pinned) {
      const decision = gateForRoute(path);
      assert.notEqual(decision, null, path);
      assert.equal(decision?.feature, feature, path);
      assert.equal(decision?.gate, gate, path);
    }
  });

  it('leaves unmapped paths ungated', () => {
    assert.equal(gateForRoute('/v1/plans/me'), null);
    assert.equal(gateForRoute('/v1/plans/check'), null);
    assert.equal(gateForRoute('/v1/health'), null);
    assert.equal(gateForRoute('/v1/nope'), null);
  });
});
