import type { Migration } from '../../kernel/migration-types.ts';
import { migrate as migrateSqlite, type Database } from '../../kernel/sqlite.ts';
import { migratePostgres } from '../../kernel/postgres-migrate.ts';
import type { SqlPool } from '../../kernel/sql.ts';
import { canUse, PLAN_LADDER, type CanUseResult, type FeatureId, type Plan } from './engine/feature-gates.ts';

export interface PlanStore {
  get(userId: string): Promise<Plan | null>;
  set(userId: string, plan: Plan): Promise<void>;
}

function requireUserId(userId: string): void {
  if (!userId.trim() || userId.length > 128) throw new TypeError('userId is required');
}

function isPlan(value: string): value is Plan {
  return (PLAN_LADDER as readonly string[]).includes(value);
}

export class InMemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, Plan>();
  async get(userId: string): Promise<Plan | null> {
    requireUserId(userId);
    return this.plans.get(userId) ?? null;
  }
  async set(userId: string, plan: Plan): Promise<void> {
    requireUserId(userId);
    this.plans.set(userId, plan);
  }
}

export const plansSqliteMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'user_base_plans',
    sql: `
      CREATE TABLE user_plans (
        user_id TEXT PRIMARY KEY,
        plan TEXT NOT NULL CHECK (plan IN ('free', 'plus', 'pro', 'team', 'enterprise')),
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
];

export function migratePlansSqlite(db: Database): number[] {
  return migrateSqlite(db, 'plans', plansSqliteMigrations);
}

export class SqlitePlanStore implements PlanStore {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }
  async get(userId: string): Promise<Plan | null> {
    requireUserId(userId);
    const row = this.db.prepare('SELECT plan FROM user_plans WHERE user_id = ?').get(userId) as { plan: string } | undefined;
    return row && isPlan(row.plan) ? row.plan : null;
  }
  async set(userId: string, plan: Plan): Promise<void> {
    requireUserId(userId);
    this.db.prepare(`INSERT INTO user_plans (user_id, plan, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET plan = excluded.plan, updated_at = excluded.updated_at`)
      .run(userId, plan, new Date().toISOString());
  }
}

export const plansPostgresMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'user_base_plans',
    sql: `
      CREATE TABLE user_plans (
        user_id TEXT PRIMARY KEY,
        plan TEXT NOT NULL CHECK (plan IN ('free', 'plus', 'pro', 'team', 'enterprise')),
        updated_at TEXT NOT NULL
      );
    `,
  },
];

export function migratePlansPostgres(pool: SqlPool): Promise<number[]> {
  return migratePostgres(pool, 'plans', plansPostgresMigrations);
}

export class PostgresPlanStore implements PlanStore {
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }
  async get(userId: string): Promise<Plan | null> {
    requireUserId(userId);
    const result = await this.pool.query<{ plan: string }>('SELECT plan FROM user_plans WHERE user_id = $1', [userId]);
    const plan = result.rows[0]?.plan;
    return plan !== undefined && isPlan(plan) ? plan : null;
  }
  async set(userId: string, plan: Plan): Promise<void> {
    requireUserId(userId);
    await this.pool.query(
      `INSERT INTO user_plans (user_id, plan, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, updated_at = EXCLUDED.updated_at`,
      [userId, plan, new Date().toISOString()],
    );
  }
}

/**
 * One base plan per user, defaulting to free. The gate question is always canUse;
 * balances, credits and passes belong to the billing work, not here.
 */
export class PlansService {
  private readonly store: PlanStore;
  constructor(options: { store: PlanStore }) { this.store = options.store; }
  async planFor(userId: string): Promise<Plan> {
    requireUserId(userId);
    return (await this.store.get(userId)) ?? 'free';
  }
  async setPlan(userId: string, plan: Plan): Promise<Plan> {
    requireUserId(userId);
    if (!isPlan(plan)) throw new TypeError('unknown plan: ' + String(plan));
    await this.store.set(userId, plan);
    return plan;
  }
  async canUse(userId: string, feature: FeatureId): Promise<CanUseResult> {
    const plan = await this.planFor(userId);
    return canUse(plan, feature);
  }
}
