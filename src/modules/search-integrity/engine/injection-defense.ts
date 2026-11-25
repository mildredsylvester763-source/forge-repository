// Pure prompt-injection defense engine for search integrity (FORGE AI-071).
// Market law (OWASP LLM01): separate and clearly denote untrusted content.
// This engine wraps fetched content in explicit UNTRUSTED fences and scans
// it for known injection markers (case-insensitive), including fence
// smuggling attempts. Scanning is a tripwire, not a security boundary; every
// finding is reported by marker and index. Every refusal is named.

export const UNTRUSTED_OPEN = '<<UNTRUSTED-FETCHED-CONTENT>>';
export const UNTRUSTED_CLOSE = '<<END-UNTRUSTED-CONTENT>>';

export const INJECTION_MARKERS = [
  'ignore previous instructions',
  'disregard all previous',
  'forget your instructions',
  'reveal your system prompt',
  'you are now a',
  'new instructions:',
  UNTRUSTED_OPEN,
];

export interface WrapVerdict {
  ok: boolean;
  reason?: string;
  wrapped?: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function wrapUntrusted(input: { content?: unknown }): WrapVerdict {
  const content = typeof input?.content === 'string' ? input.content : '';
  if (content.trim().length === 0) {
    return { ok: false, reason: 'injection-content-missing' };
  }
  const inner =
    content.includes(UNTRUSTED_OPEN) || content.includes(UNTRUSTED_CLOSE)
      ? content
          .replace(new RegExp(escapeRe(UNTRUSTED_OPEN), 'g'), '')
          .replace(new RegExp(escapeRe(UNTRUSTED_CLOSE), 'g'), '')
      : content;
  return { ok: true, wrapped: UNTRUSTED_OPEN + '\n' + inner + '\n' + UNTRUSTED_CLOSE };
}

export interface InjectionFinding {
  marker: string;
  index: number;
}

export interface ScanVerdict {
  ok: boolean;
  reason?: string;
  clean?: boolean;
  quarantined?: boolean;
  findings?: InjectionFinding[];
}

export function scanUntrusted(input: { content?: unknown }): ScanVerdict {
  const content = typeof input?.content === 'string' ? input.content : '';
  if (content.trim().length === 0) {
    return { ok: false, reason: 'injection-content-missing' };
  }
  const lower = content.toLowerCase();
  const findings: InjectionFinding[] = [];
  for (const marker of INJECTION_MARKERS) {
    // The fence marker carries uppercase letters while the content is matched
    // lowercased, so every marker is lowercased before matching. Findings
    // still report the marker exactly as published.
    const needle = marker.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(needle, from);
      if (idx < 0) {
        break;
      }
      findings.push({ marker, index: idx });
      from = idx + needle.length;
    }
  }
  findings.sort((a, b) => a.index - b.index || a.marker.localeCompare(b.marker));
  return {
    ok: true,
    clean: findings.length === 0,
    quarantined: findings.length > 0,
    findings,
  };
}
