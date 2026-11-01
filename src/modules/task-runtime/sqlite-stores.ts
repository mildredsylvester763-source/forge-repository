import { randomUUID } from 'node:crypto';
import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { NewTaskRun, TaskRunPatch, TaskRunRecord, TaskRunStore } from './task-run-store.ts';

interface TaskRunRow {
  id: string;
  user_id: string;
  goal: string;
  state: string;
  events: string;
  created_at: number;
  updated_at: number;
}

const toRecord = (r: TaskRunRow): TaskRunRecord => ({
  id: r.id,
  userId: r.user_id,
  goal: r.goal,
  state: r.state,
  events: JSON.parse(r.events) as unknown[],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SqliteTaskRunStore implements TaskRunStore {
  private readonly db: Database;
  private readonly insertStmt;
  private readonly byId;
  private readonly updateStmt;
  private readonly byUser;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare('INSERT INTO task_runs (id, user_id, goal, state, events, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.byId = db.prepare('SELECT * FROM task_runs WHERE id = ?');
    this.updateStmt = db.prepare('UPDATE task_runs SET state = ?, events = ?, updated_at = ? WHERE id = ?');
    this.byUser = db.prepare('SELECT * FROM task_runs WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?');
  }

  async create(run: NewTaskRun): Promise<TaskRunRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertStmt.run(id, run.userId, run.goal, run.state, JSON.stringify(run.events), run.now, run.now);
      return { id, userId: run.userId, goal: run.goal, state: run.state, events: run.events, createdAt: run.now, updatedAt: run.now };
    });
  }

  async findById(id: string): Promise<TaskRunRecord | null> {
    const row = this.byId.get(id) as unknown as TaskRunRow | undefined;
    return row ? toRecord(row) : null;
  }

  async update(id: string, patch: TaskRunPatch, now: number): Promise<TaskRunRecord> {
    return transaction(this.db, () => {
      const row = this.byId.get(id) as unknown as TaskRunRow | undefined;
      if (!row) throw new Error('task run not found');
      this.updateStmt.run(patch.state, JSON.stringify(patch.events), now, id);
      return { ...toRecord(row), state: patch.state, events: patch.events, updatedAt: now };
    });
  }

  async listByUser(userId: string, take: number): Promise<TaskRunRecord[]> {
    const rows = this.byUser.all(userId, take) as unknown as TaskRunRow[];
    return rows.map(toRecord);
  }
}
