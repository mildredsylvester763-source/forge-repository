import type { PlanId, PlanRecord } from './engine/plan-engine.ts';

export interface PlanUpsert {
  userId: string;
  plan: PlanId;
  enginePasses: readonly string[];
  now: number;
}

export interface PlanStore {
  findByUser(userId: string): Promise<PlanRecord | null>;
  upsert(input: PlanUpsert): Promise<PlanRecord>;
}

/** Development and test store. SQLite and PostgreSQL adapters sit behind the same interface. */
export class InMemoryPlanStore implements PlanStore {
  private readonly byUser = new Map<string, PlanRecord>();

  async findByUser(userId: string): Promise<PlanRecord | null> {
    return this.byUser.get(userId) ?? null;
  }

  async upsert(input: PlanUpsert): Promise<PlanRecord> {
    const record: PlanRecord = {
      userId: input.userId,
      plan: input.plan,
      enginePasses: [...input.enginePasses],
      updatedAt: input.now,
    };
    this.byUser.set(input.userId, record);
    return record;
  }
}
