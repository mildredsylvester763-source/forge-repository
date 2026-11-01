import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { AppError } from '../../kernel/errors.ts';
import { evaluateDomain, findOverlap, validateRuleList, type DomainRules } from './engine/domain-policy.ts';
import { rankResults, type RankableResult } from './engine/source-ranking.ts';
import { extractPage } from './engine/page-extraction.ts';
import { freshnessBand } from './engine/freshness.ts';
import { parseSourceUrl, validateCitation } from './engine/citation.ts';
import { WebSearchEvents, WEB_SEARCH_EVENT_VERSION } from './events.ts';
import type {
  CitationRecord,
  DomainRuleRecord,
  FetchedPageRecord,
  WebSearchQueryRecord,
  WebSearchStore,
} from './web-search-store.ts';

export interface WebSearchDeps {
  readonly store: WebSearchStore;
  readonly events: EventStore;
  readonly clock: Clock;
}

const refusal = (reason: string): AppError => new AppError(400, reason, reason);

/**
 * FORGE AI-057..061 (web search tool). The service never performs network
 * I/O itself: callers supply raw results and page html, the service enforces
 * the per-workspace domain policy, ranks with the pure engines, extracts and
 * stores clean pages, and tracks citations with idempotent bindings. Every
 * refusal is named, never a silent guess.
 */
export class WebSearchService {
  private readonly store: WebSearchStore;
  private readonly events: EventStore;
  private readonly clock: Clock;

  constructor(deps: WebSearchDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.clock = deps.clock;
  }

  private workspaceOf(dto: { workspace?: unknown }): string {
    const w = typeof dto?.workspace === 'string' ? dto.workspace.trim() : '';
    return w.length > 0 ? w.slice(0, 64) : 'default';
  }

  private limitOf(limit: unknown): number {
    const raw = typeof limit === 'string' ? limit : typeof limit === 'number' ? String(limit) : undefined;
    const n = Number.parseInt(raw ?? '50', 10) || 50;
    return Math.min(Math.max(n, 1), 200);
  }

  private async emit(type: string, subjectId: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.append({
      type,
      version: WEB_SEARCH_EVENT_VERSION,
      actor: { kind: 'system', id: 'forge' },
      subject: { type: 'web_search', id: subjectId },
      payload,
    });
  }

  private async loadRules(userId: string, workspace: string): Promise<DomainRuleRecord> {
    const existing = await this.store.findRule(userId, workspace);
    if (existing) return existing;
    return this.store.createRule({ userId, workspace, allow: [], deny: [], now: this.clock() });
  }

  async search(userId: string, body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const workspace = this.workspaceOf(dto);
    const query = typeof dto.query === 'string' ? dto.query : '';
    if (query.length === 0) throw refusal('search-missing-query');
    if (query.length > 500) throw refusal('search-query-too-long');
    const rawResults = Array.isArray(dto.results) ? (dto.results as unknown[]) : [];
    if (rawResults.length === 0) throw refusal('search-no-results-supplied');
    if (rawResults.length > 50) throw refusal('search-too-many-results');
    const rules = await this.loadRules(userId, workspace);
    const policy: DomainRules = { allow: rules.allow, deny: rules.deny };

    const allowed: RankableResult[] = [];
    const skipped: { url: string; reason: string }[] = [];
    for (const r of rawResults) {
      const row = (r ?? {}) as Record<string, unknown>;
      const url = typeof row.url === 'string' ? row.url : '';
      const parsed = url
        ? parseSourceUrl(url)
        : { ok: false as const, reason: 'rank-result-missing-url' };
      if (!parsed.ok) {
        skipped.push({ url, reason: parsed.reason });
        continue;
      }
      const verdict = evaluateDomain(parsed.source.host, policy);
      if (!verdict.ok) {
        skipped.push({ url, reason: verdict.reason ?? 'domain-refused' });
        continue;
      }
      allowed.push(row as RankableResult);
    }

    let ranked: unknown[] = [];
    if (allowed.length > 0) {
      const verdict = rankResults(query, allowed, new Date(this.clock()));
      if (verdict.ok) {
        ranked = verdict.ranked;
        for (const s of verdict.skipped) skipped.push(s);
      } else {
        for (const r of allowed) skipped.push({ url: r.url, reason: verdict.reason });
      }
    }

    const refusedReason =
      ranked.length === 0
        ? allowed.length === 0
          ? 'search-no-allowed-results'
          : 'rank-no-usable-results'
        : null;

    const record = await this.store.createQuery({
      userId,
      workspace,
      query,
      results: ranked.slice(0, 50),
      skipped: skipped.slice(0, 200),
      refusedReason,
      now: this.clock(),
    });
    await this.emit(WebSearchEvents.QueryRecorded, record.id, {
      workspace,
      ranked: ranked.length,
      skipped: skipped.length,
      refusedReason,
    });
    return {
      id: record.id,
      query: record.query,
      workspace: record.workspace,
      ranked,
      skipped,
      refusedReason,
      createdAt: record.createdAt,
    };
  }

  async listQueries(userId: string, limit: unknown): Promise<WebSearchQueryRecord[]> {
    return this.store.listQueriesByUser(userId, this.limitOf(limit));
  }

  async fetchPage(userId: string, body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const workspace = this.workspaceOf(dto);
    const url = typeof dto.url === 'string' ? dto.url : '';
    const html = typeof dto.html === 'string' ? dto.html : '';
    if (html.length > 300000) throw refusal('fetch-page-html-too-long');
    const parsed = parseSourceUrl(url);
    if (!parsed.ok) throw refusal(parsed.reason);
    const rules = await this.loadRules(userId, workspace);
    const verdict = evaluateDomain(parsed.source.host, { allow: rules.allow, deny: rules.deny });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'domain-refused');
    const extraction = extractPage(html);
    if (!extraction.ok) throw refusal(extraction.reason);
    const freshness = freshnessBand(extraction.page.publishedAt, new Date(this.clock()));
    const band = freshness.ok ? freshness.band ?? 'unknown' : 'unknown';

    const existing = await this.store.findPage(userId, parsed.source.url);
    const now = this.clock();
    let saved: FetchedPageRecord;
    if (existing) {
      saved = await this.store.savePage({
        ...existing,
        domain: parsed.source.host,
        title: extraction.page.title,
        wordCount: extraction.page.wordCount,
        content: extraction.page.text,
        publishedAt: extraction.page.publishedAt,
        freshnessBand: band,
        updatedAt: now,
      });
    } else {
      saved = await this.store.createPage({
        userId,
        url: parsed.source.url,
        domain: parsed.source.host,
        title: extraction.page.title,
        wordCount: extraction.page.wordCount,
        content: extraction.page.text,
        publishedAt: extraction.page.publishedAt,
        freshnessBand: band,
        now,
      });
    }
    await this.emit(WebSearchEvents.PageFetched, saved.id, { domain: saved.domain, reused: existing !== null });
    return { ...saved, reused: existing !== null };
  }

  async listPages(userId: string, limit: unknown): Promise<FetchedPageRecord[]> {
    return this.store.listPagesByUser(userId, this.limitOf(limit));
  }

  async createCitation(userId: string, body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = validateCitation(dto.claim, typeof dto.sourceUrl === 'string' ? dto.sourceUrl : '');
    if (!verdict.ok) throw refusal(verdict.reason);
    if (verdict.claim.length > 5000) throw refusal('citation-claim-too-long');
    const sourceTitle = typeof dto.sourceTitle === 'string' ? dto.sourceTitle : null;
    if (sourceTitle !== null && sourceTitle.length > 500) throw refusal('citation-title-too-long');
    const quote = typeof dto.quote === 'string' ? dto.quote : null;
    if (quote !== null && quote.length > 5000) throw refusal('citation-quote-too-long');
    const existing = await this.store.findCitation(userId, verdict.claim, verdict.source.url);
    if (existing) return { ...existing, reused: true };
    const saved = await this.store.createCitation({
      userId,
      claimText: verdict.claim,
      sourceUrl: verdict.source.url,
      sourceTitle,
      quote,
      now: this.clock(),
    });
    await this.emit(WebSearchEvents.CitationCreated, saved.id, { reused: false });
    return { ...saved, reused: false };
  }

  async listCitations(userId: string, limit: unknown): Promise<CitationRecord[]> {
    return this.store.listCitationsByUser(userId, this.limitOf(limit));
  }

  async setDomainRules(userId: string, body: unknown): Promise<DomainRuleRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const workspace = this.workspaceOf(dto);
    const allow = Array.isArray(dto.allow) ? (dto.allow as unknown[]) : [];
    const deny = Array.isArray(dto.deny) ? (dto.deny as unknown[]) : [];
    if (allow.length > 200) throw refusal('rules-too-many:allow');
    if (deny.length > 200) throw refusal('rules-too-many:deny');
    const allowProblem = validateRuleList(allow);
    if (allowProblem) throw refusal(allowProblem);
    const denyProblem = validateRuleList(deny);
    if (denyProblem) throw refusal(denyProblem);
    const overlap = findOverlap(allow as string[], deny as string[]);
    if (overlap) throw refusal('rules-allow-deny-overlap:' + overlap);
    const now = this.clock();
    const existing = await this.store.findRule(userId, workspace);
    const saved = existing
      ? await this.store.saveRule({ ...existing, allow: allow as string[], deny: deny as string[], updatedAt: now })
      : await this.store.createRule({ userId, workspace, allow: allow as string[], deny: deny as string[], now });
    await this.emit(WebSearchEvents.RulesChanged, userId + ':' + workspace, {
      workspace,
      allow: saved.allow.length,
      deny: saved.deny.length,
    });
    return saved;
  }

  async getDomainRules(userId: string, body: unknown): Promise<DomainRuleRecord> {
    return this.loadRules(userId, this.workspaceOf((body ?? {}) as Record<string, unknown>));
  }
}
