import { randomUUID } from 'node:crypto';

export interface GoldenRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly checksum: string;
  readonly content: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewGolden {
  userId: string;
  name: string;
  checksum: string;
  content: string;
  now: number;
}

export interface GoldenContentPatch {
  checksum: string;
  content: string;
}

export interface TestQualityGoldenStore {
  create(golden: NewGolden): Promise<GoldenRecord>;
  find(userId: string, name: string): Promise<GoldenRecord | null>;
  updateContent(id: string, patch: GoldenContentPatch, now: number): Promise<GoldenRecord>;
  listByUser(userId: string, take: number): Promise<GoldenRecord[]>;
}

/** Development and test store. SQLite and PostgreSQL adapters sit behind the same interface. */
export class InMemoryGoldenStore implements TestQualityGoldenStore {
  private readonly byId = new Map<string, GoldenRecord>();
  private readonly byUser = new Map<string, string[]>();

  async create(golden: NewGolden): Promise<GoldenRecord> {
    const record: GoldenRecord = {
      id: randomUUID(),
      userId: golden.userId,
      name: golden.name,
      checksum: golden.checksum,
      content: golden.content,
      createdAt: golden.now,
      updatedAt: golden.now,
    };
    this.byId.set(record.id, record);
    const ids = this.byUser.get(golden.userId) ?? [];
    ids.unshift(record.id);
    this.byUser.set(golden.userId, ids);
    return record;
  }

  async find(userId: string, name: string): Promise<GoldenRecord | null> {
    const ids = this.byUser.get(userId) ?? [];
    for (const id of ids) {
      const row = this.byId.get(id);
      if (row && row.name === name) return row;
    }
    return null;
  }

  async updateContent(id: string, patch: GoldenContentPatch, now: number): Promise<GoldenRecord> {
    const current = this.byId.get(id);
    if (!current) throw new Error('golden not found');
    const next: GoldenRecord = { ...current, checksum: patch.checksum, content: patch.content, updatedAt: now };
    this.byId.set(id, next);
    return next;
  }

  async listByUser(userId: string, take: number): Promise<GoldenRecord[]> {
    const ids = this.byUser.get(userId) ?? [];
    const out: GoldenRecord[] = [];
    for (const id of ids.slice(0, take)) {
      const row = this.byId.get(id);
      if (row) out.push(row);
    }
    return out;
  }
}
