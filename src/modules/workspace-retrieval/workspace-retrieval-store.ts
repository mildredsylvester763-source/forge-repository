import { randomUUID } from 'node:crypto';

export interface ContentItemRecord {
  readonly id: string;
  readonly userId: string;
  readonly source: string;
  readonly title: string;
  readonly body: string;
  readonly links: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewContentItem {
  userId: string;
  source: string;
  title: string;
  body: string;
  links: string[];
  now: number;
}

export interface ResearchReportRecord {
  readonly id: string;
  readonly userId: string;
  readonly topic: string;
  readonly summary: string;
  readonly findings: unknown;
  readonly verifiedCount: number;
  readonly unverifiedCount: number;
  readonly openQuestions: unknown;
  readonly createdAt: number;
}

export interface NewResearchReport {
  userId: string;
  topic: string;
  summary: string;
  findings: unknown;
  verifiedCount: number;
  unverifiedCount: number;
  openQuestions: unknown;
  now: number;
}

/**
 * The workspace retrieval module's storage contract: recorded content items
 * from the five workspace sources and research reports. SQLite and
 * PostgreSQL adapters sit behind the same interface.
 */
export interface WorkspaceRetrievalStore {
  createItem(item: NewContentItem): Promise<ContentItemRecord>;
  listItemsByUser(userId: string, take: number): Promise<ContentItemRecord[]>;
  listIdsByUser(userId: string): Promise<string[]>;
  createReport(report: NewResearchReport): Promise<ResearchReportRecord>;
  listReportsByUser(userId: string, take: number): Promise<ResearchReportRecord[]>;
  findReportById(userId: string, id: string): Promise<ResearchReportRecord | null>;
}

/** Development and test store. */
export class InMemoryWorkspaceRetrievalStore implements WorkspaceRetrievalStore {
  private readonly itemsByUser = new Map<string, ContentItemRecord[]>();
  private readonly reportsByUser = new Map<string, ResearchReportRecord[]>();

  async createItem(item: NewContentItem): Promise<ContentItemRecord> {
    const record: ContentItemRecord = {
      id: randomUUID(),
      userId: item.userId,
      source: item.source,
      title: item.title,
      body: item.body,
      links: item.links,
      createdAt: item.now,
      updatedAt: item.now,
    };
    const list = this.itemsByUser.get(item.userId) ?? [];
    list.unshift(record);
    this.itemsByUser.set(item.userId, list);
    return record;
  }

  async listItemsByUser(userId: string, take: number): Promise<ContentItemRecord[]> {
    return (this.itemsByUser.get(userId) ?? []).slice(0, take);
  }

  async listIdsByUser(userId: string): Promise<string[]> {
    return (this.itemsByUser.get(userId) ?? []).map((item) => item.id);
  }

  async createReport(report: NewResearchReport): Promise<ResearchReportRecord> {
    const record: ResearchReportRecord = {
      id: randomUUID(),
      userId: report.userId,
      topic: report.topic,
      summary: report.summary,
      findings: report.findings,
      verifiedCount: report.verifiedCount,
      unverifiedCount: report.unverifiedCount,
      openQuestions: report.openQuestions,
      createdAt: report.now,
    };
    const list = this.reportsByUser.get(report.userId) ?? [];
    list.unshift(record);
    this.reportsByUser.set(report.userId, list);
    return record;
  }

  async listReportsByUser(userId: string, take: number): Promise<ResearchReportRecord[]> {
    return (this.reportsByUser.get(userId) ?? []).slice(0, take);
  }

  async findReportById(userId: string, id: string): Promise<ResearchReportRecord | null> {
    const list = this.reportsByUser.get(userId) ?? [];
    return list.find((report) => report.id === id) ?? null;
  }
}
