import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { AppError } from '../../kernel/errors.ts';
import {
  MUTATION_OPERATORS,
  planMutants as planMutantsEngine,
  scoreMutants as scoreMutantsEngine,
  type MutationPlanInput,
  type MutationPlanResult,
  type MutationScoreInput,
  type MutationScoreResult,
} from './engine/mutation-testing.ts';
import {
  buildPact as buildPactEngine,
  verifyContract as verifyContractEngine,
  type BuildPactInput,
  type PactResult,
  type VerifyContractInput,
} from './engine/contract-testing.ts';
import { manageSnapshot as manageSnapshotEngine, SNAPSHOT_MODES } from './engine/snapshot-testing.ts';
import { diffImages as diffImagesEngine, type VisualDiffInput, type VisualDiffResult } from './engine/visual-regression.ts';
import {
  MATRIX_BROWSERS,
  MATRIX_PLATFORMS,
  MATRIX_STATUSES,
  MATRIX_VIEWPORTS,
  planMatrix as planMatrixEngine,
  scoreMatrix as scoreMatrixEngine,
  type MatrixPlanInput,
  type MatrixPlanResult,
  type MatrixScoreInput,
  type MatrixScoreResult,
} from './engine/browser-matrix.ts';
import { TestQualityEvents, TEST_QUALITY_EVENT_VERSION } from './events.ts';
import type { TestQualityGoldenStore } from './golden-store.ts';

export interface TestQualityDeps {
  readonly goldens: TestQualityGoldenStore;
  readonly events: EventStore;
  readonly clock: Clock;
}

export interface GoldenSummary {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly lines: number;
}

export interface GoldenVerification {
  readonly name: string;
  readonly status: string;
  readonly checksum: string;
  readonly lines: number;
}

export interface GoldenListItem {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly createdAt: number;
}

const refusal = (reason: string): AppError => new AppError(400, reason, reason);

/**
 * FORGE TQ-036..040. The service is a thin, auditable shell over five pure
 * engines: it never re-implements engine rules, it only enforces ownership,
 * persists golden files and emits events. Every engine refusal carries a
 * reason, so the wrappers throw on !ok; a snapshot mismatch is a refusal,
 * not a verdict.
 */
export class TestQualityService {
  private readonly goldens: TestQualityGoldenStore;
  private readonly events: EventStore;
  private readonly clock: Clock;

  constructor(deps: TestQualityDeps) {
    this.goldens = deps.goldens;
    this.events = deps.events;
    this.clock = deps.clock;
  }

  mutationOperators(): readonly string[] {
    return MUTATION_OPERATORS;
  }

  snapshotModes(): readonly string[] {
    return SNAPSHOT_MODES;
  }

  matrixCatalogs(): {
    browsers: readonly string[];
    platforms: readonly string[];
    viewports: readonly string[];
    statuses: readonly string[];
  } {
    return {
      browsers: MATRIX_BROWSERS,
      platforms: MATRIX_PLATFORMS,
      viewports: MATRIX_VIEWPORTS,
      statuses: MATRIX_STATUSES,
    };
  }

  planMutants(input: MutationPlanInput): MutationPlanResult {
    const verdict = planMutantsEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'mutation-refused');
    return verdict;
  }

  scoreMutants(input: MutationScoreInput): MutationScoreResult {
    const verdict = scoreMutantsEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'mutation-refused');
    return verdict;
  }

  buildPact(input: BuildPactInput): PactResult {
    const verdict = buildPactEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'contract-refused');
    return verdict;
  }

  verifyContract(input: VerifyContractInput): PactResult {
    const verdict = verifyContractEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'contract-refused');
    return verdict;
  }

  diffImages(input: VisualDiffInput): VisualDiffResult {
    const verdict = diffImagesEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'visual-refused');
    return verdict;
  }

  planMatrix(input: MatrixPlanInput): MatrixPlanResult {
    const verdict = planMatrixEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'matrix-refused');
    return verdict;
  }

  scoreMatrix(input: MatrixScoreInput): MatrixScoreResult {
    const verdict = scoreMatrixEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'matrix-refused');
    return verdict;
  }

  async writeGolden(userId: string, name: unknown, value: unknown): Promise<GoldenSummary> {
    const existing = typeof name === 'string' ? await this.goldens.find(userId, name) : null;
    const verdict = manageSnapshotEngine({ name, mode: 'write', value, stored: existing ? existing.content : undefined });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'snapshot-refused');
    const saved = await this.goldens.create({
      userId,
      name: verdict.name ?? '',
      checksum: verdict.checksum ?? '',
      content: verdict.serialized ?? '',
      now: this.clock(),
    });
    const lines = verdict.lines ?? 0;
    await this.events.append({
      type: TestQualityEvents.GoldenWritten,
      version: TEST_QUALITY_EVENT_VERSION,
      actor: { kind: 'user', id: userId },
      subject: { type: 'test_quality_golden', id: saved.id },
      payload: { name: saved.name, checksum: saved.checksum, lines },
    });
    return { id: saved.id, name: saved.name, checksum: saved.checksum, lines };
  }

  async verifyGolden(userId: string, name: unknown, value: unknown): Promise<GoldenVerification> {
    const existing = typeof name === 'string' ? await this.goldens.find(userId, name) : null;
    const verdict = manageSnapshotEngine({ name, mode: 'verify', value, stored: existing ? existing.content : undefined });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'snapshot-refused');
    return {
      name: verdict.name ?? '',
      status: verdict.status ?? 'match',
      checksum: verdict.checksum ?? '',
      lines: verdict.lines ?? 0,
    };
  }

  async updateGolden(userId: string, name: unknown, value: unknown): Promise<GoldenSummary> {
    const existing = typeof name === 'string' ? await this.goldens.find(userId, name) : null;
    const verdict = manageSnapshotEngine({ name, mode: 'update', value, stored: existing ? existing.content : undefined });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'snapshot-refused');
    if (!existing) throw refusal('snapshot-missing:' + String(name));
    const updated = await this.goldens.updateContent(
      existing.id,
      { checksum: verdict.checksum ?? '', content: verdict.serialized ?? '' },
      this.clock(),
    );
    const lines = verdict.lines ?? 0;
    await this.events.append({
      type: TestQualityEvents.GoldenUpdated,
      version: TEST_QUALITY_EVENT_VERSION,
      actor: { kind: 'user', id: userId },
      subject: { type: 'test_quality_golden', id: updated.id },
      payload: { name: updated.name, checksum: updated.checksum, lines },
    });
    return { id: updated.id, name: updated.name, checksum: updated.checksum, lines };
  }

  async listGoldens(userId: string): Promise<GoldenListItem[]> {
    const rows = await this.goldens.listByUser(userId, 50);
    return rows.map((r) => ({ id: r.id, name: r.name, checksum: r.checksum, createdAt: r.createdAt }));
  }
}
