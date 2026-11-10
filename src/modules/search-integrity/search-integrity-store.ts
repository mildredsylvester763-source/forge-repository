import { randomUUID } from 'node:crypto';

export interface SearchCacheEntryRecord {
  readonly id: string;
  readonly userId: string;
  readonly cacheKey: string;
  readonly lane: string;
  readonly payload: unknown;
  readonly ttlSeconds: number;
  readonly hitCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewSearchCacheEntry {
  userId: string;
  cacheKey: string;
  lane: string;
  payload: unknown;
  ttlSeconds: number;
  now: number;
}

export interface KnowledgePackRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly topics: string[];
  readonly sizeKb: number;
  readonly checksum: string;
  readonly articles: unknown;
  readonly createdAt: number;
}

export interface NewKnowledgePack {
  userId: string;
  name: string;
  topics: string[];
  sizeKb: number;
  checksum: string;
  articles: unknown;
  now: number;
}

/**
 * The search integrity module's storage contract: cached search payloads with
 * per-key TTL and hit counts, and built offline knowledge packs. SQLite and
 * PostgreSQL adapters sit behind the same interface.
 */
export interface SearchIntegrityStore {
  findCacheEntry(userId: string, cacheKey: string): Promise<SearchCacheEntryRecord | null>;
  createCacheEntry(entry: NewSearchCacheEntry): Promise<SearchCacheEntryRecord>;
  saveCacheEntry(entry: SearchCacheEntryRecord): Promise<SearchCacheEntryRecord>;
  createPack(pack: NewKnowledgePack): Promise<KnowledgePackRecord>;
  listPacksByUser(userId: string, take: number): Promise<KnowledgePackRecord[]>;
  findPackById(userId: string, id: string): Promise<KnowledgePackRecord | null>;
}

/** Development and test store. */
export class InMemorySearchIntegrityStore implements SearchIntegrityStore {
  private readonly cacheByUser = new Map<string, SearchCacheEntryRecord[]>();
  private readonly packsByUser = new Map<string, KnowledgePackRecord[]>();

  async findCacheEntry(userId: string, cacheKey: string): Promise<SearchCacheEntryRecord | null> {
    const list = this.cacheByUser.get(userId) ?? [];
    return list.find((entry) => entry.cacheKey === cacheKey) ?? null;
  }

  async createCacheEntry(entry: NewSearchCacheEntry): Promise<SearchCacheEntryRecord> {
    const record: SearchCacheEntryRecord = {
      id: randomUUID(),
      userId: entry.userId,
      cacheKey: entry.cacheKey,
      lane: entry.lane,
      payload: entry.payload,
      ttlSeconds: entry.ttlSeconds,
      hitCount: 0,
      createdAt: entry.now,
      updatedAt: entry.now,
    };
    this.cacheByUser.set(entry.userId, [record, ...(this.cacheByUser.get(entry.userId) ?? [])]);
    return record;
  }

  async saveCacheEntry(entry: SearchCacheEntryRecord): Promise<SearchCacheEntryRecord> {
    const list = this.cacheByUser.get(entry.userId) ?? [];
    const idx = list.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      list[idx] = entry;
      this.cacheByUser.set(entry.userId, list);
    }
    return entry;
  }

  async createPack(pack: NewKnowledgePack): Promise<KnowledgePackRecord> {
    const record: KnowledgePackRecord = {
      id: randomUUID(),
      userId: pack.userId,
      name: pack.name,
      topics: pack.topics,
      sizeKb: pack.sizeKb,
      checksum: pack.checksum,
      articles: pack.articles,
      createdAt: pack.now,
    };
    const list = this.packsByUser.get(pack.userId) ?? [];
    list.unshift(record);
    this.packsByUser.set(pack.userId, list);
    return record;
  }

  async listPacksByUser(userId: string, take: number): Promise<KnowledgePackRecord[]> {
    return (this.packsByUser.get(userId) ?? []).slice(0, take);
  }

  async findPackById(userId: string, id: string): Promise<KnowledgePackRecord | null> {
    const list = this.packsByUser.get(userId) ?? [];
    return list.find((pack) => pack.id === id) ?? null;
  }
}
