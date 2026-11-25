import { randomUUID } from 'node:crypto';
import { transaction, type Database } from '../../kernel/sqlite.ts';
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
  created_at: number;
  updated_at: number;
}

interface ReportRow {
  id: string;
  user_id: string;
  topic: string;
  summary: string;
  findings: string;
  verified_count: number;
  unverified_count: number;
  open_questions: string;
  created_at: number;
}

const toItemRecord = (r: ItemRow): ContentItemRecord => ({
  id: r.id,
  userId: r.user_id,
  source: r.source,
  title: r.title,
  body: r.body,
  links: JSON.parse(r.links) as string[],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toReportRecord = (r: ReportRow): ResearchReportRecord => ({
  id: r.id,
  userId: r.user_id,
  topic: r.topic,
  summary: r.summary,
  findings: JSON.parse(r.findings) as unknown,
  verifiedCount: r.verified_count,
  unverifiedCount: r.unverified_count,
  openQuestions: JSON.parse(r.open_questions) as unknown,
  createdAt: r.created_at,
});

export class SqliteWorkspaceRetrievalStore implements WorkspaceRetrievalStore {
  private readonly db: Database;
  private readonly insertItem;
  private readonly itemsByUser;
  private readonly idsByUser;
  private readonly insertReport;
  private readonly reportsByUser;
  private readonly findReportStmt;

  constructor(db: Database) {
    this.db = db;
    this.insertItem = db.prepare('INSERT INTO workspace_content_items (id, user_id, source, title, body, links, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.itemsByUser = db.prepare('SELECT * FROM workspace_content_items WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.idsByUser = db.prepare('SELECT id FROM workspace_content_items WHERE user_id = ?');
    this.insertReport = db.prepare('INSERT INTO research_reports (id, user_id, topic, summary, findings, verified_count, unverified_count, open_questions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.reportsByUser = db.prepare('SELECT * FROM research_reports WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.findReportStmt = db.prepare('SELECT * FROM research_reports WHERE user_id = ? AND id = ?');
  }

  async createItem(item: NewContentItem): Promise<ContentItemRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertItem.run(id, item.userId, item.source, item.title, item.body, JSON.stringify(item.links), item.now, item.now);
      return { id, userId: item.userId, source: item.source, title: item.title, body: item.body, links: item.links, createdAt: item.now, updatedAt: item.now };
    });
  }

  async listItemsByUser(userId: string, take: number): Promise<ContentItemRecord[]> {
    const rows = this.itemsByUser.all(userId, take) as unknown as ItemRow[];
    return rows.map(toItemRecord);
  }

  async listIdsByUser(userId: string): Promise<string[]> {
    const rows = this.idsByUser.all(userId) as unknown as { id: string }[];
    return rows.map((r) => r.id);
  }

  async createReport(report: NewResearchReport): Promise<ResearchReportRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertReport.run(id, report.userId, report.topic, report.summary, JSON.stringify(report.findings), report.verifiedCount, report.unverifiedCount, JSON.stringify(report.openQuestions), report.now);
      return { id, userId: report.userId, topic: report.topic, summary: report.summary, findings: report.findings, verifiedCount: report.verifiedCount, unverifiedCount: report.unverifiedCount, openQuestions: report.openQuestions, createdAt: report.now };
    });
  }

  async listReportsByUser(userId: string, take: number): Promise<ResearchReportRecord[]> {
    const rows = this.reportsByUser.all(userId, take) as unknown as ReportRow[];
    return rows.map(toReportRecord);
  }

  async findReportById(userId: string, id: string): Promise<ResearchReportRecord | null> {
    const row = this.findReportStmt.get(userId, id) as unknown as ReportRow | undefined;
    return row ? toReportRecord(row) : null;
  }
}
