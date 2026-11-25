// Pure offline knowledge pack engine for search integrity (FORGE AI-072).
// Market law (Kiwix ZIM, Zeal/Dash docsets): offline packs are curated
// topic sets within a size budget, with a checksum for integrity. This
// engine selects articles greedily in pack topic order (size desc, then
// title asc within a topic) under the budget, and derives a deterministic
// FNV-1a checksum over the ordered selected titles. Every refusal is named.

export const PACK_BUDGET_MIN = 1;
export const PACK_BUDGET_MAX = 200000;
export const PACK_BUDGET_DEFAULT = 10240;
export const PACK_ARTICLE_LIMIT = 200;

export interface PackArticleInput {
  title?: unknown;
  topic?: unknown;
  sizeKb?: unknown;
}

export interface SelectedArticle {
  title: string;
  topic: string;
  sizeKb: number;
}

export interface PackVerdict {
  ok: boolean;
  reason?: string;
  name?: string;
  topics?: string[];
  sizeKb?: number;
  checksum?: string;
  articles?: SelectedArticle[];
}

export function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function buildKnowledgePack(input: {
  name?: unknown;
  topics?: unknown;
  budgetKb?: unknown;
  articles?: unknown;
}): PackVerdict {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) {
    return { ok: false, reason: 'pack-name-missing' };
  }
  if (name.length > 200) {
    return { ok: false, reason: 'pack-name-too-long' };
  }
  const topicsRaw = Array.isArray(input?.topics) ? (input.topics as unknown[]) : [];
  if (topicsRaw.length === 0) {
    return { ok: false, reason: 'pack-topics-missing' };
  }
  const topics: string[] = [];
  for (const t of topicsRaw) {
    const s = typeof t === 'string' ? t.trim().toLowerCase() : '';
    if (s.length === 0) {
      return { ok: false, reason: 'pack-topic-blank' };
    }
    if (!topics.includes(s)) {
      topics.push(s);
    }
  }
  const budget =
    input?.budgetKb === undefined || input?.budgetKb === null
      ? PACK_BUDGET_DEFAULT
      : typeof input?.budgetKb === 'number'
        ? Math.floor(input.budgetKb)
        : -1;
  if (!Number.isFinite(budget) || budget < PACK_BUDGET_MIN || budget > PACK_BUDGET_MAX) {
    return { ok: false, reason: 'pack-budget-invalid:' + budget };
  }
  const list = Array.isArray(input?.articles) ? (input.articles as PackArticleInput[]) : [];
  if (list.length === 0) {
    return { ok: false, reason: 'pack-articles-empty' };
  }
  if (list.length > PACK_ARTICLE_LIMIT) {
    return { ok: false, reason: 'pack-articles-count-invalid:' + list.length };
  }
  const cleaned: SelectedArticle[] = [];
  for (const raw of list) {
    const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
    if (title.length === 0) {
      return { ok: false, reason: 'pack-article-title-missing' };
    }
    if (title.length > 300) {
      return { ok: false, reason: 'pack-article-title-too-long' };
    }
    const topic = typeof raw?.topic === 'string' ? raw.topic.trim().toLowerCase() : '';
    if (topic.length === 0) {
      return { ok: false, reason: 'pack-article-topic-missing' };
    }
    if (!topics.includes(topic)) {
      return { ok: false, reason: 'pack-article-topic-out-of-pack:' + topic };
    }
    const sizeKb = typeof raw?.sizeKb === 'number' ? Math.floor(raw.sizeKb) : -1;
    if (!Number.isFinite(sizeKb) || sizeKb < 1 || sizeKb > budget) {
      return { ok: false, reason: 'pack-article-size-invalid:' + sizeKb };
    }
    cleaned.push({ title, topic, sizeKb });
  }
  cleaned.sort((a, b) => {
    const ta = topics.indexOf(a.topic);
    const tb = topics.indexOf(b.topic);
    if (ta !== tb) {
      return ta - tb;
    }
    if (a.sizeKb !== b.sizeKb) {
      return b.sizeKb - a.sizeKb;
    }
    return a.title.localeCompare(b.title);
  });
  const selected: SelectedArticle[] = [];
  let used = 0;
  for (const art of cleaned) {
    if (used + art.sizeKb <= budget) {
      selected.push(art);
      used += art.sizeKb;
    }
  }
  if (selected.length === 0) {
    return { ok: false, reason: 'pack-articles-none-fit' };
  }
  const checksum = fnv1aHex(selected.map((a) => a.title).join('|'));
  return { ok: true, name, topics, sizeKb: used, checksum, articles: selected };
}
