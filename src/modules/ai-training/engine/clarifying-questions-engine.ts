/**
 * AI-088 - clarifying questions only when intent is truly ambiguous, pure engine.
 * Catalog row: "Clarifying questions only when intent is truly ambiguous" - Plan from:
 * Free, Engine: General, no pass needed. The law: a question may only be asked when it
 * anchors to a NAMED ambiguity; a clear intent is never interrogated. Deterministic and
 * side-effect free.
 */

export const AMBIGUITY_KINDS = ['missing-input', 'conflicting-constraint', 'multiple-interpretations', 'unknown-scope'] as const;
export type AmbiguityKind = (typeof AMBIGUITY_KINDS)[number];

export interface AmbiguitySignal {
  id: string;
  kind: AmbiguityKind;
  description: string;
}

export interface ClarifyingQuestion {
  text: string;
  anchors: readonly string[];
}

export interface ClarificationDecision {
  intent: string;
  needed: boolean;
  reason: 'intent-clear' | 'intent-ambiguous';
  signals: readonly AmbiguitySignal[];
  questions: readonly ClarifyingQuestion[];
  issues: readonly string[];
  fingerprint: string;
}

export type ClarifyResult<T> = { ok: true; value: T } | { ok: false, reason: string };

function localHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export function decideClarification(input: { intent: unknown; signals: unknown; questions: unknown }): ClarifyResult<ClarificationDecision> {
  const intent = typeof input.intent === 'string' ? input.intent.trim() : '';
  if (intent === '') return { ok: false, reason: 'clarify-no-intent' };
  if (!Array.isArray(input.signals)) return { ok: false, reason: 'clarify-signals-not-a-list' };
  const signals: AmbiguitySignal[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < input.signals.length; i++) {
    const raw = input.signals[i];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'clarify-signal-invalid:' + String(i) };
    const rec = raw as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    if (id === '') return { ok: false, reason: 'clarify-signal-no-id:' + String(i) };
    if (ids.has(id)) return { ok: false, reason: 'clarify-signal-duplicate:' + id };
    const kind = rec.kind;
    if (typeof kind !== 'string' || !(AMBIGUITY_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: 'clarify-kind-invalid:' + String(kind) };
    const description = typeof rec.description === 'string' ? rec.description.trim() : '';
    if (description === '') return { ok: false, reason: 'clarify-signal-no-description:' + id };
    ids.add(id);
    signals.push({ id, kind: kind as AmbiguityKind, description });
  }
  if (!Array.isArray(input.questions)) return { ok: false, reason: 'clarify-questions-not-a-list' };
  const questions: ClarifyingQuestion[] = [];
  for (let i = 0; i < input.questions.length; i++) {
    const raw = input.questions[i];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'clarify-question-invalid:' + String(i) };
    const rec = raw as Record<string, unknown>;
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    if (text === '') return { ok: false, reason: 'clarify-question-no-text:' + String(i) };
    if (!Array.isArray(rec.anchors) || rec.anchors.length === 0) return { ok: false, reason: 'clarify-question-unanchored:' + String(i) };
    const anchors: string[] = [];
    for (const a of rec.anchors) {
      if (typeof a !== 'string' || a.trim() === '') return { ok: false, reason: 'clarify-anchor-invalid:' + String(i) };
      if (!ids.has(a.trim())) return { ok: false, reason: 'clarify-anchor-unknown:' + a.trim() };
      anchors.push(a.trim());
    }
    questions.push({ text, anchors });
  }
  const needed = signals.length > 0;
  // the law: questions ONLY when the intent is truly ambiguous
  if (!needed && questions.length > 0) return { ok: false, reason: 'clarify-no-ambiguity' };
  const issues: string[] = [];
  if (needed && questions.length === 0) issues.push('no-questions-drafted');
  return {
    ok: true,
    value: {
      intent,
      needed,
      reason: needed ? 'intent-ambiguous' : 'intent-clear',
      signals,
      questions,
      issues,
      fingerprint: 'cq_' + localHash(intent + '\u0000' + signals.map((s) => s.id + ':' + s.kind).join('|') + '\u0000' + questions.map((q) => q.text + '>' + q.anchors.join('+')).join('|')),
    },
  };
}

