import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../../kernel/sql.ts';
import type { NewOrchestratorPlan, OrchestratorPlanPatch, OrchestratorPlanRecord, OrchestratorPlanStore } from './orchestrator-plan-store.ts';

interface OrchestratorPlanRow {
  id: string;
  user_id: string;
  goal: string;
  intent: string;
  risk: string;
  estimated_cost: string | number;
  requires_approval: boolean | number | string;
  steps: unknown;
  created_at: string | number;
  updated_at: string | number;
}

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value));
const flag = (value: boolean | number | string): boolean => value === true || value === 1 || value === 't';

const toRecord = (r: OrchestratorPlanRow): OrchestratorPlanRecord => ({
  id: r.id,
  userId: r.user_id,
  goal: r.goal,
  intent: r.intent,
  risk: r.risk,
  estimatedCost: num(r.estimated_cost),
  requiresApproval: flag(r.requires_approval),
  steps: Array.isArray(r.steps) ? (r.steps as unknown[]) : [],
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

export class PostgresOrchestratorPlanStore implements OrchestratorPlanStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async create(plan: NewOrchestratorPlan): Promise<OrchestratorPlanRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO orchestrator_plans (id, user_id, goal, intent, risk, estimated_cost, requires_approval, steps, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)',
      [id, plan.userId, plan.goal, plan.intent, plan.risk, plan.estimatedCost, plan.requiresApproval, JSON.stringify(plan.steps), plan.now, plan.now],
    );
    return { id, userId: plan.userId, goal: plan.goal, intent: plan.intent, risk: plan.risk, estimatedCost: plan.estimatedCost, requiresApproval: plan.requiresApproval, steps: plan.steps, createdAt: plan.now, updatedAt: plan.now };
  }

  async findById(id: string): Promise<OrchestratorPlanRecord | null> {
    const result = await this.pool.query<OrchestratorPlanRow>('SELECT * FROM orchestrator_plans WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async update(id: string, patch: OrchestratorPlanPatch, now: number): Promise<OrchestratorPlanRecord> {
    await this.pool.query('UPDATE orchestrator_plans SET intent = $1, risk = $2, estimated_cost = $3, requires_approval = $4, steps = $5::jsonb, updated_at = $6 WHERE id = $7', [
      patch.intent,
      patch.risk,
      patch.estimatedCost,
      patch.requiresApproval,
      JSON.stringify(patch.steps),
      now,
      id,
    ]);
    const plan = await this.findById(id);
    if (!plan) throw new Error('orchestrator plan not found');
    return plan;
  }

  async listByUser(userId: string, take: number): Promise<OrchestratorPlanRecord[]> {
    const result = await this.pool.query<OrchestratorPlanRow>('SELECT * FROM orchestrator_plans WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, take]);
    return result.rows.map(toRecord);
  }
}
