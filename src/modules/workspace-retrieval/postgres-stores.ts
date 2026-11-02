import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../../kernel/sql.ts';
import type {
  ContentItemRecord,
  NewContentItem,
  NewResearchReport,
  ResearchReportRecord,
  WorkspaceRetrievalStore,
} from './workspace-retrieval-store.ts';

interface ItemRow {
  id: string;
  user_id: string;
  source: string;
  title: string;
  body: string;
  links: string;
  created_at: string | number;
  updated_at: string | number;
}

interface ReportRow {
  id: string;
  user_id: string;
  topic: string;
  summary: string;
  findings: string;
  verified_count: string | number;
  unverified_count: string | number;
  open_questions: string;
  created_at: string | number;
}

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value));

const toItemRecord = (r: ItemRow): ContentItemRecord => ({
  id: r.id,
  userId: r.user_id,
  source: r.source,
  title: r.title,
  body: r.body,
  links: JSON.parse(r.links) as string[],
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toReportRecord = (r: ReportRow): ResearchReportRecord => ({
  id: r.id,
  userId: r.user_id,
  topic: r.topic,
  summary: r.summary,
  findings: JSON.parse(r.findings) as unknown,
  verifiedCount: num(r.verified_count),
  unverifiedCount: num(r.unverified_count),
  openQuestions: JSON.parse(r.open_questions) as unknown,
  createdAt: num(r.created_at),
});

export class PostgresWorkspaceRetrievalStore implements WorkspaceRetrievalStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async createItem(item: NewContentItem): Promise<ContentItemRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO workspace_content_items (id, user_id, source, title, body, links, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, item.userId, item.source, item.title, item.body, JSON.stringify(item.links), item.now, item.now],
    );
    return { id, userId: item.userId, source: item.source, title: item.title, body: item.body, links: item.links, createdAt: item.now, updatedAt: item.now };
  }

  async listItemsByUser(userId: string, take: number): Promise<ContentItemRecord[]> {
    const result = await this.pool.query<ItemRow>(
      'SELECT * FROM workspace_content_items WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [userId, take],
    );
    return result.rows.map(toItemRecord);
  }

  async listIdsByUser(userId: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>('SELECT id FROM workspace_content_items WHERE user_id = $1', [userId]);
    return result.rows.map((r) => r.id);
  }

  async createReport(report: NewResearchReport): Promise<ResearchReportRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO research_reports (id, user_id, topic, summary, findings, verified_count, unverified_count, open_questions, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [id, report.userId, report.topic, report.summary, JSON.stringify(report.findings), report.verifiedCount, report.unverifiedCount, JSON.stringify(report.openQuestions), report.now],
    );
    return { id, userId: report.userId, topic: report.topic, summary: report.summary, findings: report.findings, verifiedCount: report.verifiedCount, unverifiedCount: report.unverifiedCount, openQuestions: report.openQuestions, createdAt: report.now };
  }

  async listReportsByUser(userId: string, take: number): Promise<ResearchReportRecord[]> {
    const result = await this.pool.query<ReportRow>(
      'SELECT * FROM research_reports WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [userId, take],
    );
    return result.rows.map(toReportRecord);
  }

  async findReportById(userId: string, id: string): Promise<ResearchReportRecord | null> {
    const result = await this.pool.query<ReportRow>('SELECT * FROM research_reports WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = result.rows[0];
    return row ? toReportRecord(row) : null;
  }
}
