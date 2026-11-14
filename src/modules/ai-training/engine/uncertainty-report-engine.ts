/**
 * AI-087 - uncertainty report: what the AI is unsure about, pure engine.
 * Catalog row: "Uncertainty report: what the AI is unsure about" - Plan from: Free,
 * Engine: General, no pass needed. The AI part draws free credits; the manual twin is
 * always free. An honest report names every area of doubt with a level; an empty list
 * is a CONFIDENT report, not an error - silence about doubt is never manufactured.
 * Deterministic and side-effect free.
 */

export const UNCERTAINTY_LEVELS = ['low', 'medium', 'high'] as const;
export type UncertaintyLevel = (typeof UNCERTAINTY_LEVELS)[number];

export interface UncertaintyItem {
  area: string;
  detail: string;
  level: UncertaintyLevel;
}

export interface UncertaintyReport {
  subjectId: string;
  summary: string;
  items: readonly UncertaintyItem[];
  overall: UncertaintyLevel | 'none';
  verdict: 'confident' | 'report';
  fingerprint: string;
}

export type UncertaintyResult<T> = { ok: true; value: T } | { ok: false, reason: string };

function localHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

const LEVEL_RANK: Record<UncertaintyLevel, number> = { low: 1, medium: 2, high: 3 };

export function buildUncertaintyReport(input: { subjectId: string; summary: unknown; items: unknown }): UncertaintyResult<UncertaintyReport> {
  const subjectId = typeof input.subjectId === 'string' ? input.subjectId.trim() : '';
  if (subjectId === '') return { ok: false, reason: 'uncertainty-no-subject-id' };
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary === '') return { ok: false, reason: 'uncertainty-no-summary' };
  if (!Array.isArray(input.items)) return { ok: false, reason: 'uncertainty-items-not-a-list' };
  const items: UncertaintyItem[] = [];
  for (let i = 0; i < input.items.length; i++) {
    const raw = input.items[i];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'uncertainty-item-invalid:' + String(i) };
    const rec = raw as Record<string, unknown>;
    const area = typeof rec.area === 'string' ? rec.area.trim() : '';
    if (area === '') return { ok: false, reason: 'uncertainty-no-area:' + String(i) };
    const detail = typeof rec.detail === 'string' ? rec.detail.trim() : '';
    if (detail === '') return { ok: false, reason: 'uncertainty-no-detail:' + String(i) };
    const level = rec.level;
    if (typeof level !== 'string' || !(UNCERTAINTY_LEVELS as readonly string[]).includes(level)) return { ok: false, reason: 'uncertainty-level-invalid:' + String(level) };
    items.push({ area, detail, level: level as UncertaintyLevel });
  }
  let overall: UncertaintyLevel | 'none' = 'none';
  for (const it of items) {
    if (overall === 'none' || LEVEL_RANK[it.level] > LEVEL_RANK[overall]) overall = it.level;
  }
  const verdict: 'confident' | 'report' = items.length === 0 ? 'confident' : 'report';
  return {
    ok: true,
    value: {
      subjectId,
      summary,
      items,
      overall,
      verdict,
      fingerprint: 'ur_' + localHash(subjectId + '\u0000' + summary + '\u0000' + items.map((it) => it.area + ':' + it.level + ':' + it.detail).join('|')),
    },
  };
}

