import { randomUUID } from 'node:crypto';
import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { GoldenContentPatch, GoldenRecord, NewGolden, TestQualityGoldenStore } from './golden-store.ts';

interface GoldenRow {
  id: string;
  user_id: string;
  name: string;
  checksum: string;
  content: string;
  created_at: number;
  updated_at: number;
}

const toRecord = (r: GoldenRow): GoldenRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  checksum: r.checksum,
  content: r.content,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SqliteGoldenStore implements TestQualityGoldenStore {
  private readonly db: Database;
  private readonly insertStmt;
  private readonly byId;
  private readonly byUserAndName;
  private readonly updateStmt;
  private readonly byUser;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare('INSERT INTO test_quality_goldens (id, user_id, name, checksum, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.byId = db.prepare('SELECT * FROM test_quality_goldens WHERE id = ?');
    this.byUserAndName = db.prepare('SELECT * FROM test_quality_goldens WHERE user_id = ? AND name = ? ORDER BY created_at DESC, id DESC LIMIT 1');
    this.updateStmt = db.prepare('UPDATE test_quality_goldens SET checksum = ?, content = ?, updated_at = ? WHERE id = ?');
    this.byUser = db.prepare('SELECT * FROM test_quality_goldens WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
  }

  async create(golden: NewGolden): Promise<GoldenRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertStmt.run(id, golden.userId, golden.name, golden.checksum, golden.content, golden.now, golden.now);
      return { id, userId: golden.userId, name: golden.name, checksum: golden.checksum, content: golden.content, createdAt: golden.now, updatedAt: golden.now };
    });
  }

  async find(userId: string, name: string): Promise<GoldenRecord | null> {
    const row = this.byUserAndName.get(userId, name) as unknown as GoldenRow | undefined;
    return row ? toRecord(row) : null;
  }

  async updateContent(id: string, patch: GoldenContentPatch, now: number): Promise<GoldenRecord> {
    return transaction(this.db, () => {
      const row = this.byId.get(id) as unknown as GoldenRow | undefined;
      if (!row) throw new Error('golden not found');
      this.updateStmt.run(patch.checksum, patch.content, now, id);
      return { ...toRecord(row), checksum: patch.checksum, content: patch.content, updatedAt: now };
    });
  }

  async listByUser(userId: string, take: number): Promise<GoldenRecord[]> {
    const rows = this.byUser.all(userId, take) as unknown as GoldenRow[];
    return rows.map(toRecord);
  }
}
