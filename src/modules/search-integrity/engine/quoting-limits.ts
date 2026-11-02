// Pure copyright-safe quoting engine for search integrity (FORGE AI-068).
// Market law: the closer an AI output replicates its input, the more likely
// it infringes, so verbatim quoting is capped hard: at most 3 quotes per
// source, 50 words per quote, 100 quoted words total, and licenses that
// exclude AI use get no verbatim quoting at all. Every refusal is named.

export const QUOTE_WORD_LIMIT = 50;
export const QUOTE_COUNT_LIMIT = 3;
export const QUOTE_TOTAL_WORD_LIMIT = 100;
export const QUOTE_LICENSES = ['public-domain', 'cc0', 'cc-by', 'owned', 'no-ai'];

export interface PlannedQuote {
  text: string;
  words: number;
}

export interface QuotesVerdict {
  ok: boolean;
  reason?: string;
  license?: string;
  quotes?: PlannedQuote[];
  quotedWords?: number;
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => w.length > 0).length;
}

export function planQuotes(input: { license?: unknown; quotes?: unknown }): QuotesVerdict {
  const license = typeof input?.license === 'string' ? input.license.trim().toLowerCase() : '';
  if (license.length === 0) {
    return { ok: false, reason: 'quote-license-missing' };
  }
  if (!QUOTE_LICENSES.includes(license)) {
    return { ok: false, reason: 'quote-license-unknown:' + license };
  }
  const list = Array.isArray(input?.quotes) ? (input.quotes as unknown[]) : [];
  if (list.length === 0) {
    return { ok: false, reason: 'quotes-empty' };
  }
  if (license === 'no-ai') {
    return { ok: false, reason: 'quote-verbatim-forbidden:no-ai' };
  }
  if (list.length > QUOTE_COUNT_LIMIT) {
    return {
      ok: false,
      reason: 'quote-count-exceeded:' + list.length + ':' + QUOTE_COUNT_LIMIT,
    };
  }
  let total = 0;
  const planned: PlannedQuote[] = [];
  for (const raw of list) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text.length === 0) {
      return { ok: false, reason: 'quote-text-missing' };
    }
    const words = wordCount(text);
    if (words > QUOTE_WORD_LIMIT) {
      return { ok: false, reason: 'quote-too-long:' + words + ':' + QUOTE_WORD_LIMIT };
    }
    total += words;
    if (total > QUOTE_TOTAL_WORD_LIMIT) {
      return { ok: false, reason: 'quote-total-exceeded:' + total + ':' + QUOTE_TOTAL_WORD_LIMIT };
    }
    planned.push({ text, words });
  }
  return { ok: true, license, quotes: planned, quotedWords: total };
}
