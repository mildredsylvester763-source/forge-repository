// Pure workspace content retrieval engine (FORGE AI-063). Retrieval runs over
// recorded workspace items from the five sources: code, docs, issues, chats,
// assets. Only items with a positive score are returned; an empty result is
// honest, never a refusal. Every refusal is named, never silent.

export const RETRIEVAL_SOURCES: string[] = ['code', 'docs', 'issues', 'chats', 'assets'];

export interface WorkspaceItem {
  id: string;
  source: string;
  title: string;
  body: string;
}

export interface RetrievalHit {
  id: string;
  source: string;
  title: string;
  score: number;
}

export interface RetrievalVerdict {
  ok: boolean;
  reason?: string;
  hits?: RetrievalHit[];
}

function normSource(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function searchWorkspaceContent(input: {
  items?: unknown;
  query?: unknown;
  sources?: unknown;
}): RetrievalVerdict {
  const query = typeof input?.query === 'string' ? input.query.trim().toLowerCase() : '';
  if (query.length === 0) {
    return { ok: false, reason: 'retrieval-query-missing' };
  }
  let allowed: string[] = [...RETRIEVAL_SOURCES];
  if (input?.sources !== undefined && input?.sources !== null) {
    if (!Array.isArray(input.sources)) {
      return { ok: false, reason: 'retrieval-sources-not-array' };
    }
    const seen = new Set<string>();
    for (const raw of input.sources) {
      const s = normSource(raw);
      if (!RETRIEVAL_SOURCES.includes(s)) {
        return {
          ok: false,
          reason:
            'retrieval-source-unknown:' +
            (typeof raw === 'string' ? raw.trim() : String(raw)),
        };
      }
      seen.add(s);
    }
    if (seen.size === 0) {
      return { ok: false, reason: 'retrieval-sources-empty' };
    }
    allowed = [...seen];
  }
  const items = Array.isArray(input?.items) ? (input.items as WorkspaceItem[]) : [];
  const terms = query.split(/\s+/).filter((t) => t.length > 0);
  const hits: RetrievalHit[] = [];
  for (const item of items) {
    const source = normSource(item?.source);
    if (!allowed.includes(source)) {
      continue;
    }
    const title = typeof item?.title === 'string' ? item.title.toLowerCase() : '';
    const body = typeof item?.body === 'string' ? item.body.toLowerCase() : '';
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) {
        score += 3;
      }
      if (body.includes(t)) {
        score += 1;
      }
    }
    if (score > 0) {
      hits.push({ id: item?.id ?? '', source, title: item?.title ?? '', score });
    }
  }
  hits.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ok: true, hits };
}
