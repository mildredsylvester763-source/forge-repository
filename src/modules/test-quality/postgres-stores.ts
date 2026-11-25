import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../../kernel/sql.ts';
import type { GoldenContentPatch, GoldenRecord, NewGolden, TestQualityGoldenStore } from './golden-store.ts';

interface GoldenRow {
  id: string;
  user_id: string;
  name: string;
  checksum: string;
  content: string;
  created_at: string | number;
  updated_at: string | number;
}

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value));

const toRecord = (r: GoldenRow): GoldenRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  checksum: r.checksum,
  content: r.content,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

export class PostgresGoldenStore implements TestQualityGoldenStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async create(golden: NewGolden): Promise<GoldenRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO test_quality_goldens (id, user_id, name, checksum, content, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, golden.userId, golden.name, golden.checksum, golden.content, golden.now, golden.now],
    );
    return { id, userId: golden.userId, name: golden.name, checksum: golden.checksum, content: golden.content, createdAt: golden.now, updatedAt: golden.now };
  }

  async find(userId: string, name: string): Promise<GoldenRecord | null> {
    const result = await this.pool.query<GoldenRow>(
      'SELECT * FROM test_quality_goldens WHERE user_id = $1 AND name = $2 ORDER BY created_at DESC, id DESC LIMIT 1',
      [userId, name],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async updateContent(id: string, patch: GoldenContentPatch, now: number): Promise<GoldenRecord> {
    await this.pool.query('UPDATE test_quality_goldens SET checksum = $1, content = $2, updated_at = $3 WHERE id = $4', [
      patch.checksum,
      patch.content,
      now,
      id,
    ]);
    const result = await this.pool.query<GoldenRow>('SELECT * FROM test_quality_goldens WHERE id = $1', [id]);
    const row = result.rows[0];
    if (!row) throw new Error('golden not found');
    return toRecord(row);
  }

  async listByUser(userId: string, take: number): Promise<GoldenRecord[]> {
    const result = await this.pool.query<GoldenRow>(
      'SELECT * FROM test_quality_goldens WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [userId, take],
    );
    return result.rows.map(toRecord);
  }
}
