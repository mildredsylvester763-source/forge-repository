import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { AppError } from '../../kernel/errors.ts';
import { E2E_ACTIONS, planE2eSuite } from './engine/e2e-session-replay.ts';
import { FUZZ_FIELD_TYPES, FUZZ_KINDS, runFuzzCampaign } from './engine/fuzz-testing.ts';
import { planIntegrationTests } from './engine/integration-graph.ts';
import { planPropertySuite } from './engine/property-based.ts';
import { UNIT_KINDS, UNIT_PARAM_TYPES, planUnitTests } from './engine/unit-test-generation.ts';
import { TestGenerationEvents, TEST_GENERATION_EVENT_VERSION } from './events.ts';
import type { GeneratedSuiteStore } from './generated-suite-store.ts';

export interface TestGenerationDeps {
  readonly suites: GeneratedSuiteStore;
  readonly events: EventStore;
  readonly clock: Clock;
}

export interface SuiteSummary {
  readonly id: string;
  readonly kind: string;
  readonly target: string;
  readonly seed: number;
  readonly checksum: string;
  readonly cases: unknown;
  readonly count: number;
}

export interface SuiteListItem {
  readonly id: string;
  readonly kind: string;
  readonly target: string;
  readonly checksum: string;
  readonly createdAt: number;
}

const refusal = (reason: string): AppError => new AppError(400, reason, reason);

/** FNV-1a 32-bit checksum: identical requests always produce identical checksums. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const serviceNames = (services: unknown): string[] => {
  const list = Array.isArray(services) ? services : [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name === 'string') out.push(name);
  }
  return out;
};

/**
 * FORGE TQ-031..035. The service is a thin, auditable shell over five pure
 * engines: it never re-implements engine rules, it only enforces ownership,
 * persists generated suites with deterministic FNV-1a checksums and emits
 * events. Every engine refusal carries a reason, so the wrappers throw on !ok.
 */
export class TestGenerationService {
  private readonly suites: GeneratedSuiteStore;
  private readonly events: EventStore;
  private readonly clock: Clock;

  constructor(deps: TestGenerationDeps) {
    this.suites = deps.suites;
    this.events = deps.events;
    this.clock = deps.clock;
  }

  unitKinds(): readonly string[] {
    return UNIT_KINDS;
  }

  unitParamTypes(): readonly string[] {
    return UNIT_PARAM_TYPES;
  }

  e2eActions(): readonly string[] {
    return E2E_ACTIONS;
  }

  fuzzKinds(): readonly string[] {
    return FUZZ_KINDS;
  }

  fuzzFieldTypes(): readonly string[] {
    return FUZZ_FIELD_TYPES;
  }

  async generateUnitTests(userId: string, body: unknown): Promise<SuiteSummary> {
    const verdict = planUnitTests(body as { target?: unknown; behaviors?: unknown });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'unit-refused');
    const cases = verdict.cases ?? [];
    const checksum = fnv1a(cases.map((c) => c.name).join('|'));
    return this.persist(userId, 'unit', verdict.target ?? '', 42, checksum, cases);
  }

  async generateIntegrationTests(userId: string, body: unknown): Promise<SuiteSummary> {
    const verdict = planIntegrationTests(body as { services?: unknown; dependencies?: unknown });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'integration-refused');
    const target = serviceNames((body as { services?: unknown }).services).join('+').slice(0, 200);
    const cases = verdict.cases ?? [];
    const checksum = fnv1a(cases.map((c) => c.name).join('|'));
    return this.persist(userId, 'integration', target, 42, checksum, cases);
  }

  async generateE2eSuite(userId: string, body: unknown): Promise<SuiteSummary> {
    const verdict = planE2eSuite(body as { session?: unknown; steps?: unknown });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'e2e-refused');
    const steps = verdict.steps ?? [];
    const checksum = fnv1a(steps.map((s) => s.action + ':' + s.target).join('|'));
    return this.persist(userId, 'e2e', verdict.session ?? '', 42, checksum, steps);
  }

  async planPropertySuite(userId: string, body: unknown): Promise<SuiteSummary> {
    const verdict = planPropertySuite(body as { name?: unknown; runs?: unknown; seed?: unknown });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'property-refused');
    const repro = verdict.repro ?? '';
    return this.persist(userId, 'property', verdict.name ?? '', verdict.seed ?? 42, fnv1a(repro), [
      { repro },
    ]);
  }

  async runFuzzCampaign(userId: string, body: unknown): Promise<SuiteSummary> {
    const verdict = runFuzzCampaign(body as {
      kind?: unknown;
      fields?: unknown;
      samples?: unknown;
      budget?: unknown;
      seed?: unknown;
    });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'fuzz-refused');
    const cases = verdict.cases ?? [];
    const checksum = fnv1a(
      cases.map((c) => (c.mutation !== undefined ? c.mutation : Object.keys(c.input).sort().join(','))).join('|'),
    );
    return this.persist(userId, 'fuzz', verdict.kind ?? '', verdict.seed ?? 42, checksum, cases);
  }

  async getSuite(userId: string, id: string): Promise<unknown> {
    const row = await this.suites.find(userId, id);
    if (!row) throw refusal('suite-not-found:' + id);
    return row;
  }

  async listSuites(userId: string): Promise<SuiteListItem[]> {
    const rows = await this.suites.listByUser(userId, 50);
    return rows.map((r) => ({ id: r.id, kind: r.kind, target: r.target, checksum: r.checksum, createdAt: r.createdAt }));
  }

  private async persist(
    userId: string,
    kind: string,
    target: string,
    seed: number,
    checksum: string,
    cases: unknown,
  ): Promise<SuiteSummary> {
    const count = Array.isArray(cases) ? cases.length : 0;
    const saved = await this.suites.create({ userId, kind, target, seed, checksum, cases, now: this.clock() });
    await this.events.append({
      type: TestGenerationEvents.SuiteGenerated,
      version: TEST_GENERATION_EVENT_VERSION,
      actor: { kind: 'user', id: userId },
      subject: { type: 'test_generation_suite', id: saved.id },
      payload: { kind, target, caseCount: count },
    });
    return { id: saved.id, kind, target, seed, checksum, cases, count };
  }
}
