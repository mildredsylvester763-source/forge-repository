// Pure intent classification engine for the orchestrator (FORGE AI-073).
// Market law (helpdesk triage, Dialogflow and Rasa intent routing): incoming
// requests are scored against a fixed intent catalog by word-boundary keyword
// rules, the best intent wins with ties broken in catalog order, confidence
// is the share of all keyword hits owned by the winner, and unroutable text
// is a named no-match instead of a silent guess. An optional allowlist
// restricts routing to approved intents. Every refusal is named.

export const INTENTS = [
  'question',
  'command',
  'creation',
  'analysis',
  'comparison',
  'conversation',
];

export const INTENT_RULES: Record<string, string[]> = {
  question: ['what', 'why', 'how', 'when', 'where', 'who', 'which', '?'],
  command: [
    'fix',
    'add',
    'delete',
    'update',
    'deploy',
    'run',
    'make',
    'set up',
    'configure',
    'install',
  ],
  creation: ['write', 'draft', 'design', 'compose', 'build', 'generate', 'create'],
  analysis: ['analyze', 'review', 'audit', 'explain', 'summarize', 'evaluate'],
  comparison: ['compare', 'versus', 'vs', 'difference', 'better', 'pros and cons'],
  conversation: ['hi', 'hello', 'thanks', 'thank you', 'good morning', 'hey'],
};

export const INTENT_TEXT_LIMIT = 2000;

export interface IntentVerdict {
  ok: boolean;
  reason?: string;
  intent?: string;
  score?: number;
  confidence?: number;
}

function countKeyword(text: string, keyword: string): number {
  if (keyword === '?') {
    let n = 0;
    for (const ch of text) {
      if (ch === '?') n++;
    }
    return n;
  }
  const pattern = keyword.includes(' ') ? keyword.split(' ').join('\\s+') : keyword;
  const re = new RegExp('\\b' + pattern + '\\b', 'gi');
  return (text.match(re) || []).length;
}

export function classifyIntent(input: { text?: unknown; allowed?: unknown }): IntentVerdict {
  const raw = input && typeof input === 'object' ? input.text : undefined;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return { ok: false, reason: 'intent-text-missing' };
  }
  if (text.length > INTENT_TEXT_LIMIT) {
    return { ok: false, reason: 'intent-text-too-long' };
  }
  let allowNormalized: string[] | undefined;
  if (input && typeof input === 'object' && input.allowed !== undefined) {
    if (!Array.isArray(input.allowed)) {
      return { ok: false, reason: 'intent-allowlist-invalid' };
    }
    allowNormalized = [];
    for (const a of input.allowed as unknown[]) {
      const entry = typeof a === 'string' ? a.trim().toLowerCase() : String(a);
      if (!INTENTS.includes(entry)) {
        return { ok: false, reason: 'intent-allowlist-unknown:' + entry };
      }
      allowNormalized.push(entry);
    }
  }
  const scores: Record<string, number> = {};
  let total = 0;
  for (const intent of INTENTS) {
    let s = 0;
    for (const kw of INTENT_RULES[intent] ?? []) {
      s += countKeyword(text, kw);
    }
    scores[intent] = s;
    total += s;
  }
  let best = '';
  for (const intent of INTENTS) {
    if (best === '' || scores[intent]! > scores[best]!) best = intent;
  }
  if (scores[best]! === 0) {
    return { ok: false, reason: 'intent-no-match' };
  }
  if (allowNormalized && !allowNormalized.includes(best)) {
    return { ok: false, reason: 'intent-not-allowed:' + best };
  }
  return {
    ok: true,
    intent: best,
    score: scores[best]!,
    confidence: Number((scores[best]! / total).toFixed(2)),
  };
}
