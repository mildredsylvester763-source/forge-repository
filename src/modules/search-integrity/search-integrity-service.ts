import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { AppError } from '../../kernel/errors.ts';
import { separateFacts as runSeparateFacts } from './engine/fact-claims.ts';
import { planQuotes as runPlanQuotes, QUOTE_LICENSES } from './engine/quoting-limits.ts';
import { REFERENCE_LICENSES, REFERENCE_MEDIA, searchReferences as runSearchReferences } from './engine/reference-search.ts';
import { cacheState, checkRate as runCheckRate, DEFAULT_TTL, normalizeCacheKey } from './engine/search-cache.ts';
import { scanUntrusted as runScanUntrusted, wrapUntrusted as runWrapUntrusted } from './engine/injection-defense.ts';
import { buildKnowledgePack as runBuildPack } from './engine/offline-packs.ts';
import { SearchIntegrityEvents, SEARCH_INTEGRITY_EVENT_VERSION } from './events.ts';
import type {
  KnowledgePackRecord,
  SearchIntegrityStore,
} from './search-integrity-store.ts';

export interface SearchIntegrityDeps {
  readonly store: SearchIntegrityStore;
  readonly events: EventStore;
  readonly clock: Clock;
}

const refusal = (reason: string): AppError => new AppError(400, reason, reason);

/**
 * FORGE AI-067..072 (search integrity). The service keeps AI answers honest:
 * facts must be corroborated by distinct sources, quoting is capped by
 * license and word count, reference searches stay license-safe, cached
 * results carry a TTL and a token bucket, fetched content is fenced and
 * scanned for injection markers, and offline packs are built within a size
 * budget. Every refusal is named, never a silent guess.
 */
export class SearchIntegrityService {
  private readonly store: SearchIntegrityStore;
  private readonly events: EventStore;
  private readonly clock: Clock;

  constructor(deps: SearchIntegrityDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.clock = deps.clock;
  }

  private limitOf(limit: unknown): number {
    const raw = typeof limit === 'string' ? limit : typeof limit === 'number' ? String(limit) : undefined;
    const n = Number.parseInt(raw ?? '50', 10) || 50;
    return Math.min(Math.max(n, 1), 200);
  }

  private async emit(type: string, subjectId: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.append({
      type,
      version: SEARCH_INTEGRITY_EVENT_VERSION,
      actor: { kind: 'system', id: 'forge' },
      subject: { type: 'search_integrity', id: subjectId },
      payload,
    });
  }

  async listQuoteLicenses(): Promise<string[]> {
    return [...QUOTE_LICENSES];
  }

  async listReferenceMedia(): Promise<string[]> {
    return [...REFERENCE_MEDIA];
  }

  async listReferenceLicenses(): Promise<string[]> {
    return [...REFERENCE_LICENSES];
  }

  async separateFacts(body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runSeparateFacts({ statements: dto.statements });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'statements-refused');
    return { facts: verdict.facts ?? [], claims: verdict.claims ?? [], factCount: verdict.factCount ?? 0, claimCount: verdict.claimCount ?? 0 };
  }

  async planQuotes(body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runPlanQuotes({ license: dto.license, quotes: dto.quotes });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'quotes-refused');
    return { license: verdict.license ?? '', quotes: verdict.quotes ?? [], quotedWords: verdict.quotedWords ?? 0 };
  }

  async searchReferences(body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runSearchReferences({ query: dto.query, medium: dto.medium, license: dto.license });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'reference-refused');
    return { results: verdict.results ?? [] };
  }

  async checkRateLimit(body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runCheckRate({ elapsedMinutes: dto.elapsedMinutes });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'bucket-refused');
    return { allowed: verdict.allowed ?? false, tokens: verdict.tokens ?? 0, capacity: verdict.capacity ?? 0, refillPerMinute: verdict.refillPerMinute ?? 0 };
  }

  async putCacheEntry(userId: string, body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const keyVerdict = normalizeCacheKey(dto.key);
    if (!keyVerdict.ok) throw refusal(keyVerdict.reason ?? 'cache-refused');
    const key = keyVerdict.key ?? '';
    const ttlCheck = cacheState({
      now: 0,
      entry: { key, createdAt: 0, ttlSeconds: dto.ttlSeconds ?? DEFAULT_TTL, hitCount: 0 },
    });
    if (!ttlCheck.ok) throw refusal(ttlCheck.reason ?? 'cache-refused');
    const ttlSeconds = typeof dto.ttlSeconds === 'number' ? Math.floor(dto.ttlSeconds) : DEFAULT_TTL;
    const lane = typeof dto.lane === 'string' && dto.lane.trim().length > 0 ? dto.lane.trim().toLowerCase().slice(0, 64) : 'web';
    const payload = dto.payload === undefined || dto.payload === null ? [] : dto.payload;
    const now = this.clock();
    const existing = await this.store.findCacheEntry(userId, key);
    const saved = existing
      ? await this.store.saveCacheEntry({ ...existing, lane, payload, ttlSeconds, hitCount: 0, updatedAt: now })
      : await this.store.createCacheEntry({ userId, cacheKey: key, lane, payload, ttlSeconds, now });
    await this.emit(SearchIntegrityEvents.CacheStored, saved.id, { lane: saved.lane, reused: existing !== null });
    return { key: saved.cacheKey, state: 'stored', hitCount: 0 };
  }

  async getCacheEntry(userId: string, body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const keyVerdict = normalizeCacheKey(dto.key);
    if (!keyVerdict.ok) throw refusal(keyVerdict.reason ?? 'cache-refused');
    const key = keyVerdict.key ?? '';
    const record = await this.store.findCacheEntry(userId, key);
    if (!record) throw refusal('cache-entry-not-found:' + key);
    const nowSeconds = Math.floor(this.clock() / 1000);
    const createdSeconds = Math.floor(record.createdAt / 1000);
    const state = cacheState({
      now: nowSeconds,
      entry: { key, createdAt: createdSeconds, ttlSeconds: record.ttlSeconds, hitCount: record.hitCount },
    });
    if (!state.ok) throw refusal(state.reason ?? 'cache-refused');
    if (state.state === 'expired') throw refusal('cache-entry-expired:' + key);
    const saved = await this.store.saveCacheEntry({ ...record, hitCount: record.hitCount + 1, updatedAt: this.clock() });
    return { key: saved.cacheKey, state: state.state, ageSeconds: state.ageSeconds ?? 0, hitCount: saved.hitCount, payload: saved.payload };
  }

  async wrapFetchedContent(body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runWrapUntrusted({ content: dto.content });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'injection-refused');
    return { wrapped: verdict.wrapped ?? '' };
  }

  async scanFetchedContent(body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runScanUntrusted({ content: dto.content });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'injection-refused');
    return { clean: verdict.clean ?? true, quarantined: verdict.quarantined ?? false, findings: verdict.findings ?? [] };
  }

  async buildKnowledgePack(userId: string, body: unknown): Promise<KnowledgePackRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runBuildPack({ name: dto.name, topics: dto.topics, budgetKb: dto.budgetKb, articles: dto.articles });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'pack-refused');
    const record = await this.store.createPack({
      userId,
      name: verdict.name ?? '',
      topics: verdict.topics ?? [],
      sizeKb: verdict.sizeKb ?? 0,
      checksum: verdict.checksum ?? '',
      articles: verdict.articles ?? [],
      now: this.clock(),
    });
    await this.emit(SearchIntegrityEvents.PackBuilt, record.id, { topics: record.topics.length, sizeKb: record.sizeKb });
    return record;
  }

  async listKnowledgePacks(userId: string, limit: unknown): Promise<KnowledgePackRecord[]> {
    return this.store.listPacksByUser(userId, this.limitOf(limit));
  }

  async getKnowledgePack(userId: string, body: unknown): Promise<KnowledgePackRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const id = typeof dto.id === 'string' ? dto.id.trim() : '';
    const record = await this.store.findPackById(userId, id);
    if (!record) throw refusal('pack-not-found:' + id);
    return record;
  }
}
