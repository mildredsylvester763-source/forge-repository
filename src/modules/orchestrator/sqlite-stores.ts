import { randomUUID } from 'node:crypto';
import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { NewOrchestratorPlan, OrchestratorPlanPatch, OrchestratorPlanRecord, OrchestratorPlanStore } from './orchestrator-plan-store.ts';

interface OrchestratorPlanRow {
  id: string;
  user_id: string;
  goal: string;
  intent: string;
  risk: string;
  estimated_cost: number;
  requires_approval: number;
  steps: string;
  created_at: number;
  updated_at: number;
}

const toRecord = (r: OrchestratorPlanRow): OrchestratorPlanRecord => ({
  id: r.id,
  userId: r.user_id,
  goal: r.goal,
  intent: r.intent,
  risk: r.risk,
  estimatedCost: r.estimated_cost,
  requiresApproval: r.requires_approval === 1,
  steps: JSON.parse(r.steps) as unknown[],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SqliteOrchestratorPlanStore implements OrchestratorPlanStore {
  private readonly db: Database;
  private readonly insertStmt;
  private readonly byId;
  private readonly updateStmt;
  private readonly byUser;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare('INSERT INTO orchestrator_plans (id, user_id, goal, intent, risk, estimated_cost, requires_approval, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.byId = db.prepare('SELECT * FROM orchestrator_plans WHERE id = ?');
    this.updateStmt = db.prepare('UPDATE orchestrator_plans SET intent = ?, risk = ?, estimated_cost = ?, requires_approval = ?, steps = ?, updated_at = ? WHERE id = ?');
    this.byUser = db.prepare('SELECT * FROM orchestrator_plans WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
  }

  async create(plan: NewOrchestratorPlan): Promise<OrchestratorPlanRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertStmt.run(id, plan.userId, plan.goal, plan.intent, plan.risk, plan.estimatedCost, plan.requiresApproval ? 1 : 0, JSON.stringify(plan.steps), plan.now, plan.now);
      return { id, userId: plan.userId, goal: plan.goal, intent: plan.intent, risk: plan.risk, estimatedCost: plan.estimatedCost, requiresApproval: plan.requiresApproval, steps: plan.steps, createdAt: plan.now, updatedAt: plan.now };
    });
  }

  async findById(id: string): Promise<OrchestratorPlanRecord | null> {
    const row = this.byId.get(id) as unknown as OrchestratorPlanRow | undefined;
    return row ? toRecord(row) : null;
  }

  async update(id: string, patch: OrchestratorPlanPatch, now: number): Promise<OrchestratorPlanRecord> {
    return transaction(this.db, () => {
      const row = this.byId.get(id) as unknown as OrchestratorPlanRow | undefined;
      if (!row) throw new Error('orchestrator plan not found');
      this.updateStmt.run(patch.intent, patch.risk, patch.estimatedCost, patch.requiresApproval ? 1 : 0, JSON.stringify(patch.steps), now, id);
      return { ...toRecord(row), intent: patch.intent, risk: patch.risk, estimatedCost: patch.estimatedCost, requiresApproval: patch.requiresApproval, steps: patch.steps, updatedAt: now };
    });
  }

  async listByUser(userId: string, take: number): Promise<OrchestratorPlanRecord[]> {
    const rows = this.byUser.all(userId, take) as unknown as OrchestratorPlanRow[];
    return rows.map(toRecord);
  }
}
