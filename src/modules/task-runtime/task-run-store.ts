import { randomUUID } from 'node:crypto';

export interface TaskRunRecord {
  readonly id: string;
  readonly userId: string;
  readonly goal: string;
  readonly state: string;
  readonly events: unknown[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewTaskRun {
  userId: string;
  goal: string;
  state: string;
  events: unknown[];
  now: number;
}

export interface TaskRunPatch {
  state: string;
  events: unknown[];
}

export interface TaskRunStore {
  create(run: NewTaskRun): Promise<TaskRunRecord>;
  findById(id: string): Promise<TaskRunRecord | null>;
  update(id: string, patch: TaskRunPatch, now: number): Promise<TaskRunRecord>;
  listByUser(userId: string, take: number): Promise<TaskRunRecord[]>;
}

/** Development and test store. SQLite and PostgreSQL adapters sit behind the same interface. */
export class InMemoryTaskRunStore implements TaskRunStore {
  private readonly byId = new Map<string, TaskRunRecord>();
  private readonly byUser = new Map<string, string[]>();

  async create(run: NewTaskRun): Promise<TaskRunRecord> {
    const record: TaskRunRecord = {
      id: randomUUID(),
      userId: run.userId,
      goal: run.goal,
      state: run.state,
      events: run.events,
      createdAt: run.now,
      updatedAt: run.now,
    };
    this.byId.set(record.id, record);
    const ids = this.byUser.get(run.userId) ?? [];
    ids.unshift(record.id);
    this.byUser.set(run.userId, ids);
    return record;
  }

  async findById(id: string): Promise<TaskRunRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async update(id: string, patch: TaskRunPatch, now: number): Promise<TaskRunRecord> {
    const current = this.byId.get(id);
    if (!current) throw new Error('task run not found');
    const next: TaskRunRecord = { ...current, state: patch.state, events: patch.events, updatedAt: now };
    this.byId.set(id, next);
    return next;
  }

  async listByUser(userId: string, take: number): Promise<TaskRunRecord[]> {
    const ids = this.byUser.get(userId) ?? [];
    const out: TaskRunRecord[] = [];
    for (const id of ids.slice(0, take)) {
      const run = this.byId.get(id);
      if (run) out.push(run);
    }
    return out;
  }
}
