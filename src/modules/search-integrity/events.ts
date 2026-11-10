/**
 * The search integrity module's published event contract (a small schema
 * registry). Other modules subscribe to these; they never reach into search
 * integrity internals. Payloads never contain quoted text, cached content or
 * article bodies: only counts and sizes survive the log by construction.
 */
export const SearchIntegrityEvents = {
  CacheStored: 'search_integrity.cache.stored',
  PackBuilt: 'search_integrity.pack.built',
} as const;

export type SearchIntegrityEventType = (typeof SearchIntegrityEvents)[keyof typeof SearchIntegrityEvents];

export const SEARCH_INTEGRITY_EVENT_VERSION = 1;
