import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../../kernel/sql.ts';
import type { GeneratedSuiteRecord, GeneratedSuiteStore, NewGeneratedSuite } from './generated-suite-store.ts';

interface SuiteRow {
  id: string;
  user_id: string;
  kind: string;
  target: string;
  seed: string | number;
  checksum: string;
  cases: string;
  created_at: string | number;
  updated_at: string | number;
}

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value));

const toRecord = (r: SuiteRow): GeneratedSuiteRecord => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  target: r.target,
  seed: num(r.seed),
  checksum: r.checksum,
  cases: JSON.parse(r.cases) as unknown,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

export class PostgresGeneratedSuiteStore implements GeneratedSuiteStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async create(suite: NewGeneratedSuite): Promise<GeneratedSuiteRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO test_generation_suites (id, user_id, kind, target, seed, checksum, cases, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [id, suite.userId, suite.kind, suite.target, suite.seed, suite.checksum, JSON.stringify(suite.cases), suite.now, suite.now],
    );
    return { id, userId: suite.userId, kind: suite.kind, target: suite.target, seed: suite.seed, checksum: suite.checksum, cases: suite.cases, createdAt: suite.now, updatedAt: suite.now };
  }

  async find(userId: string, id: string): Promise<GeneratedSuiteRecord | null> {
    const result = await this.pool.query<SuiteRow>('SELECT * FROM test_generation_suites WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async listByUser(userId: string, take: number): Promise<GeneratedSuiteRecord[]> {
    const result = await this.pool.query<SuiteRow>(
      'SELECT * FROM test_generation_suites WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [userId, take],
    );
    return result.rows.map(toRecord);
  }
}
