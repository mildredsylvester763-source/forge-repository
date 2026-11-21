import type { ForgeConfig } from '../../config.ts';
import { SAFETY_CATALOG, type SafetyCatalogItem } from './safety-catalog.ts';

export const SAFETY_TEXT_FEATURE_ID = 'safety.text';

export interface SafetyDescriptionReadabilityEvaluator {
  /** Return a score in the evaluator's declared grade-level scale; implementations are replaceable. */
  scoreReadingGrade(text: string): Promise<number>;
}

export interface SafetyDescriptionGrade {
  readonly id: SafetyCatalogItem['id'];
  readonly label: string;
  readonly score: number;
}

export interface SafetyReadabilityReport {
  readonly threshold: number | null;
  readonly thresholdConfigured: boolean;
  readonly passed: boolean | null;
  readonly unconfigured: readonly SafetyCatalogItem['id'][];
  readonly aboveThreshold: readonly SafetyDescriptionGrade[];
  readonly grades: readonly SafetyDescriptionGrade[];
}

export type SafetyReadabilityResult =
  | { readonly ok: true; readonly report: SafetyReadabilityReport }
  | { readonly ok: false; readonly reason: 'catalog_invalid' | 'evaluator_unavailable' | 'evaluator_invalid_score' };

/** Backend TS-796 build-check service; threshold and scoring method are supplied, never invented here. */
export class SafetyReadabilityService {
  private readonly evaluator: SafetyDescriptionReadabilityEvaluator;
  private readonly threshold: ForgeConfig['safety']['maxDescriptionReadingGrade'];
  private readonly catalog: readonly SafetyCatalogItem[];

  constructor(input: {
    readonly evaluator: SafetyDescriptionReadabilityEvaluator;
    readonly settings: Pick<ForgeConfig['safety'], 'maxDescriptionReadingGrade'>;
    readonly catalog?: readonly SafetyCatalogItem[];
  }) {
    this.evaluator = input.evaluator;
    this.threshold = input.settings.maxDescriptionReadingGrade;
    this.catalog = input.catalog ?? SAFETY_CATALOG;
  }

  async checkCatalog(): Promise<SafetyReadabilityResult> {
    if (!hasCompleteCatalog(this.catalog)) return { ok: false, reason: 'catalog_invalid' };
    const grades: SafetyDescriptionGrade[] = [];
    for (const item of this.catalog) {
      let score: number;
      try {
        score = await this.evaluator.scoreReadingGrade(item.description);
      } catch {
        return { ok: false, reason: 'evaluator_unavailable' };
      }
      if (!Number.isFinite(score) || score < 0) return { ok: false, reason: 'evaluator_invalid_score' };
      grades.push(Object.freeze({ id: item.id, label: item.label, score }));
    }
    const threshold = this.threshold;
    const aboveThreshold = threshold === null ? [] : grades.filter((grade) => grade.score > threshold);
    const unconfigured = threshold === null ? Object.freeze(this.catalog.map((item) => item.id)) : Object.freeze([]);
    const report: SafetyReadabilityReport = Object.freeze({
      threshold,
      thresholdConfigured: threshold !== null,
      passed: threshold === null ? null : aboveThreshold.length === 0,
      unconfigured,
      aboveThreshold: Object.freeze(aboveThreshold),
      grades: Object.freeze(grades),
    });
    return Object.freeze({ ok: true, report });
  }
}

function hasCompleteCatalog(catalog: readonly SafetyCatalogItem[]): boolean {
  if (!Array.isArray(catalog) || catalog.length !== SAFETY_CATALOG.length) return false;
  const expected = new Set(SAFETY_CATALOG.map((item) => item.id));
  const seen = new Set<string>();
  for (const item of catalog) {
    if (typeof item !== 'object' || item === null || !expected.has(item.id) || seen.has(item.id) ||
        typeof item.label !== 'string' || item.label.trim().length === 0 ||
        typeof item.description !== 'string' || item.description.trim().length === 0) return false;
    seen.add(item.id);
  }
  return seen.size === expected.size;
}
