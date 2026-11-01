// Pure page extraction engine for the web search tool (FORGE AI-058).
// Strips scripts, styles, comments, and navigation boilerplate, extracts the
// title, an optional publish date (time element or published-time meta), and
// clean readable text with an exact word count. Refusals are named.

export interface ExtractedPage {
  title: string | null;
  text: string;
  wordCount: number;
  publishedAt: string | null;
}

export type ExtractVerdict =
  | { ok: true; page: ExtractedPage }
  | { ok: false; reason: string };

function stripBlocks(html: string, tag: string): string {
  const re = new RegExp(
    '<' + tag + '(\\s[^>]*)?>[\\s\\S]*?</' + tag + '\\s*>',
    'gi',
  );
  return html.replace(re, ' ');
}

export function extractPage(html: string): ExtractVerdict {
  if (typeof html !== 'string' || html.trim().length === 0) {
    return { ok: false, reason: 'extract-empty-html' };
  }
  let cleaned = html;
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form']) {
    cleaned = stripBlocks(cleaned, tag);
  }

  const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 500) || null
    : null;
  cleaned = stripBlocks(cleaned, 'title');

  let publishedAt: string | null = null;
  const timeMatch = cleaned.match(/<time[^>]*\sdatetime="([^"]+)"/i);
  const metaMatch =
    cleaned.match(/<meta[^>]*property="article:published_time"[^>]*content="([^"]+)"/i) ||
    cleaned.match(/<meta[^>]*name="date"[^>]*content="([^"]+)"/i);
  const candidate = timeMatch ? timeMatch[1] : metaMatch ? metaMatch[1] : null;
  if (candidate && /^\d{4}-\d{2}-\d{2}/.test(candidate.trim())) {
    const ts = Date.parse(candidate.trim());
    if (Number.isFinite(ts)) publishedAt = new Date(ts).toISOString();
  }

  const text = cleaned
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  const wordCount = text.split(' ').filter((w) => w.length > 0).length;

  if (wordCount < 10) return { ok: false, reason: 'extract-no-readable-text' };

  return {
    ok: true,
    page: { title, text: text.slice(0, 200000), wordCount, publishedAt },
  };
}
