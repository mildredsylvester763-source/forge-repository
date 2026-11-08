import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { PlanId, PlanRecord } from './engine/plan-engine.ts';
import type { PlanStore, PlanUpsert } from './plans-store.ts';

interface PlanRow {
  user_id: string;
  plan: string;
  engine_passes: string;
  created_at: number;
  updated_at: number;
}

const toRecord = (r: PlanRow): PlanRecord => ({
  userId: r.user_id,
  plan: r.plan as PlanId,
  enginePasses: JSON.parse(r.engine_passes) as string[],
  updatedAt: r.updated_at,
});

export class SqlitePlanStore implements PlanStore {
  private readonly db: Database;
  private readonly upsertStmt;
  private readonly byUser;

  constructor(db: Database) {
    this.db = db;
    this.upsertStmt = db.prepare(
      'INSERT INTO user_plans (user_id, plan, engine_passes, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, engine_passes = excluded.engine_passes, updated_at = excluded.updated_at',
    );
    this.byUser = db.prepare('SELECT * FROM user_plans WHERE user_id = ?');
  }

  async findByUser(userId: string): Promise<PlanRecord | null> {
    const row = this.byUser.get(userId) as unknown as PlanRow | undefined;
    return row ? toRecord(row) : null;
  }

  async upsert(input: PlanUpsert): Promise<PlanRecord> {
    return transaction(this.db, () => {
      this.upsertStmt.run(input.userId, input.plan, JSON.stringify(input.enginePasses), input.now, input.now);
      const row = this.byUser.get(input.userId) as unknown as PlanRow | undefined;
      if (!row) throw new Error('user plan upsert failed');
      return toRecord(row);
    });
  }
}
