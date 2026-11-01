import { randomUUID } from 'node:crypto';
import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { GeneratedSuiteRecord, GeneratedSuiteStore, NewGeneratedSuite } from './generated-suite-store.ts';

interface SuiteRow {
  id: string;
  user_id: string;
  kind: string;
  target: string;
  seed: number;
  checksum: string;
  cases: string;
  created_at: number;
  updated_at: number;
}

const toRecord = (r: SuiteRow): GeneratedSuiteRecord => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  target: r.target,
  seed: r.seed,
  checksum: r.checksum,
  cases: JSON.parse(r.cases) as unknown,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SqliteGeneratedSuiteStore implements GeneratedSuiteStore {
  private readonly db: Database;
  private readonly insertStmt;
  private readonly byUserAndId;
  private readonly byUser;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare('INSERT INTO test_generation_suites (id, user_id, kind, target, seed, checksum, cases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.byUserAndId = db.prepare('SELECT * FROM test_generation_suites WHERE user_id = ? AND id = ?');
    this.byUser = db.prepare('SELECT * FROM test_generation_suites WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
  }

  async create(suite: NewGeneratedSuite): Promise<GeneratedSuiteRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertStmt.run(id, suite.userId, suite.kind, suite.target, suite.seed, suite.checksum, JSON.stringify(suite.cases), suite.now, suite.now);
      return { id, userId: suite.userId, kind: suite.kind, target: suite.target, seed: suite.seed, checksum: suite.checksum, cases: suite.cases, createdAt: suite.now, updatedAt: suite.now };
    });
  }

  async find(userId: string, id: string): Promise<GeneratedSuiteRecord | null> {
    const row = this.byUserAndId.get(userId, id) as unknown as SuiteRow | undefined;
    return row ? toRecord(row) : null;
  }

  async listByUser(userId: string, take: number): Promise<GeneratedSuiteRecord[]> {
    const rows = this.byUser.all(userId, take) as unknown as SuiteRow[];
    return rows.map(toRecord);
  }
}
