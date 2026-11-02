import { randomUUID } from 'node:crypto';
import { transaction, type Database } from '../../kernel/sqlite.ts';
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
  ttl_seconds: number;
  hit_count: number;
  created_at: number;
  updated_at: number;
}

interface PackRow {
  id: string;
  user_id: string;
  name: string;
  topics: string;
  size_kb: number;
  checksum: string;
  articles: string;
  created_at: number;
}

const toCacheRecord = (r: CacheRow): SearchCacheEntryRecord => ({
  id: r.id,
  userId: r.user_id,
  cacheKey: r.cache_key,
  lane: r.lane,
  payload: JSON.parse(r.payload) as unknown,
  ttlSeconds: r.ttl_seconds,
  hitCount: r.hit_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toPackRecord = (r: PackRow): KnowledgePackRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  topics: JSON.parse(r.topics) as string[],
  sizeKb: r.size_kb,
  checksum: r.checksum,
  articles: JSON.parse(r.articles) as unknown,
  createdAt: r.created_at,
});

export class SqliteSearchIntegrityStore implements SearchIntegrityStore {
  private readonly db: Database;
  private readonly findCacheStmt;
  private readonly insertCache;
  private readonly updateCache;
  private readonly insertPack;
  private readonly packsByUser;
  private readonly findPackStmt;

  constructor(db: Database) {
    this.db = db;
    this.findCacheStmt = db.prepare('SELECT * FROM search_cache_entries WHERE user_id = ? AND cache_key = ?');
    this.insertCache = db.prepare('INSERT INTO search_cache_entries (id, user_id, cache_key, lane, payload, ttl_seconds, hit_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.updateCache = db.prepare('UPDATE search_cache_entries SET lane = ?, payload = ?, ttl_seconds = ?, hit_count = ?, updated_at = ? WHERE id = ?');
    this.insertPack = db.prepare('INSERT INTO knowledge_packs (id, user_id, name, topics, size_kb, checksum, articles, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.packsByUser = db.prepare('SELECT * FROM knowledge_packs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.findPackStmt = db.prepare('SELECT * FROM knowledge_packs WHERE user_id = ? AND id = ?');
  }

  async findCacheEntry(userId: string, cacheKey: string): Promise<SearchCacheEntryRecord | null> {
    const row = this.findCacheStmt.get(userId, cacheKey) as unknown as CacheRow | undefined;
    return row ? toCacheRecord(row) : null;
  }

  async createCacheEntry(entry: NewSearchCacheEntry): Promise<SearchCacheEntryRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertCache.run(id, entry.userId, entry.cacheKey, entry.lane, JSON.stringify(entry.payload), entry.ttlSeconds, 0, entry.now, entry.now);
      return { id, userId: entry.userId, cacheKey: entry.cacheKey, lane: entry.lane, payload: entry.payload, ttlSeconds: entry.ttlSeconds, hitCount: 0, createdAt: entry.now, updatedAt: entry.now };
    });
  }

  async saveCacheEntry(entry: SearchCacheEntryRecord): Promise<SearchCacheEntryRecord> {
    return transaction(this.db, () => {
      this.updateCache.run(entry.lane, JSON.stringify(entry.payload), entry.ttlSeconds, entry.hitCount, entry.updatedAt, entry.id);
      return entry;
    });
  }

  async createPack(pack: NewKnowledgePack): Promise<KnowledgePackRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertPack.run(id, pack.userId, pack.name, JSON.stringify(pack.topics), pack.sizeKb, pack.checksum, JSON.stringify(pack.articles), pack.now);
      return { id, userId: pack.userId, name: pack.name, topics: pack.topics, sizeKb: pack.sizeKb, checksum: pack.checksum, articles: pack.articles, createdAt: pack.now };
    });
  }

  async listPacksByUser(userId: string, take: number): Promise<KnowledgePackRecord[]> {
    const rows = this.packsByUser.all(userId, take) as unknown as PackRow[];
    return rows.map(toPackRecord);
  }

  async findPackById(userId: string, id: string): Promise<KnowledgePackRecord | null> {
    const row = this.findPackStmt.get(userId, id) as unknown as PackRow | undefined;
    return row ? toPackRecord(row) : null;
  }
}
