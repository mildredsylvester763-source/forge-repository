/**
 * AI-086 - self-critique pass before presenting results, pure engine.
 * Catalog row: "Self-critique pass before presenting results" - Plan from: Free,
 * Engine: General, no pass needed. A result is never presented without a critique
 * pass: every item is validated by name, and a result that names no caveat and no
 * uncertainty is sent back for revision, not presented. Deterministic and
 * side-effect free.
 */

export const CRITIQUE_ITEM_KINDS = ['fact', 'caveat', 'uncertainty', 'action'] as const;
export type CritiqueItemKind = (typeof CRITIQUE_ITEM_KINDS)[number];

export interface CritiqueItem {
  kind: CritiqueItemKind;
  text: string;
}

export interface CritiqueReport {
  resultId: string;
  summary: string;
  items: readonly CritiqueItem[];
  issues: readonly string[];
  verdict: 'present' | 'revise';
  fingerprint: string;
}

export type CritiqueResult<T> = { ok: true; value: T } | { ok: false, reason: string };

function localHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export function runSelfCritique(input: { resultId: string; summary: unknown; items: unknown }): CritiqueResult<CritiqueReport> {
  const resultId = typeof input.resultId === 'string' ? input.resultId.trim() : '';
  if (resultId === '') return { ok: false, reason: 'critique-no-result-id' };
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary === '') return { ok: false, reason: 'critique-no-summary' };
  if (!Array.isArray(input.items) || input.items.length === 0) return { ok: false, reason: 'critique-no-items' };
  const items: CritiqueItem[] = [];
  const issues: string[] = [];
  let honest = false;
  for (let i = 0; i < input.items.length; i++) {
    const raw = input.items[i];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'critique-item-invalid:' + String(i) };
    const rec = raw as Record<string, unknown>;
    const kind = rec.kind;
    if (typeof kind !== 'string' || !(CRITIQUE_ITEM_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: 'critique-kind-invalid:' + String(kind) };
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    if (text === '') return { ok: false, reason: 'critique-empty-text:' + String(i) };
    items.push({ kind: kind as CritiqueItemKind, text });
    if (kind === 'caveat' || kind === 'uncertainty') honest = true;
  }
  if (!honest) issues.push('no-caveat-or-uncertainty');
  const verdict: 'present' | 'revise' = honest ? 'present' : 'revise';
  return {
    ok: true,
    value: {
      resultId,
      summary,
      items,
      issues,
      verdict,
      fingerprint: 'sc_' + localHash(resultId + '\u0000' + summary + '\u0000' + items.map((it) => it.kind + ':' + it.text).join('|')),
    },
  };
}
