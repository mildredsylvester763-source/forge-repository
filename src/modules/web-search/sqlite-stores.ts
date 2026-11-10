import { randomUUID } from 'node:crypto';
import { transaction, type Database } from '../../kernel/sqlite.ts';
import type {
  CitationRecord,
  DomainRuleRecord,
  FetchedPageRecord,
  NewCitation,
  NewDomainRule,
  NewFetchedPage,
  NewWebSearchQuery,
  WebSearchQueryRecord,
  WebSearchStore,
} from './web-search-store.ts';

interface QueryRow {
  id: string;
  user_id: string;
  workspace: string;
  query: string;
  results: string;
  skipped: string;
  refused_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface RuleRow {
  id: string;
  user_id: string;
  workspace: string;
  allow: string;
  deny: string;
  created_at: number;
  updated_at: number;
}

interface PageRow {
  id: string;
  user_id: string;
  url: string;
  domain: string;
  title: string | null;
  word_count: number;
  content: string;
  published_at: string | null;
  freshness_band: string;
  created_at: number;
  updated_at: number;
}

interface CitationRow {
  id: string;
  user_id: string;
  claim_text: string;
  source_url: string;
  source_title: string | null;
  quote: string | null;
  created_at: number;
}

const toQueryRecord = (r: QueryRow): WebSearchQueryRecord => ({
  id: r.id,
  userId: r.user_id,
  workspace: r.workspace,
  query: r.query,
  results: JSON.parse(r.results) as unknown,
  skipped: JSON.parse(r.skipped) as unknown,
  refusedReason: r.refused_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRuleRecord = (r: RuleRow): DomainRuleRecord => ({
  id: r.id,
  userId: r.user_id,
  workspace: r.workspace,
  allow: JSON.parse(r.allow) as string[],
  deny: JSON.parse(r.deny) as string[],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toPageRecord = (r: PageRow): FetchedPageRecord => ({
  id: r.id,
  userId: r.user_id,
  url: r.url,
  domain: r.domain,
  title: r.title,
  wordCount: r.word_count,
  content: r.content,
  publishedAt: r.published_at,
  freshnessBand: r.freshness_band,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toCitationRecord = (r: CitationRow): CitationRecord => ({
  id: r.id,
  userId: r.user_id,
  claimText: r.claim_text,
  sourceUrl: r.source_url,
  sourceTitle: r.source_title,
  quote: r.quote,
  createdAt: r.created_at,
});

export class SqliteWebSearchStore implements WebSearchStore {
  private readonly db: Database;
  private readonly insertQuery;
  private readonly queriesByUser;
  private readonly findRuleStmt;
  private readonly insertRule;
  private readonly updateRule;
  private readonly findPageStmt;
  private readonly insertPage;
  private readonly updatePage;
  private readonly pagesByUser;
  private readonly findCitationStmt;
  private readonly insertCitation;
  private readonly citationsByUser;

  constructor(db: Database) {
    this.db = db;
    this.insertQuery = db.prepare('INSERT INTO web_search_queries (id, user_id, workspace, query, results, skipped, refused_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.queriesByUser = db.prepare('SELECT * FROM web_search_queries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.findRuleStmt = db.prepare('SELECT * FROM web_search_domain_rules WHERE user_id = ? AND workspace = ?');
    this.insertRule = db.prepare('INSERT INTO web_search_domain_rules (id, user_id, workspace, allow, deny, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.updateRule = db.prepare('UPDATE web_search_domain_rules SET allow = ?, deny = ?, updated_at = ? WHERE id = ?');
    this.findPageStmt = db.prepare('SELECT * FROM web_search_pages WHERE user_id = ? AND url = ?');
    this.insertPage = db.prepare('INSERT INTO web_search_pages (id, user_id, url, domain, title, word_count, content, published_at, freshness_band, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.updatePage = db.prepare('UPDATE web_search_pages SET domain = ?, title = ?, word_count = ?, content = ?, published_at = ?, freshness_band = ?, updated_at = ? WHERE id = ?');
    this.pagesByUser = db.prepare('SELECT * FROM web_search_pages WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.findCitationStmt = db.prepare('SELECT * FROM web_search_citations WHERE user_id = ? AND claim_text = ? AND source_url = ?');
    this.insertCitation = db.prepare('INSERT INTO web_search_citations (id, user_id, claim_text, source_url, source_title, quote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.citationsByUser = db.prepare('SELECT * FROM web_search_citations WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
  }

  async createQuery(query: NewWebSearchQuery): Promise<WebSearchQueryRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertQuery.run(id, query.userId, query.workspace, query.query, JSON.stringify(query.results), JSON.stringify(query.skipped), query.refusedReason, query.now, query.now);
      return { id, userId: query.userId, workspace: query.workspace, query: query.query, results: query.results, skipped: query.skipped, refusedReason: query.refusedReason, createdAt: query.now, updatedAt: query.now };
    });
  }

  async listQueriesByUser(userId: string, take: number): Promise<WebSearchQueryRecord[]> {
    const rows = this.queriesByUser.all(userId, take) as unknown as QueryRow[];
    return rows.map(toQueryRecord);
  }

  async findRule(userId: string, workspace: string): Promise<DomainRuleRecord | null> {
    const row = this.findRuleStmt.get(userId, workspace) as unknown as RuleRow | undefined;
    return row ? toRuleRecord(row) : null;
  }

  async createRule(rule: NewDomainRule): Promise<DomainRuleRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertRule.run(id, rule.userId, rule.workspace, JSON.stringify(rule.allow), JSON.stringify(rule.deny), rule.now, rule.now);
      return { id, userId: rule.userId, workspace: rule.workspace, allow: rule.allow, deny: rule.deny, createdAt: rule.now, updatedAt: rule.now };
    });
  }

  async saveRule(rule: DomainRuleRecord): Promise<DomainRuleRecord> {
    return transaction(this.db, () => {
      this.updateRule.run(JSON.stringify(rule.allow), JSON.stringify(rule.deny), rule.updatedAt, rule.id);
      return rule;
    });
  }

  async findPage(userId: string, url: string): Promise<FetchedPageRecord | null> {
    const row = this.findPageStmt.get(userId, url) as unknown as PageRow | undefined;
    return row ? toPageRecord(row) : null;
  }

  async createPage(page: NewFetchedPage): Promise<FetchedPageRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertPage.run(id, page.userId, page.url, page.domain, page.title, page.wordCount, page.content, page.publishedAt, page.freshnessBand, page.now, page.now);
      return { id, userId: page.userId, url: page.url, domain: page.domain, title: page.title, wordCount: page.wordCount, content: page.content, publishedAt: page.publishedAt, freshnessBand: page.freshnessBand, createdAt: page.now, updatedAt: page.now };
    });
  }

  async savePage(page: FetchedPageRecord): Promise<FetchedPageRecord> {
    return transaction(this.db, () => {
      this.updatePage.run(page.domain, page.title, page.wordCount, page.content, page.publishedAt, page.freshnessBand, page.updatedAt, page.id);
      return page;
    });
  }

  async listPagesByUser(userId: string, take: number): Promise<FetchedPageRecord[]> {
    const rows = this.pagesByUser.all(userId, take) as unknown as PageRow[];
    return rows.map(toPageRecord);
  }

  async findCitation(userId: string, claimText: string, sourceUrl: string): Promise<CitationRecord | null> {
    const row = this.findCitationStmt.get(userId, claimText, sourceUrl) as unknown as CitationRow | undefined;
    return row ? toCitationRecord(row) : null;
  }

  async createCitation(citation: NewCitation): Promise<CitationRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertCitation.run(id, citation.userId, citation.claimText, citation.sourceUrl, citation.sourceTitle, citation.quote, citation.now);
      return { id, userId: citation.userId, claimText: citation.claimText, sourceUrl: citation.sourceUrl, sourceTitle: citation.sourceTitle, quote: citation.quote, createdAt: citation.now };
    });
  }

  async listCitationsByUser(userId: string, take: number): Promise<CitationRecord[]> {
    const rows = this.citationsByUser.all(userId, take) as unknown as CitationRow[];
    return rows.map(toCitationRecord);
  }
}
