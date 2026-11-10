import { randomUUID } from 'node:crypto';

export interface WebSearchQueryRecord {
  readonly id: string;
  readonly userId: string;
  readonly workspace: string;
  readonly query: string;
  readonly results: unknown;
  readonly skipped: unknown;
  readonly refusedReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewWebSearchQuery {
  userId: string;
  workspace: string;
  query: string;
  results: unknown;
  skipped: unknown;
  refusedReason: string | null;
  now: number;
}

export interface DomainRuleRecord {
  readonly id: string;
  readonly userId: string;
  readonly workspace: string;
  readonly allow: string[];
  readonly deny: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewDomainRule {
  userId: string;
  workspace: string;
  allow: string[];
  deny: string[];
  now: number;
}

export interface FetchedPageRecord {
  readonly id: string;
  readonly userId: string;
  readonly url: string;
  readonly domain: string;
  readonly title: string | null;
  readonly wordCount: number;
  readonly content: string;
  readonly publishedAt: string | null;
  readonly freshnessBand: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewFetchedPage {
  userId: string;
  url: string;
  domain: string;
  title: string | null;
  wordCount: number;
  content: string;
  publishedAt: string | null;
  freshnessBand: string;
  now: number;
}

export interface CitationRecord {
  readonly id: string;
  readonly userId: string;
  readonly claimText: string;
  readonly sourceUrl: string;
  readonly sourceTitle: string | null;
  readonly quote: string | null;
  readonly createdAt: number;
}

export interface NewCitation {
  userId: string;
  claimText: string;
  sourceUrl: string;
  sourceTitle: string | null;
  quote: string | null;
  now: number;
}

/**
 * The web search module's storage contract: recorded queries, per-workspace
 * domain rules, fetched pages and citation bindings. SQLite and PostgreSQL
 * adapters sit behind the same interface.
 */
export interface WebSearchStore {
  createQuery(query: NewWebSearchQuery): Promise<WebSearchQueryRecord>;
  listQueriesByUser(userId: string, take: number): Promise<WebSearchQueryRecord[]>;
  findRule(userId: string, workspace: string): Promise<DomainRuleRecord | null>;
  createRule(rule: NewDomainRule): Promise<DomainRuleRecord>;
  saveRule(rule: DomainRuleRecord): Promise<DomainRuleRecord>;
  findPage(userId: string, url: string): Promise<FetchedPageRecord | null>;
  createPage(page: NewFetchedPage): Promise<FetchedPageRecord>;
  savePage(page: FetchedPageRecord): Promise<FetchedPageRecord>;
  listPagesByUser(userId: string, take: number): Promise<FetchedPageRecord[]>;
  findCitation(userId: string, claimText: string, sourceUrl: string): Promise<CitationRecord | null>;
  createCitation(citation: NewCitation): Promise<CitationRecord>;
  listCitationsByUser(userId: string, take: number): Promise<CitationRecord[]>;
}

/** Development and test store. */
export class InMemoryWebSearchStore implements WebSearchStore {
  private readonly queriesByUser = new Map<string, WebSearchQueryRecord[]>();
  private readonly rulesByUser = new Map<string, DomainRuleRecord[]>();
  private readonly pagesByUser = new Map<string, FetchedPageRecord[]>();
  private readonly citationsByUser = new Map<string, CitationRecord[]>();

  async createQuery(query: NewWebSearchQuery): Promise<WebSearchQueryRecord> {
    const record: WebSearchQueryRecord = {
      id: randomUUID(),
      userId: query.userId,
      workspace: query.workspace,
      query: query.query,
      results: query.results,
      skipped: query.skipped,
      refusedReason: query.refusedReason,
      createdAt: query.now,
      updatedAt: query.now,
    };
    const list = this.queriesByUser.get(query.userId) ?? [];
    list.unshift(record);
    this.queriesByUser.set(query.userId, list);
    return record;
  }

  async listQueriesByUser(userId: string, take: number): Promise<WebSearchQueryRecord[]> {
    return (this.queriesByUser.get(userId) ?? []).slice(0, take);
  }

  async findRule(userId: string, workspace: string): Promise<DomainRuleRecord | null> {
    const list = this.rulesByUser.get(userId) ?? [];
    return list.find((r) => r.workspace === workspace) ?? null;
  }

  async createRule(rule: NewDomainRule): Promise<DomainRuleRecord> {
    const record: DomainRuleRecord = {
      id: randomUUID(),
      userId: rule.userId,
      workspace: rule.workspace,
      allow: rule.allow,
      deny: rule.deny,
      createdAt: rule.now,
      updatedAt: rule.now,
    };
    this.rulesByUser.set(rule.userId, [record, ...(this.rulesByUser.get(rule.userId) ?? [])]);
    return record;
  }

  async saveRule(rule: DomainRuleRecord): Promise<DomainRuleRecord> {
    const list = this.rulesByUser.get(rule.userId) ?? [];
    const idx = list.findIndex((r) => r.id === rule.id);
    if (idx === -1) return rule;
    list[idx] = rule;
    return rule;
  }

  async findPage(userId: string, url: string): Promise<FetchedPageRecord | null> {
    const list = this.pagesByUser.get(userId) ?? [];
    return list.find((p) => p.url === url) ?? null;
  }

  async createPage(page: NewFetchedPage): Promise<FetchedPageRecord> {
    const record: FetchedPageRecord = {
      id: randomUUID(),
      userId: page.userId,
      url: page.url,
      domain: page.domain,
      title: page.title,
      wordCount: page.wordCount,
      content: page.content,
      publishedAt: page.publishedAt,
      freshnessBand: page.freshnessBand,
      createdAt: page.now,
      updatedAt: page.now,
    };
    const list = this.pagesByUser.get(page.userId) ?? [];
    list.unshift(record);
    this.pagesByUser.set(page.userId, list);
    return record;
  }

  async savePage(page: FetchedPageRecord): Promise<FetchedPageRecord> {
    const list = this.pagesByUser.get(page.userId) ?? [];
    const idx = list.findIndex((p) => p.id === page.id);
    if (idx === -1) return page;
    list[idx] = page;
    return page;
  }

  async listPagesByUser(userId: string, take: number): Promise<FetchedPageRecord[]> {
    return (this.pagesByUser.get(userId) ?? []).slice(0, take);
  }

  async findCitation(userId: string, claimText: string, sourceUrl: string): Promise<CitationRecord | null> {
    const list = this.citationsByUser.get(userId) ?? [];
    return list.find((c) => c.claimText === claimText && c.sourceUrl === sourceUrl) ?? null;
  }

  async createCitation(citation: NewCitation): Promise<CitationRecord> {
    const record: CitationRecord = {
      id: randomUUID(),
      userId: citation.userId,
      claimText: citation.claimText,
      sourceUrl: citation.sourceUrl,
      sourceTitle: citation.sourceTitle,
      quote: citation.quote,
      createdAt: citation.now,
    };
    const list = this.citationsByUser.get(citation.userId) ?? [];
    list.unshift(record);
    this.citationsByUser.set(citation.userId, list);
    return record;
  }

  async listCitationsByUser(userId: string, take: number): Promise<CitationRecord[]> {
    return (this.citationsByUser.get(userId) ?? []).slice(0, take);
  }
}
