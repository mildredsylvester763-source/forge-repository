import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  checkEntitlement,
  DEFAULT_PLAN,
  ENGINE_BY_FEATURE,
  ENGINES,
  FEATURE_GATES,
  gateForRoute,
  isEngineCode,
  isPlanId,
  PLAN_IDS,
  ROUTE_GATES,
  canUse,
  parsePaymentEvent,
  applyPaymentEvent,
  isItemLive,
  activeBasePlan,
  activePasses,
  parseGrant,
  appendGrant,
  creditBalance,
  balanceByEngine,
  spend,
  type AccessConfig,
  type AccessInput,
  type CreditSource,
  type GateId,
  type LedgerEntry,
  type PlanId,
  type SubscriptionItem,
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

  it('pins the engine codes (five engines, sold per engine under any base plan)', () => {
    assert.deepEqual([...ENGINES], ['manhwa', 'music', 'voice', 'video', '3d']);
    assert.equal(isEngineCode('manhwa'), true);
    assert.equal(isEngineCode('3d'), true);
    assert.equal(isEngineCode('creative'), false);
    assert.equal(isEngineCode('sonar'), false);
    assert.equal(isEngineCode(42), false);
  });

  it('gates engine rows on an owned engine pass among the row engines', () => {
    assert.deepEqual([...(ENGINE_BY_FEATURE['TQ-027'] ?? [])], ['manhwa', '3d', 'music']);
    assert.equal(FEATURE_GATES['TQ-027'], 'engine');
    const denied = checkEntitlement({ plan: 'enterprise', enginePasses: [] }, 'TQ-027', 'engine');
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'engine_pass_missing');
    const wrongPass = checkEntitlement({ plan: 'enterprise', enginePasses: ['sonar'] }, 'TQ-027', 'engine');
    assert.equal(wrongPass.allowed, false);
    const oldTag = checkEntitlement({ plan: 'enterprise', enginePasses: ['creative'] }, 'TQ-027', 'engine');
    assert.equal(oldTag.allowed, false);
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

/** Hook 1 (subscriptions are a list, one active base plan), Hook 6 (verified events), Hook 7 (whole-unit money). */
describe('plans hooks: subscription engine', () => {
  const now = 1000;
  const item = (over: Partial<SubscriptionItem>): SubscriptionItem => ({
    itemId: 'sub_u_1',
    userId: 'u',
    itemType: 'engine_pass',
    itemCode: 'music',
    startsAt: 0,
    endsAt: 2000,
    status: 'active',
    source: 'evt_1',
    ...over,
  });
  const event = (products: unknown, over: Record<string, unknown> = {}): unknown => ({
    eventId: 'evt_9',
    userId: 'u',
    amountMinor: 999,
    currency: 'USD',
    occurredAt: now,
    products,
    ...over,
  });

  it('rejects malformed payment events by name', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'bad_payload'],
      [event([{ itemType: 'base_plan', itemCode: 'plus', startsAt: 0, endsAt: 2000 }], { eventId: '' }), 'bad_event_id'],
      [event([{ itemType: 'base_plan', itemCode: 'plus', startsAt: 0, endsAt: 2000 }], { userId: '' }), 'bad_user_id'],
      [event([{ itemType: 'base_plan', itemCode: 'plus', startsAt: 0, endsAt: 2000 }], { amountMinor: 1.5 }), 'bad_amount'],
      [event([{ itemType: 'base_plan', itemCode: 'plus', startsAt: 0, endsAt: 2000 }], { currency: 'usd' }), 'bad_currency'],
      [event([{ itemType: 'base_plan', itemCode: 'plus', startsAt: 0, endsAt: 2000 }], { occurredAt: 'x' }), 'bad_occurred_at'],
      [event([]), 'bad_products'],
      [event([{ itemType: 'mega_pass', itemCode: 'plus', startsAt: 0, endsAt: 2000 }]), 'bad_product_type'],
      [event([{ itemType: 'base_plan', itemCode: '', startsAt: 0, endsAt: 2000 }]), 'bad_item_code'],
      [event([{ itemType: 'base_plan', itemCode: 'free', startsAt: 0, endsAt: 2000 }]), 'free_not_sellable'],
      [event([{ itemType: 'base_plan', itemCode: 'diamond', startsAt: 0, endsAt: 2000 }]), 'plan_unknown'],
      [event([{ itemType: 'engine_pass', itemCode: 'sonar', startsAt: 0, endsAt: 2000 }]), 'engine_unknown'],
      [event([{ itemType: 'base_plan', itemCode: 'plus', startsAt: 500, endsAt: 500 }]), 'bad_window'],
      [event([{ itemType: 'base_plan', itemCode: 'plus', startsAt: 0, endsAt: 2000 }, { itemType: 'base_plan', itemCode: 'plus', startsAt: 0, endsAt: 3000 }]), 'bad_products'],
    ];
    for (const [raw, reason] of cases) {
      const result = parsePaymentEvent(raw);
      assert.equal(result.ok, false, reason);
      if (!result.ok) assert.equal(result.reason, reason);
    }
  });

  it('accepts a well-formed event and parses it whole', () => {
    const result = parsePaymentEvent(event([{ itemType: 'base_plan', itemCode: 'plus', startsAt: 0, endsAt: 2000 }]));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.event.eventId, 'evt_9');
      assert.equal(result.event.amountMinor, 999);
      assert.equal(result.event.currency, 'USD');
      assert.equal(result.event.products.length, 1);
    }
  });

  it('supersedes the active base plan only when the event carries a base plan', () => {
    const existing: SubscriptionItem[] = [item({ itemType: 'base_plan', itemCode: 'plus' })];
    const frozen = [...existing];
    const parsedBase = parsePaymentEvent(event([{ itemType: 'base_plan', itemCode: 'pro', startsAt: 0, endsAt: 2000 }]));
    assert.equal(parsedBase.ok, true);
    if (parsedBase.ok) {
      const applied = applyPaymentEvent(existing, parsedBase.event);
      assert.equal(applied.items.length, 2);
      assert.equal(applied.superseded.length, 1);
      assert.equal(applied.superseded[0].status, 'cancelled');
      assert.equal(applied.items[0].status, 'cancelled');
      assert.equal(applied.granted[0].itemId, 'sub_u_2');
      assert.equal(applied.granted[0].itemCode, 'pro');
    }
    const parsedPass = parsePaymentEvent(event([{ itemType: 'engine_pass', itemCode: 'music', startsAt: 0, endsAt: 2000 }]));
    assert.equal(parsedPass.ok, true);
    if (parsedPass.ok) {
      const passOnly = applyPaymentEvent(existing, parsedPass.event);
      assert.equal(passOnly.superseded.length, 0);
      assert.equal(passOnly.items[0].status, 'active');
    }
    assert.deepEqual(existing, frozen);
  });

  it('derives liveness from status and window, then base plan and passes from the list', () => {
    assert.equal(isItemLive(item({}), now), true);
    assert.equal(isItemLive(item({ status: 'cancelled' }), now), false);
    assert.equal(isItemLive(item({ endsAt: now }), now), false);
    const items: SubscriptionItem[] = [
      item({ itemId: 'a', itemType: 'base_plan', itemCode: 'plus', startsAt: 100 }),
      item({ itemId: 'b', itemType: 'base_plan', itemCode: 'pro', startsAt: 200 }),
    ];
    assert.equal(activeBasePlan(items, now)?.itemCode, 'pro');
    assert.deepEqual([...activePasses([...items, item({ itemId: 'c' })], now)], ['music']);
    assert.equal(activeBasePlan([item({ status: 'expired' })], now), null);
  });
});

/** Hook 3 (tagged append-only credit ledger), Hook 7 (whole-unit money), pinned spend order. */
describe('plans hooks: credit ledger engine', () => {
  const now = 200;
  const parsed = (raw: unknown) => {
    const result = parseGrant(raw);
    if (!result.ok) throw new Error(result.reason);
    return result.grant;
  };

  it('rejects malformed grants by name', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'bad_payload'],
      [{ engine: 'sonar', source: 'plan', amount: 10 }, 'bad_engine'],
      [{ source: 'maybe', amount: 10 }, 'bad_source'],
      [{ source: 'plan', amount: 0 }, 'bad_amount'],
      [{ source: 'plan', amount: 1.5 }, 'bad_amount'],
      [{ source: 'plan', amount: 10, expiresAt: 0 }, 'bad_expires'],
      [{ source: 'plan', amount: 10, jobId: '' }, 'bad_job'],
    ];
    for (const [raw, reason] of cases) {
      const result = parseGrant(raw);
      assert.equal(result.ok, false, reason);
      if (!result.ok) assert.equal(result.reason, reason);
    }
  });

  it('numbers ledger entries per user and never mutates the caller array', () => {
    const first = appendGrant([], 'u', parsed({ source: 'top_up', amount: 50 }), now);
    assert.equal(first.entry.entryId, 'led_u_1');
    const second = appendGrant(first.entries, 'u', parsed({ source: 'top_up', amount: 10 }), now);
    assert.equal(second.entry.entryId, 'led_u_2');
    assert.equal(first.entries.length, 1);
  });

  it('counts expired positive grants as dead and negatives always', () => {
    let entries: LedgerEntry[] = [];
    entries = appendGrant(entries, 'u', parsed({ source: 'free_window', amount: 10, expiresAt: 100 }), now).entries;
    entries = appendGrant(entries, 'u', parsed({ source: 'plan', amount: 20 }), now).entries;
    assert.equal(creditBalance(entries, 300, ''), 20);
    const spent = spend(entries, 'u', { engine: '', amount: 20, jobId: 'job_1', costUsdMicros: 30000 }, 300);
    assert.equal(spent.ok, true);
    if (spent.ok) {
      assert.equal(creditBalance(spent.entries, 1000, ''), 0);
      const overspent = spend(spent.entries, 'u', { engine: '', amount: 1, jobId: 'job_2', costUsdMicros: 0 }, 1000);
      assert.equal(overspent.ok, false);
      if (!overspent.ok) {
        assert.equal(overspent.reason, 'insufficient_credits');
        assert.equal(overspent.shortfall, 1);
      }
    }
  });

  it('pins the spend order: free_window, then plan, then pass, then top-up; earlier expiry first', () => {
    let entries: LedgerEntry[] = [];
    entries = appendGrant(entries, 'u', parsed({ source: 'top_up', amount: 5 }), now).entries;
    entries = appendGrant(entries, 'u', parsed({ source: 'pass', amount: 5 }), now).entries;
    entries = appendGrant(entries, 'u', parsed({ source: 'free_window', amount: 10 }), now).entries;
    const result = spend(entries, 'u', { engine: '', amount: 15, jobId: 'job_3', costUsdMicros: 0 }, now);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual([...result.from], [
        { entryId: 'led_u_3', source: 'free_window', used: 10 },
        { entryId: 'led_u_2', source: 'pass', used: 5 },
      ]);
    }
    let expiryEntries: LedgerEntry[] = [];
    expiryEntries = appendGrant(expiryEntries, 'u', parsed({ source: 'plan', amount: 5, expiresAt: 900 }), now).entries;
    expiryEntries = appendGrant(expiryEntries, 'u', parsed({ source: 'plan', amount: 5, expiresAt: 400 }), now).entries;
    const byExpiry = spend(expiryEntries, 'u', { engine: '', amount: 7, jobId: 'job_4', costUsdMicros: 0 }, now);
    assert.equal(byExpiry.ok, true);
    if (byExpiry.ok) {
      assert.deepEqual([...byExpiry.from], [
        { entryId: 'led_u_2', source: 'plan', used: 5 },
        { entryId: 'led_u_1', source: 'plan', used: 2 },
      ]);
    }
  });

  it('spends the engine pool first, then general credits', () => {
    let entries: LedgerEntry[] = [];
    entries = appendGrant(entries, 'u', parsed({ source: 'top_up', amount: 10 }), now).entries;
    entries = appendGrant(entries, 'u', parsed({ engine: 'music', source: 'pass', amount: 10 }), now).entries;
    const result = spend(entries, 'u', { engine: 'music', amount: 15, jobId: 'job_5', costUsdMicros: 1 }, now);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual([...result.from], [
        { entryId: 'led_u_2', source: 'pass', used: 10 },
        { entryId: 'led_u_1', source: 'top_up', used: 5 },
      ]);
      const negatives = result.entries.slice(-2);
      assert.equal(negatives[0].engine, 'music');
      assert.equal(negatives[1].engine, '');
      assert.equal(negatives[0].costUsdMicros, 1);
      assert.equal(negatives[1].costUsdMicros, 0);
      assert.equal(negatives[0].jobId, 'job_5');
    }
    const balances = balanceByEngine(entries, now);
    assert.equal(balances.general, 10);
    assert.deepEqual([...balances.engines], [{ engine: 'music', balance: 10 }]);
  });

  it('refuses an uncovered spend atomically and never mutates the caller array', () => {
    let entries: LedgerEntry[] = [];
    entries = appendGrant(entries, 'u', parsed({ source: 'plan', amount: 10 }), now).entries;
    const frozen = [...entries];
    const result = spend(entries, 'u', { engine: '', amount: 99, jobId: 'job_6', costUsdMicros: 0 }, now);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'insufficient_credits');
      assert.equal(result.shortfall, 89);
    }
    assert.deepEqual(entries, frozen);
  });
});

/** Hook 2 (canUse is the only access check), Hook 2b (free-level fallback), Hook 5 (switches). */
describe('plans hooks: access engine', () => {
  const limits = { windowCredits: 40, windowHours: 5, monthlyCeiling: 600 };
  const config = (over: Partial<AccessConfig> = {}): AccessConfig => ({
    gatesEnabled: true,
    featureSwitches: {},
    engineBundlePlans: [],
    freeEngineLimits: limits,
    ...over,
  });
  const input = (feature: string, over: Partial<AccessInput> = {}): AccessInput => ({
    items: [],
    legacyPlan: 'free',
    legacyPasses: [],
    feature,
    config: config(),
    now: 1000,
    ...over,
  });

  it('takes the base plan from the subscription list ahead of the legacy column', () => {
    const items: SubscriptionItem[] = [
      { itemId: 'sub_u_1', userId: 'u', itemType: 'base_plan', itemCode: 'pro', startsAt: 0, endsAt: 2000, status: 'active', source: 'e' },
    ];
    const decision = canUse(input('AI-045', { items, legacyPlan: 'free' }));
    assert.equal(decision.allowed, true);
    assert.equal(decision.plan, 'pro');
    assert.equal(decision.reason, 'unlocked');
    assert.equal(decision.level, null);
  });

  it('falls back to the legacy plan column when there is no base-plan item', () => {
    const decision = canUse(input('AI-045', { legacyPlan: 'pro' }));
    assert.equal(decision.allowed, true);
    assert.equal(decision.plan, 'pro');
  });

  it('runs an unpaid engine at the free level, never locked out (Hook 2b)', () => {
    const decision = canUse(input('TQ-027'));
    assert.equal(decision.allowed, true);
    assert.equal(decision.level, 'free');
    assert.equal(decision.reason, 'engine_free_level');
    assert.deepEqual([...(decision.engine ?? [])], ['manhwa', '3d', 'music']);
    assert.deepEqual(decision.limits, limits);
  });

  it('runs a paid engine when the user owns one of the row engine passes', () => {
    const decision = canUse(input('TQ-027', { legacyPasses: ['music'] }));
    assert.equal(decision.allowed, true);
    assert.equal(decision.level, 'paid');
    assert.equal(decision.reason, 'engine_paid');
    const wrong = canUse(input('TQ-027', { legacyPasses: ['voice'] }));
    assert.equal(wrong.level, 'free');
  });

  it('treats bundle plans as owning every engine', () => {
    const decision = canUse(input('TQ-027', { legacyPlan: 'studio', config: config({ engineBundlePlans: ['studio'] }) }));
    assert.equal(decision.level, 'paid');
    assert.equal(decision.reason, 'engine_paid');
  });

  it('switches a feature off without a release (Hook 5)', () => {
    const decision = canUse(input('CO-001', { config: config({ featureSwitches: { 'CO-001': false } }) }));
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'feature_off');
  });

  it('lets everyone through when the gates are disabled', () => {
    const decision = canUse(input('AI-045', { legacyPlan: 'free', config: config({ gatesEnabled: false }) }));
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'gates_disabled');
  });

  it('passes internal rows through and names plan_too_low denials', () => {
    const internalDecision = canUse(input('CO-063'));
    assert.equal(internalDecision.allowed, true);
    assert.equal(internalDecision.reason, 'internal');
    const lowDecision = canUse(input('AI-045', { legacyPlan: 'free' }));
    assert.equal(lowDecision.allowed, false);
    assert.equal(lowDecision.reason, 'plan_too_low');
  });
});
