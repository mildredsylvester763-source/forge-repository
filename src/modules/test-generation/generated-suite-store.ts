import { randomUUID } from 'node:crypto';

export interface GeneratedSuiteRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: string;
  readonly target: string;
  readonly seed: number;
  readonly checksum: string;
  readonly cases: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewGeneratedSuite {
  userId: string;
  kind: string;
  target: string;
  seed: number;
  checksum: string;
  cases: unknown;
  now: number;
}

export interface GeneratedSuiteStore {
  create(suite: NewGeneratedSuite): Promise<GeneratedSuiteRecord>;
  find(userId: string, id: string): Promise<GeneratedSuiteRecord | null>;
  listByUser(userId: string, take: number): Promise<GeneratedSuiteRecord[]>;
}

/** Development and test store. SQLite and PostgreSQL adapters sit behind the same interface. */
export class InMemoryGeneratedSuiteStore implements GeneratedSuiteStore {
  private readonly byId = new Map<string, GeneratedSuiteRecord>();
  private readonly byUser = new Map<string, string[]>();

  async create(suite: NewGeneratedSuite): Promise<GeneratedSuiteRecord> {
    const record: GeneratedSuiteRecord = {
      id: randomUUID(),
      userId: suite.userId,
      kind: suite.kind,
      target: suite.target,
      seed: suite.seed,
      checksum: suite.checksum,
      cases: suite.cases,
      createdAt: suite.now,
      updatedAt: suite.now,
    };
    this.byId.set(record.id, record);
    const ids = this.byUser.get(suite.userId) ?? [];
    ids.unshift(record.id);
    this.byUser.set(suite.userId, ids);
    return record;
  }

  async find(userId: string, id: string): Promise<GeneratedSuiteRecord | null> {
    const row = this.byId.get(id);
    return row && row.userId === userId ? row : null;
  }

  async listByUser(userId: string, take: number): Promise<GeneratedSuiteRecord[]> {
    const ids = this.byUser.get(userId) ?? [];
    const out: GeneratedSuiteRecord[] = [];
    for (const id of ids.slice(0, take)) {
      const row = this.byId.get(id);
      if (row) out.push(row);
    }
    return out;
  }
}
