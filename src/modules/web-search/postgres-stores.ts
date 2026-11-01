import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../../kernel/sql.ts';
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
  created_at: string | number;
  updated_at: string | number;
}

interface RuleRow {
  id: string;
  user_id: string;
  workspace: string;
  allow: string;
  deny: string;
  created_at: string | number;
  updated_at: string | number;
}

interface PageRow {
  id: string;
  user_id: string;
  url: string;
  domain: string;
  title: string | null;
  word_count: string | number;
  content: string;
  published_at: string | null;
  freshness_band: string;
  created_at: string | number;
  updated_at: string | number;
}

interface CitationRow {
  id: string;
  user_id: string;
  claim_text: string;
  source_url: string;
  source_title: string | null;
  quote: string | null;
  created_at: string | number;
}

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value));

const toQueryRecord = (r: QueryRow): WebSearchQueryRecord => ({
  id: r.id,
  userId: r.user_id,
  workspace: r.workspace,
  query: r.query,
  results: JSON.parse(r.results) as unknown,
  skipped: JSON.parse(r.skipped) as unknown,
  refusedReason: r.refused_reason,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toRuleRecord = (r: RuleRow): DomainRuleRecord => ({
  id: r.id,
  userId: r.user_id,
  workspace: r.workspace,
  allow: JSON.parse(r.allow) as string[],
  deny: JSON.parse(r.deny) as string[],
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toPageRecord = (r: PageRow): FetchedPageRecord => ({
  id: r.id,
  userId: r.user_id,
  url: r.url,
  domain: r.domain,
  title: r.title,
  wordCount: num(r.word_count),
  content: r.content,
  publishedAt: r.published_at,
  freshnessBand: r.freshness_band,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toCitationRecord = (r: CitationRow): CitationRecord => ({
  id: r.id,
  userId: r.user_id,
  claimText: r.claim_text,
  sourceUrl: r.source_url,
  sourceTitle: r.source_title,
  quote: r.quote,
  createdAt: num(r.created_at),
});

export class PostgresWebSearchStore implements WebSearchStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async createQuery(query: NewWebSearchQuery): Promise<WebSearchQueryRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO web_search_queries (id, user_id, workspace, query, results, skipped, refused_reason, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [id, query.userId, query.workspace, query.query, JSON.stringify(query.results), JSON.stringify(query.skipped), query.refusedReason, query.now, query.now],
    );
    return { id, userId: query.userId, workspace: query.workspace, query: query.query, results: query.results, skipped: query.skipped, refusedReason: query.refusedReason, createdAt: query.now, updatedAt: query.now };
  }

  async listQueriesByUser(userId: string, take: number): Promise<WebSearchQueryRecord[]> {
    const result = await this.pool.query<QueryRow>(
      'SELECT * FROM web_search_queries WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [userId, take],
    );
    return result.rows.map(toQueryRecord);
  }

  async findRule(userId: string, workspace: string): Promise<DomainRuleRecord | null> {
    const result = await this.pool.query<RuleRow>('SELECT * FROM web_search_domain_rules WHERE user_id = $1 AND workspace = $2', [userId, workspace]);
    const row = result.rows[0];
    return row ? toRuleRecord(row) : null;
  }

  async createRule(rule: NewDomainRule): Promise<DomainRuleRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO web_search_domain_rules (id, user_id, workspace, allow, deny, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, rule.userId, rule.workspace, JSON.stringify(rule.allow), JSON.stringify(rule.deny), rule.now, rule.now],
    );
    return { id, userId: rule.userId, workspace: rule.workspace, allow: rule.allow, deny: rule.deny, createdAt: rule.now, updatedAt: rule.now };
  }

  async saveRule(rule: DomainRuleRecord): Promise<DomainRuleRecord> {
    await this.pool.query(
      'UPDATE web_search_domain_rules SET allow = $1, deny = $2, updated_at = $3 WHERE id = $4',
      [JSON.stringify(rule.allow), JSON.stringify(rule.deny), rule.updatedAt, rule.id],
    );
    return rule;
  }

  async findPage(userId: string, url: string): Promise<FetchedPageRecord | null> {
    const result = await this.pool.query<PageRow>('SELECT * FROM web_search_pages WHERE user_id = $1 AND url = $2', [userId, url]);
    const row = result.rows[0];
    return row ? toPageRecord(row) : null;
  }

  async createPage(page: NewFetchedPage): Promise<FetchedPageRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO web_search_pages (id, user_id, url, domain, title, word_count, content, published_at, freshness_band, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      [id, page.userId, page.url, page.domain, page.title, page.wordCount, page.content, page.publishedAt, page.freshnessBand, page.now, page.now],
    );
    return { id, userId: page.userId, url: page.url, domain: page.domain, title: page.title, wordCount: page.wordCount, content: page.content, publishedAt: page.publishedAt, freshnessBand: page.freshnessBand, createdAt: page.now, updatedAt: page.now };
  }

  async savePage(page: FetchedPageRecord): Promise<FetchedPageRecord> {
    await this.pool.query(
      'UPDATE web_search_pages SET domain = $1, title = $2, word_count = $3, content = $4, published_at = $5, freshness_band = $6, updated_at = $7 WHERE id = $8',
      [page.domain, page.title, page.wordCount, page.content, page.publishedAt, page.freshnessBand, page.updatedAt, page.id],
    );
    return page;
  }

  async listPagesByUser(userId: string, take: number): Promise<FetchedPageRecord[]> {
    const result = await this.pool.query<PageRow>(
      'SELECT * FROM web_search_pages WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [userId, take],
    );
    return result.rows.map(toPageRecord);
  }

  async findCitation(userId: string, claimText: string, sourceUrl: string): Promise<CitationRecord | null> {
    const result = await this.pool.query<CitationRow>(
      'SELECT * FROM web_search_citations WHERE user_id = $1 AND claim_text = $2 AND source_url = $3',
      [userId, claimText, sourceUrl],
    );
    const row = result.rows[0];
    return row ? toCitationRecord(row) : null;
  }

  async createCitation(citation: NewCitation): Promise<CitationRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO web_search_citations (id, user_id, claim_text, source_url, source_title, quote, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, citation.userId, citation.claimText, citation.sourceUrl, citation.sourceTitle, citation.quote, citation.now],
    );
    return { id, userId: citation.userId, claimText: citation.claimText, sourceUrl: citation.sourceUrl, sourceTitle: citation.sourceTitle, quote: citation.quote, createdAt: citation.now };
  }

  async listCitationsByUser(userId: string, take: number): Promise<CitationRecord[]> {
    const result = await this.pool.query<CitationRow>(
      'SELECT * FROM web_search_citations WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [userId, take],
    );
    return result.rows.map(toCitationRecord);
  }
}
