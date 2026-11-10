import type { SqlPool } from '../../kernel/sql.ts';
import type { PlanId, PlanRecord } from './engine/plan-engine.ts';
import type { PlanStore, PlanUpsert } from './plans-store.ts';

interface PlanRow {
  user_id: string;
  plan: string;
  engine_passes: unknown;
  created_at: string | number;
  updated_at: string | number;
}

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value));

const toRecord = (r: PlanRow): PlanRecord => ({
  userId: r.user_id,
  plan: r.plan as PlanId,
  enginePasses: Array.isArray(r.engine_passes) ? (r.engine_passes as string[]) : [],
  updatedAt: num(r.updated_at),
});

export class PostgresPlanStore implements PlanStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async findByUser(userId: string): Promise<PlanRecord | null> {
    const result = await this.pool.query<PlanRow>('SELECT * FROM user_plans WHERE user_id = $1', [userId]);
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async upsert(input: PlanUpsert): Promise<PlanRecord> {
    await this.pool.query(
      'INSERT INTO user_plans (user_id, plan, engine_passes, created_at, updated_at) VALUES ($1, $2, $3::jsonb, $4, $5) ' +
        'ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, engine_passes = EXCLUDED.engine_passes, updated_at = EXCLUDED.updated_at',
      [input.userId, input.plan, JSON.stringify(input.enginePasses), input.now, input.now],
    );
    const record = await this.findByUser(input.userId);
    if (!record) throw new Error('user plan upsert failed');
    return record;
  }
}
