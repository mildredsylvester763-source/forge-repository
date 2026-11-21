export const SAFETY_CLASSIFIER_GOVERNANCE_FEATURE_ID = 'TS-798';

export interface SafetyClassifierRegistration {
  readonly classifierId: string;
  readonly modelId: string;
  readonly version: number;
  readonly fingerprint: string;
}
export interface SafetyClassifierEvaluation {
  readonly classifierId: string;
  readonly modelId: string;
  readonly version: number;
  readonly releaseAllowed: boolean;
  readonly report: unknown;
}
export interface SafetyClassifierRollbackPlan {
  readonly modelId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly instant: boolean;
  readonly fingerprint: string;
  readonly servedVersionsAfter: readonly string[];
}
export interface SafetyClassifierGovernanceRun {
  readonly evaluation: SafetyClassifierEvaluation;
  readonly rollbackPlan: SafetyClassifierRollbackPlan | null;
}

/** Adapter over the existing AI-033 model registry; implementations must not create a parallel registry. */
export interface SafetyClassifierRegistry {
  registerVersion(actorId: string, input: unknown): Promise<unknown>;
  hasVersion(actorId: string, classifierId: string, modelId: string, version: number): Promise<boolean>;
  rollbackContext(actorId: string, modelId: string, version: number): Promise<unknown | null>;
}
/** Adapter that runs the existing TS-794 safety evaluation harness for this exact classifier version. */
export interface SafetyClassifierEvaluator {
  evaluate(actorId: string, classifierId: string, modelId: string, version: number, input: unknown): Promise<unknown>;
}
/** Adapter over the existing AI-044 rollback planner; this contract plans but does not activate a serving switch. */
export interface SafetyClassifierRollbackPlanner {
  plan(actorId: string, input: { readonly modelId: string; readonly currentVersion: string; readonly targetVersion: string; readonly servedVersions: readonly string[] }): Promise<unknown>;
}
export interface SafetyClassifierGovernanceAccess {
  canUse(actorId: string, featureId: string): Promise<{ readonly allowed: boolean }>;
}
export type SafetyClassifierGovernanceFailure =
  | 'actor_invalid'
  | 'feature_unavailable'
  | 'authorization_unavailable'
  | 'input_invalid'
  | 'registry_unavailable'
  | 'classifier_version_unavailable'
  | 'evaluation_unavailable'
  | 'evaluation_invalid'
  | 'rollback_context_unavailable'
  | 'rollback_unavailable'
  | 'rollback_plan_invalid';
export type SafetyClassifierGovernanceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SafetyClassifierGovernanceFailure };

/** TS-798 orchestration only: registry, evaluation and rollback logic remain owned by existing Forge services. */
export class SafetyClassifierGovernanceService {
  private readonly access: SafetyClassifierGovernanceAccess;
  private readonly registry: SafetyClassifierRegistry;
  private readonly evaluator: SafetyClassifierEvaluator;
  private readonly rollback: SafetyClassifierRollbackPlanner;

  constructor(input: {
    readonly access: SafetyClassifierGovernanceAccess;
    readonly registry: SafetyClassifierRegistry;
    readonly evaluator: SafetyClassifierEvaluator;
    readonly rollback: SafetyClassifierRollbackPlanner;
  }) {
    this.access = input.access;
    this.registry = input.registry;
    this.evaluator = input.evaluator;
    this.rollback = input.rollback;
  }

  async register(actorId: string, input: unknown): Promise<SafetyClassifierGovernanceResult<SafetyClassifierRegistration>> {
    const authorized = await this.authorize(actorId);
    if (!authorized.ok) return authorized;
    if (!isRecord(input) || !isId(input.classifierId) || !isId(input.modelId) || !Number.isSafeInteger(input.version) || (input.version as number) < 1) {
      return { ok: false, reason: 'input_invalid' };
    }
    try {
      const raw = await this.registry.registerVersion(actorId, input);
      if (!isRecord(raw) || raw.classifierId !== input.classifierId || raw.modelId !== input.modelId || raw.version !== input.version || !isId(raw.fingerprint)) {
        return { ok: false, reason: 'registry_unavailable' };
      }
      return { ok: true, value: Object.freeze({ classifierId: raw.classifierId, modelId: raw.modelId, version: raw.version as number, fingerprint: raw.fingerprint }) };
    } catch {
      return { ok: false, reason: 'registry_unavailable' };
    }
  }

  async evaluate(actorId: string, input: unknown): Promise<SafetyClassifierGovernanceResult<SafetyClassifierEvaluation>> {
    const authorized = await this.authorize(actorId);
    if (!authorized.ok) return authorized;
    if (!isEvaluationInput(input)) return { ok: false, reason: 'input_invalid' };
    let exists: boolean;
    try {
      exists = await this.registry.hasVersion(actorId, input.classifierId, input.modelId, input.version);
    } catch {
      return { ok: false, reason: 'registry_unavailable' };
    }
    if (!exists) return { ok: false, reason: 'classifier_version_unavailable' };
    let raw: unknown;
    try {
      raw = await this.evaluator.evaluate(actorId, input.classifierId, input.modelId, input.version, input.evaluationInput);
    } catch {
      return { ok: false, reason: 'evaluation_unavailable' };
    }
    if (!isRecord(raw) || typeof raw.releaseAllowed !== 'boolean' || !('report' in raw)) {
      return { ok: false, reason: 'evaluation_invalid' };
    }
    return {
      ok: true,
      value: Object.freeze({
        classifierId: input.classifierId,
        modelId: input.modelId,
        version: input.version,
        releaseAllowed: raw.releaseAllowed,
        report: raw.report,
      }),
    };
  }

  async evaluateAndPlanRollback(actorId: string, input: unknown): Promise<SafetyClassifierGovernanceResult<SafetyClassifierGovernanceRun>> {
    const evaluated = await this.evaluate(actorId, input);
    if (!evaluated.ok) return evaluated;
    if (evaluated.value.releaseAllowed) {
      return { ok: true, value: Object.freeze({ evaluation: evaluated.value, rollbackPlan: null }) };
    }
    let context: unknown | null;
    try {
      context = await this.registry.rollbackContext(actorId, evaluated.value.modelId, evaluated.value.version);
    } catch {
      return { ok: false, reason: 'rollback_context_unavailable' };
    }
    if (!isRollbackContext(context)) return { ok: false, reason: 'rollback_context_unavailable' };
    let raw: unknown;
    try {
      raw = await this.rollback.plan(actorId, context);
    } catch {
      return { ok: false, reason: 'rollback_unavailable' };
    }
    if (!isRollbackPlan(raw, context.modelId)) return { ok: false, reason: 'rollback_plan_invalid' };
    return {
      ok: true,
      value: Object.freeze({
        evaluation: evaluated.value,
        rollbackPlan: Object.freeze({ ...raw, servedVersionsAfter: Object.freeze([...raw.servedVersionsAfter]) }),
      }),
    };
  }

  private async authorize(actorId: string): Promise<SafetyClassifierGovernanceResult<null>> {
    if (!isId(actorId)) return { ok: false, reason: 'actor_invalid' };
    try {
      if ((await this.access.canUse(actorId, SAFETY_CLASSIFIER_GOVERNANCE_FEATURE_ID)).allowed !== true) {
        return { ok: false, reason: 'feature_unavailable' };
      }
      return { ok: true, value: null };
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
  }
}

function isEvaluationInput(value: unknown): value is { classifierId: string; modelId: string; version: number; evaluationInput: unknown } {
  return isRecord(value) && isId(value.classifierId) && isId(value.modelId) && Number.isSafeInteger(value.version) &&
    (value.version as number) > 0 && Object.prototype.hasOwnProperty.call(value, 'evaluationInput') &&
    Object.keys(value).every((key) => ['classifierId', 'modelId', 'version', 'evaluationInput'].includes(key));
}
function isRollbackContext(value: unknown): value is { modelId: string; currentVersion: string; targetVersion: string; servedVersions: readonly string[] } {
  return isRecord(value) && isId(value.modelId) && isId(value.currentVersion) && isId(value.targetVersion) &&
    Array.isArray(value.servedVersions) && value.servedVersions.every(isId) &&
    Object.keys(value).every((key) => ['modelId', 'currentVersion', 'targetVersion', 'servedVersions'].includes(key));
}
function isRollbackPlan(value: unknown, expectedModelId: string): value is SafetyClassifierRollbackPlan {
  return isRecord(value) && value.modelId === expectedModelId && isId(value.fromVersion) && isId(value.toVersion) &&
    typeof value.instant === 'boolean' && isId(value.fingerprint) && Array.isArray(value.servedVersionsAfter) &&
    value.servedVersionsAfter.every(isId) && Object.keys(value).every((key) => ['modelId', 'fromVersion', 'toVersion', 'instant', 'fingerprint', 'servedVersionsAfter'].includes(key));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
