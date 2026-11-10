import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../../kernel/sql.ts';
import type {
  KnowledgePackRecord,
  NewKnowledgePack,
  NewSearchCacheEntry,
  SearchCacheEntryRecord,
  SearchIntegrityStore,
} from './search-integrity-store.ts';

interface CacheRow {
  id: string;
  user_id: string;
  cache_key: string;
  lane: string;
  payload: string;
  ttl_seconds: string | number;
  hit_count: string | number;
  created_at: string | number;
  updated_at: string | number;
}

interface PackRow {
  id: string;
  user_id: string;
  name: string;
  topics: string;
  size_kb: string | number;
  checksum: string;
  articles: string;
  created_at: string | number;
}

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value));

const toCacheRecord = (r: CacheRow): SearchCacheEntryRecord => ({
  id: r.id,
  userId: r.user_id,
  cacheKey: r.cache_key,
  lane: r.lane,
  payload: JSON.parse(r.payload) as unknown,
  ttlSeconds: num(r.ttl_seconds),
  hitCount: num(r.hit_count),
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toPackRecord = (r: PackRow): KnowledgePackRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  topics: JSON.parse(r.topics) as string[],
  sizeKb: num(r.size_kb),
  checksum: r.checksum,
  articles: JSON.parse(r.articles) as unknown,
  createdAt: num(r.created_at),
});

export class PostgresSearchIntegrityStore implements SearchIntegrityStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async findCacheEntry(userId: string, cacheKey: string): Promise<SearchCacheEntryRecord | null> {
    const result = await this.pool.query<CacheRow>('SELECT * FROM search_cache_entries WHERE user_id = $1 AND cache_key = $2', [userId, cacheKey]);
    const row = result.rows[0];
    return row ? toCacheRecord(row) : null;
  }

  async createCacheEntry(entry: NewSearchCacheEntry): Promise<SearchCacheEntryRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO search_cache_entries (id, user_id, cache_key, lane, payload, ttl_seconds, hit_count, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [id, entry.userId, entry.cacheKey, entry.lane, JSON.stringify(entry.payload), entry.ttlSeconds, 0, entry.now, entry.now],
    );
    return { id, userId: entry.userId, cacheKey: entry.cacheKey, lane: entry.lane, payload: entry.payload, ttlSeconds: entry.ttlSeconds, hitCount: 0, createdAt: entry.now, updatedAt: entry.now };
  }

  async saveCacheEntry(entry: SearchCacheEntryRecord): Promise<SearchCacheEntryRecord> {
    await this.pool.query(
      'UPDATE search_cache_entries SET lane = $1, payload = $2, ttl_seconds = $3, hit_count = $4, updated_at = $5 WHERE id = $6',
      [entry.lane, JSON.stringify(entry.payload), entry.ttlSeconds, entry.hitCount, entry.updatedAt, entry.id],
    );
    return entry;
  }

  async createPack(pack: NewKnowledgePack): Promise<KnowledgePackRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO knowledge_packs (id, user_id, name, topics, size_kb, checksum, articles, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, pack.userId, pack.name, JSON.stringify(pack.topics), pack.sizeKb, pack.checksum, JSON.stringify(pack.articles), pack.now],
    );
    return { id, userId: pack.userId, name: pack.name, topics: pack.topics, sizeKb: pack.sizeKb, checksum: pack.checksum, articles: pack.articles, createdAt: pack.now };
  }

  async listPacksByUser(userId: string, take: number): Promise<KnowledgePackRecord[]> {
    const result = await this.pool.query<PackRow>(
      'SELECT * FROM knowledge_packs WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [userId, take],
    );
    return result.rows.map(toPackRecord);
  }

  async findPackById(userId: string, id: string): Promise<KnowledgePackRecord | null> {
    const result = await this.pool.query<PackRow>('SELECT * FROM knowledge_packs WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = result.rows[0];
    return row ? toPackRecord(row) : null;
  }
}
