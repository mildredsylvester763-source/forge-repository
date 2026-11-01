// Pure citation engine for the web search tool (FORGE AI-059). Every
// web-derived claim must link to an https source. Claims are whitespace
// normalized so the same claim bound to the same source is idempotent.
// Refusals are named, never silent.

export interface CitationSource {
  url: string;
  host: string;
}

export type CitationVerdict =
  | { ok: true; claim: string; source: CitationSource }
  | { ok: false; reason: string };

export function normalizeClaim(claim: unknown): string {
  if (typeof claim !== 'string') return '';
  return claim.replace(/\s+/g, ' ').trim();
}

export function parseSourceUrl(
  url: string,
): { ok: true; source: CitationSource } | { ok: false; reason: string } {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return { ok: false, reason: 'citation-missing-source' };
  }
  const trimmed = url.trim();
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!schemeMatch) return { ok: false, reason: 'citation-missing-scheme' };
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme !== 'https') {
    return { ok: false, reason: 'citation-insecure-scheme:' + scheme };
  }
  const afterScheme = trimmed.slice(schemeMatch[0].length);
  const hostPart = afterScheme.split('/')[0].split('@').pop() ?? '';
  const host = hostPart.split(':')[0].toLowerCase();
  if (!host) return { ok: false, reason: 'citation-missing-host' };
  return { ok: true, source: { url: trimmed, host } };
}

export function validateCitation(claim: unknown, sourceUrl: string): CitationVerdict {
  const normalized = normalizeClaim(claim);
  if (normalized.length === 0) return { ok: false, reason: 'citation-empty-claim' };
  if (normalized.length < 3) return { ok: false, reason: 'citation-too-short' };
  const source = parseSourceUrl(sourceUrl);
  if (!source.ok) return { ok: false, reason: source.reason };
  return { ok: true, claim: normalized, source: source.source };
}
