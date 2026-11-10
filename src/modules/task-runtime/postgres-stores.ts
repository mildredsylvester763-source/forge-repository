import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../../kernel/sql.ts';
import type { NewTaskRun, TaskRunPatch, TaskRunRecord, TaskRunStore } from './task-run-store.ts';

interface TaskRunRow {
  id: string;
  user_id: string;
  goal: string;
  state: string;
  events: unknown;
  created_at: string | number;
  updated_at: string | number;
}

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value));

const toRecord = (r: TaskRunRow): TaskRunRecord => ({
  id: r.id,
  userId: r.user_id,
  goal: r.goal,
  state: r.state,
  events: Array.isArray(r.events) ? (r.events as unknown[]) : [],
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

export class PostgresTaskRunStore implements TaskRunStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async create(run: NewTaskRun): Promise<TaskRunRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO task_runs (id, user_id, goal, state, events, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)',
      [id, run.userId, run.goal, run.state, JSON.stringify(run.events), run.now, run.now],
    );
    return { id, userId: run.userId, goal: run.goal, state: run.state, events: run.events, createdAt: run.now, updatedAt: run.now };
  }

  async findById(id: string): Promise<TaskRunRecord | null> {
    const result = await this.pool.query<TaskRunRow>('SELECT * FROM task_runs WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async update(id: string, patch: TaskRunPatch, now: number): Promise<TaskRunRecord> {
    await this.pool.query('UPDATE task_runs SET state = $1, events = $2::jsonb, updated_at = $3 WHERE id = $4', [
      patch.state,
      JSON.stringify(patch.events),
      now,
      id,
    ]);
    const run = await this.findById(id);
    if (!run) throw new Error('task run not found');
    return run;
  }

  async listByUser(userId: string, take: number): Promise<TaskRunRecord[]> {
    const result = await this.pool.query<TaskRunRow>('SELECT * FROM task_runs WHERE user_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2', [userId, take]);
    return result.rows.map(toRecord);
  }
}
