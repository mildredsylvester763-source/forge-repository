// Pure fact-claims separation engine for search integrity (FORGE AI-067).
// A statement corroborated by two or more DISTINCT sources is a FACT; a
// statement backed by only one source stays a CLAIM. This is what grounding
// means in the market: the same fact, independently reported. Repeated
// sources never fake corroboration. Every refusal is named, never silent.

export interface StatementInput {
  text?: unknown;
  sourceIds?: unknown;
}

export interface StatementVerdict {
  text: string;
  sources: string[];
  kind: 'fact' | 'claim';
}

export interface FactsVerdict {
  ok: boolean;
  reason?: string;
  facts?: StatementVerdict[];
  claims?: StatementVerdict[];
  factCount?: number;
  claimCount?: number;
}

export const STATEMENT_LIMIT = 200;

export function separateFacts(input: { statements?: unknown }): FactsVerdict {
  const list = Array.isArray(input?.statements) ? (input.statements as StatementInput[]) : [];
  if (list.length === 0) {
    return { ok: false, reason: 'statements-empty' };
  }
  if (list.length > STATEMENT_LIMIT) {
    return { ok: false, reason: 'statements-count-invalid:' + list.length };
  }
  const facts: StatementVerdict[] = [];
  const claims: StatementVerdict[] = [];
  for (const raw of list) {
    const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
    if (text.length === 0) {
      return { ok: false, reason: 'statement-text-missing' };
    }
    if (!Array.isArray(raw?.sourceIds)) {
      return { ok: false, reason: 'statement-sources-missing' };
    }
    const sources: string[] = [];
    for (const sid of raw.sourceIds as unknown[]) {
      const s = typeof sid === 'string' ? sid.trim() : '';
      if (s.length === 0) {
        return { ok: false, reason: 'statement-source-blank' };
      }
      if (!sources.includes(s)) {
        sources.push(s);
      }
    }
    if (sources.length === 0) {
      return { ok: false, reason: 'statement-sources-missing' };
    }
    const verdict: StatementVerdict = {
      text,
      sources,
      kind: sources.length >= 2 ? 'fact' : 'claim',
    };
    if (verdict.kind === 'fact') {
      facts.push(verdict);
    } else {
      claims.push(verdict);
    }
  }
  return { ok: true, facts, claims, factCount: facts.length, claimCount: claims.length };
}
