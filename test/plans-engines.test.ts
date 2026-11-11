import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  checkEntitlement,
  DEFAULT_PLAN,
  ENGINE_BY_FEATURE,
  ENGINE_NAMES,
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
  type GateId,
  type LedgerEntry,
  type PlanId,
  type SubscriptionItem,
} from '../src/modules/plans/index.ts';
import {
  REGION_BAND_MULTIPLIERS,
  bandPriceMinor,
  lookupCountry,
  validateCountryRow,
  assembleAccessSnapshot,
  verifyAccessSnapshot,
  isAdmin,
  validateAdminAction,
  redeemPromotion,
  validatePromotion,
  consumeRateLimit,
  validateRateLimitRule,
  accountRetention,
  buildAccountExport,
  validateDeletionRequest,
} from '../src/modules/plans/index.ts';

/** The PLAN GATE LAW, pinned: one gate per feature, plans cumulative, Studio covers Team, internal never sold. */
describe('plans engine (PLAN GATE LAW)', () => {
  it('walks the plan ladder: cumulative plans, Studio covers Team but never Enterprise', () => {
    const ladder: Array<{ plan: PlanId; gates: Record<GateId, boolean> }> = [
      { plan: 'free', gates: { free: true, plus: false, pro: false, team: false, enterprise: false, internal: true, engine: true } },
      { plan: 'plus', gates: { free: true, plus: true, pro: false, team: false, enterprise: false, internal: true, engine: true } },
      { plan: 'pro', gates: { free: true, plus: true, pro: true, team: false, enterprise: false, internal: true, engine: true } },
      { plan: 'studio', gates: { free: true, plus: true, pro: true, team: true, enterprise: false, internal: true, engine: true } },
      { plan: 'team', gates: { free: true, plus: true, pro: true, team: true, enterprise: false, internal: true, engine: true } },
      { plan: 'enterprise', gates: { free: true, plus: true, pro: true, team: true, enterprise: true, internal: true, engine: true } },
    ];
    for (const row of ladder) {
      for (const [gate, allowed] of Object.entries(row.gates) as Array<[GateId, boolean]>) {
        const verdict = checkEntitlement({ plan: row.plan, enginePasses: [] }, gate === 'engine' ? 'TQ-027' : 'CO-001', gate);
        assert.equal(verdict.allowed, allowed, row.plan + ' x ' + gate);
      }
    }
  });

  it('pins the catalog gate counts (210 features, one gate each)', () => {
    const counts: Record<string, number> = {};
    for (const gate of Object.values(FEATURE_GATES)) counts[gate] = (counts[gate] ?? 0) + 1;
    assert.equal(Object.keys(FEATURE_GATES).length, 210);
    assert.deepEqual(counts, { free: 88, internal: 59, pro: 26, enterprise: 16, team: 10, plus: 10, engine: 1 });
  });

  it('pins spot-checked gates from the With-Plans catalog', () => {
    const pinned: Array<[string, string]> = [
    ['CO-001', 'free'],
    ['CO-004', 'enterprise'],
    ['CO-010', 'plus'],
    ['CO-020', 'team'],
    ['CO-063', 'internal'],
    ['CO-091', 'internal'],
    ['CO-093', 'internal'],
    ['CO-100', 'free'],
    ['AI-015', 'internal'],
    ['AI-016', 'internal'],
    ['AI-018', 'internal'],
    ['AI-084', 'pro'],
    ['AI-085', 'free'],
    ['AI-086', 'free'],
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

  it('pins the catalog engines (ten engines, full names, sold per engine under any base plan)', () => {
    assert.deepEqual([...ENGINES], ['painting', 'manhwa', 'music', 'voice', 'audio', 'video', 'film', '3d', 'games', 'writing']);
    assert.equal(ENGINE_NAMES['manhwa'], 'Manhwa / comics');
    assert.equal(ENGINE_NAMES['3d'], '3D and world');
    assert.equal(ENGINE_NAMES['video'], 'Video and animation');
    assert.equal(isEngineCode('painting'), true);
    assert.equal(isEngineCode('film'), true);
    assert.equal(isEngineCode('games'), true);
    assert.equal(isEngineCode('writing'), true);
    assert.equal(isEngineCode('creative'), false);
    assert.equal(isEngineCode('sonar'), false);
    assert.equal(isEngineCode(42), false);
  });

  it('never locks engine rows: an owned pass runs paid level, everything else runs free level', () => {
    assert.deepEqual([...(ENGINE_BY_FEATURE['TQ-027'] ?? [])], ['manhwa', '3d', 'music']);
    assert.equal(FEATURE_GATES['TQ-027'], 'engine');
    const unpaid = checkEntitlement({ plan: 'enterprise', enginePasses: [] }, 'TQ-027', 'engine');
    assert.equal(unpaid.allowed, true);
    assert.equal(unpaid.reason, 'unlocked');
    assert.equal(unpaid.engineLimits, 'free_level');
    const wrongPass = checkEntitlement({ plan: 'enterprise', enginePasses: ['voice'] }, 'TQ-027', 'engine');
    assert.equal(wrongPass.allowed, true);
    assert.equal(wrongPass.engineLimits, 'free_level');
    const owned = checkEntitlement({ plan: 'pro', enginePasses: ['music'] }, 'TQ-027', 'engine');
    assert.equal(owned.allowed, true);
    assert.equal(owned.reason, 'unlocked');
    assert.equal(owned.engineLimits, 'paid_level');
  });

  it('pins plan ids and the free default', () => {
    assert.deepEqual([...PLAN_IDS], ['free', 'plus', 'pro', 'studio', 'team', 'enterprise']);
    assert.equal(DEFAULT_PLAN, 'free');
    assert.equal(isPlanId('pro'), true);
    assert.equal(isPlanId('diamond'), false);
    assert.equal(isPlanId(42), false);
  });

  it('pins every wired route to a catalog feature (292 routes)', () => {
    assert.equal(Object.keys(ROUTE_GATES).length, 292);
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
    ['/v1/sync/operations', 'CO-100', 'free'],
    ['/v1/ai-training/tuning/define', 'AI-015', 'internal'],
    ['/v1/ai-training/distill/plan', 'AI-016', 'internal'],
    ['/v1/ai-training/tracking/define', 'AI-018', 'internal'],
    ['/v1/ai-training/tasks/start', 'AI-084', 'pro'],
    ['/v1/ai-training/tasks/budget/define', 'AI-085', 'free'],
    ['/v1/ai-training/critique/run', 'AI-086', 'free'],
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
      assert.equal(applied.superseded[0]?.status, 'cancelled');
      assert.equal(applied.items[0]?.status, 'cancelled');
      assert.equal(applied.granted[0]?.itemId, 'sub_u_2');
      assert.equal(applied.granted[0]?.itemCode, 'pro');
    }
    const parsedPass = parsePaymentEvent(event([{ itemType: 'engine_pass', itemCode: 'music', startsAt: 0, endsAt: 2000 }]));
    assert.equal(parsedPass.ok, true);
    if (parsedPass.ok) {
      const passOnly = applyPaymentEvent(existing, parsedPass.event);
      assert.equal(passOnly.superseded.length, 0);
      assert.equal(passOnly.items[0]?.status, 'active');
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
    let entries: readonly LedgerEntry[] = [];
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
    let entries: readonly LedgerEntry[] = [];
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
    let expiryEntries: readonly LedgerEntry[] = [];
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
    let entries: readonly LedgerEntry[] = [];
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
      assert.equal(negatives[0]?.engine, 'music');
      assert.equal(negatives[1]?.engine, '');
      assert.equal(negatives[0]?.costUsdMicros, 1);
      assert.equal(negatives[1]?.costUsdMicros, 0);
      assert.equal(negatives[0]?.jobId, 'job_5');
    }
    const balances = balanceByEngine(entries, now);
    assert.equal(balances.general, 10);
    assert.deepEqual([...balances.engines], [{ engine: 'music', balance: 10 }]);
  });

  it('refuses an uncovered spend atomically and never mutates the caller array', () => {
    let entries: readonly LedgerEntry[] = [];
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

/** Hook 8 - the country table, pure engine pinned. */
describe('country registry (Hook 8)', () => {
  const row = {
    code: 'NG',
    currency: 'NGN',
    regionBand: 'B',
    taxRule: 'VAT 7.5%',
    taxCheckedAt: 1_760_000_000_000,
    paymentMethods: ['paystack'],
    enabled: true,
    minimumPayoutMinor: 100_000,
  };

  it('names every row refusal and normalizes codes', () => {
    const ok = validateCountryRow(row);
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.equal(ok.value.code, 'NG');
      assert.equal(ok.value.regionBand, 'B');
      assert.equal(ok.value.enabled, true);
    }
    const lowered = validateCountryRow({ ...row, code: 'ng' });
    assert.ok(lowered.ok);
    if (lowered.ok) assert.equal(lowered.value.code, 'NG');
    assert.deepEqual(validateCountryRow({ ...row, code: 'NGA' }), { ok: false, reason: 'country-no-code' });
    assert.deepEqual(validateCountryRow({ ...row, currency: 'NAIRA' }), { ok: false, reason: 'country-bad-currency' });
    assert.deepEqual(validateCountryRow({ ...row, regionBand: 'D' }), { ok: false, reason: 'country-bad-band' });
    assert.deepEqual(validateCountryRow({ ...row, taxRule: '' }), { ok: false, reason: 'country-no-tax-rule' });
    assert.deepEqual(validateCountryRow({ ...row, taxCheckedAt: -1 }), { ok: false, reason: 'country-bad-tax-date' });
    assert.deepEqual(validateCountryRow({ ...row, paymentMethods: [] }), { ok: false, reason: 'country-bad-payment-methods' });
    assert.deepEqual(validateCountryRow({ ...row, minimumPayoutMinor: -5 }), { ok: false, reason: 'country-bad-min-payout' });
  });

  it('looks up countries and prices by region band (ALG-43)', () => {
    assert.deepEqual(REGION_BAND_MULTIPLIERS, { A: 1, B: 0.7, C: 0.45 });
    assert.equal(bandPriceMinor(1000, 'B').ok && (bandPriceMinor(1000, 'B') as { value: number }).value, 700);
    assert.deepEqual(bandPriceMinor(1000, 'A'), { ok: true, value: 1000 });
    assert.deepEqual(bandPriceMinor(1005, 'C'), { ok: true, value: Math.round(452.25) });
    assert.deepEqual(bandPriceMinor(0, 'A'), { ok: false, reason: 'country-bad-base-price' });
    const valid = validateCountryRow(row);
    assert.ok(valid.ok);
    if (valid.ok) {
      assert.ok(lookupCountry([valid.value], 'NG').ok);
      assert.deepEqual(lookupCountry([valid.value], 'GH'), { ok: false, reason: 'country-unknown:GH' });
      const disabled = validateCountryRow({ ...row, code: 'GH', enabled: false });
      assert.ok(disabled.ok);
      if (disabled.ok) assert.deepEqual(lookupCountry([disabled.value], 'GH'), { ok: false, reason: 'country-disabled:GH' });
    }
  });
});

/** Hook 9 - cached access for bad networks, pure engine pinned. */
describe('access snapshot (Hook 9)', () => {
  it('assembles a snapshot with sorted unique passes and honest bounds', () => {
    const ok = assembleAccessSnapshot({ userId: 'u1', plan: 'pro', passes: ['music', 'painting', 'music'], now: 1000, ttlMs: 6 * 3_600_000 });
    assert.ok(ok.ok);
    if (ok.ok) assert.deepEqual({ plan: ok.value.plan, passes: [...ok.value.passes], issuedAt: ok.value.issuedAt, expiresAt: ok.value.expiresAt }, { plan: 'pro', passes: ['music', 'painting'], issuedAt: 1000, expiresAt: 1000 + 6 * 3_600_000 });
    assert.deepEqual(assembleAccessSnapshot({ userId: '', plan: 'pro', passes: [], now: 1000, ttlMs: 3_600_000 }), { ok: false, reason: 'snapshot-no-user' });
    assert.deepEqual(assembleAccessSnapshot({ userId: 'u1', plan: '', passes: [], now: 1000, ttlMs: 3_600_000 }), { ok: false, reason: 'snapshot-bad-plan' });
    assert.deepEqual(assembleAccessSnapshot({ userId: 'u1', plan: 'pro', passes: [42 as unknown as string], now: 1000, ttlMs: 3_600_000 }), { ok: false, reason: 'snapshot-bad-passes' });
    assert.deepEqual(assembleAccessSnapshot({ userId: 'u1', plan: 'pro', passes: [], now: 1000, ttlMs: 0 }), { ok: false, reason: 'snapshot-bad-ttl' });
  });

  it('verifies shapes, expiry and remaining time; the server stays the boss', () => {
    const built = assembleAccessSnapshot({ userId: 'u1', plan: 'pro', passes: [], now: 1000, ttlMs: 3_600_000 });
    assert.ok(built.ok);
    if (built.ok) {
      const valid = verifyAccessSnapshot(built.value, 1000 + 3_600_000 - 1);
      assert.ok(valid.ok);
      if (valid.ok) assert.equal(valid.value.remainingMs, 1);
      assert.deepEqual(verifyAccessSnapshot(built.value, 1000 + 3_600_000 + 1), { ok: false, reason: 'snapshot-expired:u1' });
    }
    assert.deepEqual(verifyAccessSnapshot('nope', 1000), { ok: false, reason: 'snapshot-bad-shape' });
    assert.deepEqual(verifyAccessSnapshot({ userId: '', plan: 'pro', passes: [], issuedAt: 0, expiresAt: 10 }, 5), { ok: false, reason: 'snapshot-bad-shape' });
  });
});

/** Hook 11 - the basic admin console, pure engine pinned. */
describe('admin console (Hook 11)', () => {
  it('checks the allowlist and names every action refusal', () => {
    assert.equal(isAdmin(['u_admin'], 'u_admin'), true);
    assert.equal(isAdmin(['u_admin'], 'u_other'), false);
    assert.equal(isAdmin([], 'u_admin'), false);
    assert.equal(isAdmin(['u_admin'], ''), false);
    const ok = validateAdminAction({ action: 'grant_credits', userId: 'u1', amount: 10, engine: 'music', reason: 'goodwill' });
    assert.ok(ok.ok);
    if (ok.ok) assert.deepEqual({ action: ok.value.action, amount: ok.value.amount, reason: ok.value.reason }, { action: 'grant_credits', amount: 10, reason: 'goodwill' });
    assert.deepEqual(validateAdminAction({ action: 'nuke', userId: 'u1', reason: 'r' }), { ok: false, reason: 'admin-action-unknown:nuke' });
    assert.deepEqual(validateAdminAction({ action: 'grant_credits', userId: '', reason: 'r', amount: 5 }), { ok: false, reason: 'admin-no-target' });
    assert.deepEqual(validateAdminAction({ action: 'grant_credits', userId: 'u1', amount: 5, reason: '' }), { ok: false, reason: 'admin-reason-required' });
    assert.deepEqual(validateAdminAction({ action: 'grant_credits', userId: 'u1', amount: 0, reason: 'r' }), { ok: false, reason: 'admin-grant-amount-invalid' });
    assert.deepEqual(validateAdminAction({ action: 'comp_plan', userId: 'u1', plan: '', reason: 'r' }), { ok: false, reason: 'admin-comp-plan-invalid' });
    assert.deepEqual(validateAdminAction({ action: 'pause_account', userId: 'u1', reason: 'r', pause: 'yes' as unknown as boolean }), { ok: false, reason: 'admin-pause-flag-invalid' });
    const paused = validateAdminAction({ action: 'pause_account', userId: 'u1', reason: 'abuse', pause: true });
    assert.ok(paused.ok);
    if (paused.ok) assert.equal(paused.value.pause, true);
  });
});

/** Hook 12 - coupons, trials and referrals as one model, pure engine pinned. */
describe('promotions (Hook 12)', () => {
  const now = 1_000_000;
  const spec = { code: 'launch', kind: 'coupon', creditAmount: 25, days: 0, maxRedemptions: 2, perUserLimit: true, expiresAt: now + 500_000 };

  it('names every definition refusal', () => {
    const ok = validatePromotion(spec, now);
    assert.ok(ok.ok);
    if (ok.ok) assert.equal(ok.value.code, 'LAUNCH');
    assert.deepEqual(validatePromotion({ ...spec, code: ' ' }, now), { ok: false, reason: 'promotion-no-code' });
    assert.deepEqual(validatePromotion({ ...spec, kind: 'gift' }, now), { ok: false, reason: 'promotion-kind-unknown:gift' });
    assert.deepEqual(validatePromotion({ ...spec, creditAmount: 0, days: 0 }, now), { ok: false, reason: 'promotion-no-benefit' });
    assert.deepEqual(validatePromotion({ ...spec, creditAmount: 1.5 }, now), { ok: false, reason: 'promotion-bad-credits' });
    assert.deepEqual(validatePromotion({ ...spec, days: -1 }, now), { ok: false, reason: 'promotion-bad-days' });
    assert.deepEqual(validatePromotion({ ...spec, maxRedemptions: 0 }, now), { ok: false, reason: 'promotion-bad-limit' });
    assert.deepEqual(validatePromotion({ ...spec, expiresAt: now }, now), { ok: false, reason: 'promotion-bad-expiry' });
  });

  it('redeems once per user and refuses expired codes and exhausted limits', () => {
    const checked = validatePromotion(spec, now);
    assert.ok(checked.ok);
    if (checked.ok) {
      const first = redeemPromotion(checked.value, [], 'u1', now);
      assert.ok(first.ok);
      if (first.ok) assert.equal(first.value.redemptionCount, 1);
      assert.deepEqual(redeemPromotion(checked.value, [{ code: 'LAUNCH', userId: 'u1', at: now }], 'u1', now), { ok: false, reason: 'promotion-already-redeemed:LAUNCH' });
      assert.deepEqual(redeemPromotion(checked.value, [], 'u1', now + 600_000), { ok: false, reason: 'promotion-expired:LAUNCH' });
      const both = [{ code: 'LAUNCH', userId: 'u1', at: now }, { code: 'LAUNCH', userId: 'u2', at: now }];
      assert.deepEqual(redeemPromotion(checked.value, both, 'u3', now), { ok: false, reason: 'promotion-limit-reached:LAUNCH' });
    }
  });
});

/** Hook 14 - rate limits at the gateway, pure engine pinned. */
describe('rate limits (Hook 14)', () => {
  it('validates rules and walks a fixed window honestly', () => {
    assert.deepEqual(validateRateLimitRule({ limit: 0, windowMs: 1000 }), { ok: false, reason: 'rate-limit-rule-invalid:limit' });
    assert.deepEqual(validateRateLimitRule({ limit: 5, windowMs: 100 }), { ok: false, reason: 'rate-limit-rule-invalid:windowMs' });
    const rule = { limit: 2, windowMs: 60_000 };
    const first = consumeRateLimit(null, rule, 1000);
    assert.deepEqual(first, { ok: true, value: { count: 1, resetAt: 61_000 } });
    const second = consumeRateLimit(first.ok ? first.value : null, rule, 2000);
    assert.deepEqual(second, { ok: true, value: { count: 2, resetAt: 61_000 } });
    const third = consumeRateLimit(second.ok ? second.value : null, rule, 3000);
    assert.ok(!third.ok);
    if (!third.ok) {
      assert.equal(third.reason, 'rate-limited');
      assert.equal(third.retryAfterMs, 61_000 - 3000);
    }
    const afterWindow = consumeRateLimit({ count: 2, resetAt: 5000 }, rule, 5000);
    assert.deepEqual(afterWindow, { ok: true, value: { count: 1, resetAt: 65_000 } });
    assert.deepEqual(consumeRateLimit(null, rule, -1), { ok: false, reason: 'rate-limit-bad-now', retryAfterMs: 0 });
  });
});

/** Hook 16 - export and delete my data, pure engine pinned. */
describe('account data (Hook 16)', () => {
  it('builds an honest export bundle and names the retention policy', () => {
    const retention = accountRetention();
    assert.deepEqual(retention.keep, ['invoices']);
    assert.ok(retention.erase.includes('credit_ledger'));
    assert.ok(retention.verify.includes('nigeria_ndpr'));
    const bundle = buildAccountExport({ userId: 'u1', plan: 'pro', passes: ['music'], items: [{ itemId: 'i1' }], ledger: [{ entryId: 'e1' }], now: 5000 });
    assert.ok(bundle.ok);
    if (bundle.ok) {
      assert.deepEqual({ userId: bundle.value.userId, exportedAt: bundle.value.exportedAt, plan: bundle.value.plan, passes: [...bundle.value.passes], items: bundle.value.subscriptionItems.length, ledger: bundle.value.creditLedger.length }, { userId: 'u1', exportedAt: 5000, plan: 'pro', passes: ['music'], items: 1, ledger: 1 });
      assert.deepEqual(bundle.value.retention, retention);
    }
    assert.deepEqual(buildAccountExport({ userId: '', plan: 'pro', passes: [], items: [], ledger: [], now: 1 }), { ok: false, reason: 'export-no-user' });
  });

  it('refuses an unconfirmed deletion request by name', () => {
    assert.deepEqual(validateDeletionRequest({ userId: 'u1', confirm: false }), { ok: false, reason: 'account-delete-unconfirmed' });
    assert.deepEqual(validateDeletionRequest({ userId: '', confirm: true }), { ok: false, reason: 'export-no-user' });
    assert.deepEqual(validateDeletionRequest({ userId: 'u1', confirm: true }), { ok: true, value: { userId: 'u1' } });
  });
});

