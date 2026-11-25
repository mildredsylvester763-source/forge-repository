import { randomUUID } from 'node:crypto';

export interface OrchestratorPlanRecord {
  readonly id: string;
  readonly userId: string;
  readonly goal: string;
  readonly intent: string;
  readonly risk: string;
  readonly estimatedCost: number;
  readonly requiresApproval: boolean;
  readonly steps: unknown[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewOrchestratorPlan {
  userId: string;
  goal: string;
  intent: string;
  risk: string;
  estimatedCost: number;
  requiresApproval: boolean;
  steps: unknown[];
  now: number;
}

export interface OrchestratorPlanPatch {
  intent: string;
  risk: string;
  estimatedCost: number;
  requiresApproval: boolean;
  steps: unknown[];
}

export interface OrchestratorPlanStore {
  create(plan: NewOrchestratorPlan): Promise<OrchestratorPlanRecord>;
  findById(id: string): Promise<OrchestratorPlanRecord | null>;
  update(id: string, patch: OrchestratorPlanPatch, now: number): Promise<OrchestratorPlanRecord>;
  listByUser(userId: string, take: number): Promise<OrchestratorPlanRecord[]>;
}

/** Development and test store. SQLite and PostgreSQL adapters sit behind the same interface. */
export class InMemoryOrchestratorPlanStore implements OrchestratorPlanStore {
  private readonly byId = new Map<string, OrchestratorPlanRecord>();
  private readonly byUser = new Map<string, string[]>();

  async create(plan: NewOrchestratorPlan): Promise<OrchestratorPlanRecord> {
    const record: OrchestratorPlanRecord = {
      id: randomUUID(),
      userId: plan.userId,
      goal: plan.goal,
      intent: plan.intent,
      risk: plan.risk,
      estimatedCost: plan.estimatedCost,
      requiresApproval: plan.requiresApproval,
      steps: plan.steps,
      createdAt: plan.now,
      updatedAt: plan.now,
    };
    this.byId.set(record.id, record);
    const ids = this.byUser.get(plan.userId) ?? [];
    ids.unshift(record.id);
    this.byUser.set(plan.userId, ids);
    return record;
  }

  async findById(id: string): Promise<OrchestratorPlanRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async update(id: string, patch: OrchestratorPlanPatch, now: number): Promise<OrchestratorPlanRecord> {
    const current = this.byId.get(id);
    if (!current) throw new Error('orchestrator plan not found');
    const next: OrchestratorPlanRecord = { ...current, intent: patch.intent, risk: patch.risk, estimatedCost: patch.estimatedCost, requiresApproval: patch.requiresApproval, steps: patch.steps, updatedAt: now };
    this.byId.set(id, next);
    return next;
  }

  async listByUser(userId: string, take: number): Promise<OrchestratorPlanRecord[]> {
    const ids = this.byUser.get(userId) ?? [];
    const out: OrchestratorPlanRecord[] = [];
    for (const id of ids.slice(0, take)) {
      const plan = this.byId.get(id);
      if (plan) out.push(plan);
    }
    return out;
  }
}
