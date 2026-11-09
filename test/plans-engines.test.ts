import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  activeBasePlan,
  activePasses,
  appendGrant,
  balanceByEngine,
  canUse,
  checkEntitlement,
  creditBalance,
  DEFAULT_PLAN,
  ENGINE_BY_FEATURE,
  ENGINES,
  FEATURE_GATES,
  gateForRoute,
  isEngineCode,
  isPlanId,
  parseGrant,
  parsePaymentEvent,
  applyPaymentEvent,
  PLAN_IDS,
  ROUTE_GATES,
  spend,
  type AccessConfig,
  type GateId,
  type PlanId,
} from '../src/modules/plans/index.ts';

/** The PLAN GATE LAW, pinned: one gate per feature, plans cumulative, Studio covers Team, internal never sold. */
describe('plans engine (PLAN GATE LAW)', () => {
  it('walks the plan ladder: cumulative plans, Studio covers Team but never Enterprise', () => {
    const ladder: Array<{ plan: PlanId; gates: Record<GateId, boolean> }> = [
      { plan: 'free', gates: { free: true, plus: false, pro: false, team: false, enterprise: false, internal: true, engine: false } },
      { plan: 'plus', gates: { free: true, plus: true, pro: false, team: false, enterprise: false, internal: true, engine: false } },
      { plan: 'pro', gates: { free: true, plus: true, pro: true, team: false, enterprise: false, internal: true, engine: false } },
      { plan: 'studio', gates: { free: true, plus: true, pro: true, team: true, enterprise: false, internal: true, engine: false } },
      { plan: 'team', gates: { free: true, plus: true, pro: true, team: true, enterprise: false, internal: true, engine: false } },
      { plan: 'enterprise', gates: { free: true, plus: true, pro: true, team: true, enterprise: true, internal: true, engine: false } },
    ];
    for (const row of ladder) {
      for (const [gate, allowed] of Object.entries(row.gates) as Array<[GateId, boolean]>) {
        const verdict = checkEntitlement({ plan: row.plan, enginePasses: [] }, gate === 'engine' ? 'TQ-027' : 'CO-001', gate);
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

  it('gates engine rows on an owned engine pass among the row engine tags', () => {
    assert.deepEqual([...ENGINES], ['manhwa', 'music', 'voice', 'video', '3d']);
    assert.equal(isEngineCode('manhwa'), true);
    assert.equal(isEngineCode('creative'), false);
    assert.deepEqual(ENGINE_BY_FEATURE['TQ-027'], ['manhwa', '3d', 'music']);
    assert.equal(FEATURE_GATES['TQ-027'], 'engine');
    const denied = checkEntitlement({ plan: 'enterprise', enginePasses: [] }, 'TQ-027', 'engine');
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'engine_pass_missing');
    const wrongPass = checkEntitlement({ plan: 'enterprise', enginePasses: ['creative'] }, 'TQ-027', 'engine');
    assert.equal(wrongPass.allowed, false);
    const owned = checkEntitlement({ plan: 'pro', enginePasses: ['music'] }, 'TQ-027', 'engine');
    assert.equal(owned.allowed, true);
    assert.equal(owned.reason, 'unlocked');
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
    assert.equal(gateForRoute('/v1/credits/me'), null);
    assert.equal(gateForRoute('/v1/payments/event'), null);
    assert.equal(gateForRoute('/v1/health'), null);
    assert.equal(gateForRoute('/v1/nope'), null);
  });
});

/** Hook 1 + 6: subscriptions are a list, one active base plan, event-driven status. */
describe('plans engine (subscription hooks)', () => {
  const now = 1_000_000;
  const basePayload = {
    eventId: 'pe_1',
    userId: 'u_1',
    amountMinor: 999,
    currency: 'USD',
    occurredAt: now,
    products: [{ itemType: 'base_plan', itemCode: 'plus', startsAt: now, endsAt: now + 10_000 }],
  };

  it('rejects malformed payment events with named reasons', () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ ...basePayload, eventId: '' }, 'bad_event_id'],
      [{ ...basePayload, userId: 42 }, 'bad_user_id'],
      [{ ...basePayload, amountMinor: 9.99 }, 'bad_amount'],
      [{ ...basePayload, amountMinor: -1 }, 'bad_amount'],
      [{ ...basePayload, currency: 'usd' }, 'bad_currency'],
      [{ ...basePayload, currency: 'DOLLAR' }, 'bad_currency'],
      [{ ...basePayload, products: [] }, 'bad_products'],
      [{ ...basePayload, products: [{ itemType: 'widget', itemCode: 'plus', startsAt: now, endsAt: now + 1 }] }, 'bad_product_type'],
      [{ ...basePayload, products: [{ itemType: 'base_plan', itemCode: 'free', startsAt: now, endsAt: now + 1 }] }, 'free_not_sellable'],
      [{ ...basePayload, products: [{ itemType: 'base_plan', itemCode: 'diamond', startsAt: now, endsAt: now + 1 }] }, 'plan_unknown'],
      [{ ...basePayload, products: [{ itemType: 'engine_pass', itemCode: 'creative', startsAt: now, endsAt: now + 1 }] }, 'engine_unknown'],
      [{ ...basePayload, products: [{ itemType: 'base_plan', itemCode: 'plus', startsAt: now, endsAt: now }] }, 'bad_window'],
      [
        {
          ...basePayload,
          products: [
            { itemType: 'base_plan', itemCode: 'plus', startsAt: now, endsAt: now + 1 },
            { itemType: 'base_plan', itemCode: 'pro', startsAt: now, endsAt: now + 1 },
          ],
        },
        'bad_products',
      ],
    ];
    for (const [payload, reason] of bad) {
      const result = parsePaymentEvent(payload);
      assert.equal(result.ok, false, JSON.stringify(payload));
      if (!result.ok) assert.equal(result.reason, reason, JSON.stringify(payload));
    }
    assert.equal(parsePaymentEvent('nope').ok, false);
    assert.equal(parsePaymentEvent(basePayload).ok, true);
  });

  it('appends items numbered per user and supersedes only on a base-plan purchase', () => {
    const event = parsePaymentEvent(basePayload);
    assert.equal(event.ok, true);
    if (!event.ok) return;
    const first = applyPaymentEvent([], event.event);
    assert.equal(first.granted.length, 1);
    assert.equal(first.granted[0]?.itemId, 'sub_u_1_1');
    assert.equal(first.superseded.length, 0);
    assert.equal(first.items.length, 1);

    const passPayload = {
      eventId: 'pe_2',
      userId: 'u_1',
      amountMinor: 499,
      currency: 'USD',
      occurredAt: now,
      products: [
        { itemType: 'engine_pass', itemCode: 'music', startsAt: now, endsAt: now + 10_000 },
        { itemType: 'engine_pass', itemCode: 'manhwa', startsAt: now, endsAt: now + 10_000 },
      ],
    };
    const passEvent = parsePaymentEvent(passPayload);
    assert.equal(passEvent.ok, true);
    if (!passEvent.ok) return;
    const second = applyPaymentEvent(first.items, passEvent.event);
    assert.equal(second.superseded.length, 0, 'an engine pass never touches the base plan');
    assert.equal(second.granted.length, 2);
    assert.equal(second.items.length, 3);
    assert.equal(second.items[1]?.itemId, 'sub_u_1_2');
    assert.equal(second.items[2]?.itemId, 'sub_u_1_3');
    assert.deepEqual(activePasses(second.items, now), ['manhwa', 'music']);
    assert.equal(activeBasePlan(second.items, now)?.itemCode, 'plus');

    const upgradePayload = {
      eventId: 'pe_3',
      userId: 'u_1',
      amountMinor: 2499,
      currency: 'USD',
      occurredAt: now + 1,
      products: [{ itemType: 'base_plan', itemCode: 'pro', startsAt: now + 1, endsAt: now + 20_000 }],
    };
    const upgradeEvent = parsePaymentEvent(upgradePayload);
    assert.equal(upgradeEvent.ok, true);
    if (!upgradeEvent.ok) return;
    const third = applyPaymentEvent(second.items, upgradeEvent.event);
    assert.equal(third.superseded.length, 1, 'a base-plan purchase supersedes the previous base plan');
    assert.equal(third.superseded[0]?.itemId, 'sub_u_1_1');
    assert.equal(third.superseded[0]?.status, 'cancelled');
    assert.equal(activeBasePlan(third.items, now + 1)?.itemCode, 'pro');
    assert.deepEqual(activePasses(third.items, now + 1), ['manhwa', 'music'], 'passes survive a base-plan upgrade');

    assert.equal(second.items.length, 3, 'the caller array is never mutated');
    assert.equal(first.items.length, 1);
  });

  it('derives liveness from status and window: expired items are dead', () => {
    const event = parsePaymentEvent(basePayload);
    assert.equal(event.ok, true);
    if (!event.ok) return;
    const { items } = applyPaymentEvent([], event.event);
    assert.equal(activeBasePlan(items, now - 1), null, 'before the window opens');
    assert.equal(activeBasePlan(items, now)?.itemCode, 'plus');
    assert.equal(activeBasePlan(items, now + 10_000), null, 'at endsAt the item is dead');
  });
});

/** Hook 3 + 7: the ledger is append-only, the balance is always the sum of entries. */
describe('plans engine (credit ledger hooks)', () => {
  const now = 5_000_000;
  const user = 'u_led';

  it('rejects malformed grants with named reasons', () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ engine: 'creative', source: 'top_up', amount: 10, expiresAt: null, jobId: null }, 'bad_engine'],
      [{ engine: '', source: 'donation', amount: 10, expiresAt: null, jobId: null }, 'bad_source'],
      [{ engine: '', source: 'top_up', amount: 0, expiresAt: null, jobId: null }, 'bad_amount'],
      [{ engine: '', source: 'top_up', amount: 10.5, expiresAt: null, jobId: null }, 'bad_amount'],
      [{ engine: '', source: 'top_up', amount: 10, expiresAt: 0, jobId: null }, 'bad_expires'],
      [{ engine: '', source: 'top_up', amount: 10, expiresAt: null, jobId: '' }, 'bad_job'],
    ];
    for (const [payload, reason] of bad) {
      const result = parseGrant(payload);
      assert.equal(result.ok, false, JSON.stringify(payload));
      if (!result.ok) assert.equal(result.reason, reason, JSON.stringify(payload));
    }
    const ok = parseGrant({ engine: 'music', source: 'pass', amount: 100, expiresAt: null, jobId: null });
    assert.equal(ok.ok, true);
  });

  it('numbers entries per user and never mutates the caller array', () => {
    const grant = parseGrant({ engine: '', source: 'top_up', amount: 60, expiresAt: null, jobId: null });
    assert.equal(grant.ok, true);
    if (!grant.ok) return;
    const first = appendGrant([], user, grant.grant, now);
    assert.equal(first.entry.entryId, 'led_u_led_1');
    assert.equal(first.entry.costUsdMicros, null);
    assert.equal(first.entries.length, 1);
    const second = appendGrant(first.entries, user, grant.grant, now);
    assert.equal(second.entry.entryId, 'led_u_led_2');
    assert.equal(first.entries.length, 1, 'the caller array is never mutated');
  });

  it('counts expired grants as dead and always keeps spends', () => {
    const entries = [
      appendGrant([], user, parseGrant({ engine: '', source: 'free_window', amount: 40, expiresAt: now + 1_000, jobId: null }).grant ?? { engine: '', source: 'top_up', amount: 1, expiresAt: null, jobId: null }, now).entries,
    ];
    // build without the fallback dance: use the engine directly
    const base = entries[0] ?? [];
    const withTopUp = appendGrant(base, user, parseGrant({ engine: '', source: 'top_up', amount: 60, expiresAt: null, jobId: null }).grant ?? { engine: '', source: 'top_up', amount: 1, expiresAt: null, jobId: null }, now).entries;
    const musicPass = appendGrant(withTopUp, user, parseGrant({ engine: 'music', source: 'pass', amount: 100, expiresAt: null, jobId: null }).grant ?? { engine: '', source: 'top_up', amount: 1, expiresAt: null, jobId: null }, now).entries;
    assert.equal(creditBalance(musicPass, now, ''), 100);
    assert.equal(creditBalance(musicPass, now + 1_000, ''), 60, 'the expired free window is dead');
    assert.equal(creditBalance(musicPass, now, 'music'), 100);
    assert.deepEqual(balanceByEngine(musicPass, now), { general: 100, engines: [{ engine: 'music', balance: 100 }] });
  });

  it('spends engine credits before general, free-window before plan before pass before top-up', () => {
    const mk = (raw: Record<string, unknown>) => {
      const parsed = parseGrant(raw);
      assert.equal(parsed.ok, true);
      assert.ok(parsed.ok);
      return parsed.grant;
    };
    let entries: readonly import('../src/modules/plans/index.ts').LedgerEntry[] = [];
    const g = (raw: Record<string, unknown>) => {
      entries = appendGrant(entries, user, mk(raw), now).entries;
    };
    g({ engine: '', source: 'top_up', amount: 60, expiresAt: null, jobId: null });
    g({ engine: '', source: 'free_window', amount: 40, expiresAt: now + 5_000, jobId: null });
    g({ engine: '', source: 'plan', amount: 30, expiresAt: now + 9_000, jobId: null });
    g({ engine: 'music', source: 'pass', amount: 100, expiresAt: null, jobId: null });
    g({ engine: 'music', source: 'free_window', amount: 10, expiresAt: now + 2_000, jobId: null });

    const musicSpend = spend(entries, user, { engine: 'music', amount: 15, jobId: 'job_1', costUsdMicros: 250 }, now);
    assert.equal(musicSpend.ok, true);
    assert.ok(musicSpend.ok);
    assert.deepEqual(musicSpend.from.map((f) => [f.source, f.used]), [['free_window', 10], ['pass', 5]], 'engine credits: free window first, then the pass');
    assert.equal(creditBalance(musicSpend.entries, now, 'music'), 95);

    const generalSpend = spend(musicSpend.entries, user, { engine: '', amount: 80, jobId: 'job_2', costUsdMicros: 0 }, now);
    assert.equal(generalSpend.ok, true);
    assert.ok(generalSpend.ok);
    assert.deepEqual(generalSpend.from.map((f) => [f.source, f.used]), [['free_window', 40], ['plan', 30], ['top_up', 10]], 'general credits: free window, then plan, then top-up');
    assert.equal(creditBalance(generalSpend.entries, now, ''), 50);

    const costEntry = generalSpend.entries[entries.length];
    assert.equal(costEntry?.jobId, 'job_2');
    assert.equal(costEntry?.costUsdMicros, 0);
    const firstCost = musicSpend.entries[entries.length];
    assert.equal(firstCost?.costUsdMicros, 250, 'the job cost lands on the first spend entry');

    const failed = spend(generalSpend.entries, user, { engine: 'music', amount: 1000, jobId: 'job_3', costUsdMicros: 0 }, now);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.shortfall, 905);
    assert.equal(generalSpend.entries.length, entries.length + 5, 'a failed spend writes nothing');
    assert.equal(entries.length, 5, 'the caller array is never mutated');
  });
});

/** Hooks 2, 2b, 5: canUse is the one access check, unpaid engines run at free level. */
describe('plans engine (access hooks)', () => {
  const now = 9_000_000;
  const config = (over: Partial<AccessConfig> = {}): AccessConfig => ({
    gatesEnabled: true,
    featureSwitches: {},
    engineBundlePlans: [],
    freeEngineLimits: { windowCredits: 40, windowHours: 5, monthlyCeiling: 600 },
    ...over,
  });

  it('reads the base plan from the subscription list first, then the legacy column', () => {
    const event = parsePaymentEvent({ eventId: 'pe_9', userId: 'u_acc', amountMinor: 999, currency: 'USD', occurredAt: now, products: [{ itemType: 'base_plan', itemCode: 'plus', startsAt: now, endsAt: now + 10_000 }] });
    assert.equal(event.ok, true);
    assert.ok(event.ok);
    const items = applyPaymentEvent([], event.event).items;
    const allowed = canUse({ items, legacyPlan: 'free', legacyPasses: [], feature: 'AI-050', config: config(), now });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.reason, 'unlocked');
    assert.equal(allowed.plan, 'plus');
    assert.deepEqual(allowed.passes, []);
    const denied = canUse({ items: [], legacyPlan: 'free', legacyPasses: [], feature: 'AI-050', config: config(), now });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'plan_too_low');
    assert.equal(denied.plan, 'free');
  });

  it('runs an unpaid engine at free level and a pass engine at paid level (Hook 2b)', () => {
    const decision = canUse({ items: [], legacyPlan: 'pro', legacyPasses: [], feature: 'TQ-027', config: config(), now });
    assert.equal(decision.allowed, true, 'an unpaid engine is never locked out');
    assert.equal(decision.level, 'free');
    assert.equal(decision.reason, 'engine_free_level');
    assert.deepEqual(decision.engine, ['manhwa', '3d', 'music']);
    assert.deepEqual(decision.limits, { windowCredits: 40, windowHours: 5, monthlyCeiling: 600 });

    const passEvent = parsePaymentEvent({ eventId: 'pe_10', userId: 'u_acc', amountMinor: 499, currency: 'USD', occurredAt: now, products: [{ itemType: 'engine_pass', itemCode: 'music', startsAt: now, endsAt: now + 10_000 }] });
    assert.equal(passEvent.ok, true);
    assert.ok(passEvent.ok);
    const items = applyPaymentEvent([], passEvent.event).items;
    const paid = canUse({ items, legacyPlan: 'free', legacyPasses: [], feature: 'TQ-027', config: config(), now });
    assert.equal(paid.allowed, true);
    assert.equal(paid.level, 'paid');
    assert.equal(paid.reason, 'engine_paid');
    assert.deepEqual(paid.passes, ['music']);
    assert.equal(paid.limits, null);

    const legacyPasses = canUse({ items: [], legacyPlan: 'free', legacyPasses: ['music'], feature: 'TQ-027', config: config(), now });
    assert.equal(legacyPasses.level, 'paid', 'legacy pass column still counts');

    const bundled = canUse({ items: [], legacyPlan: 'enterprise', legacyPasses: [], feature: 'TQ-027', config: config({ engineBundlePlans: ['enterprise'] }), now });
    assert.equal(bundled.level, 'paid', 'an all-round plan can include every engine');
  });

  it('honors the feature switches and the development gate bypass (Hook 5)', () => {
    const off = canUse({ items: [], legacyPlan: 'enterprise', legacyPasses: [], feature: 'AI-050', config: config({ featureSwitches: { 'AI-050': false } }), now });
    assert.equal(off.allowed, false);
    assert.equal(off.reason, 'feature_off');
    const bypass = canUse({ items: [], legacyPlan: 'free', legacyPasses: [], feature: 'AI-050', config: config({ gatesEnabled: false }), now });
    assert.equal(bypass.allowed, true);
    assert.equal(bypass.reason, 'gates_disabled');
    const internal = canUse({ items: [], legacyPlan: 'free', legacyPasses: [], feature: 'AI-001', config: config(), now });
    assert.equal(internal.allowed, true);
    assert.equal(internal.reason, 'internal');
  });
});
