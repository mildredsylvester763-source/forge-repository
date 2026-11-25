/**
 * The web search module's published event contract (a small schema registry).
 * Other modules subscribe to these; they never reach into web search internals.
 * Payloads never contain query text, page content, claims or quotes: only
 * counts, domains and flags survive the log by construction.
 */
export const WebSearchEvents = {
  QueryRecorded: 'web_search.query.recorded',
  PageFetched: 'web_search.page.fetched',
  CitationCreated: 'web_search.citation.created',
  RulesChanged: 'web_search.rules.changed',
} as const;

export type WebSearchEventType = (typeof WebSearchEvents)[keyof typeof WebSearchEvents];
export const WEB_SEARCH_EVENT_VERSION = 1;
