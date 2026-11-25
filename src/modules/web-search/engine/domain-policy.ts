// Pure domain policy engine for the web search tool (FORGE AI-061).
// Allow and deny lists per workspace. Deny always wins over allow. An empty
// allow list means everything is allowed (subject to deny). A bare domain
// matches the host and any subdomain; a wildcard pattern matches subdomains
// only. Every refusal is named, never silent.

export interface DomainRules {
  allow: string[];
  deny: string[];
}

export interface DomainVerdict {
  ok: boolean;
  reason?: string;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function normalizeHost(input: string): string {
  if (typeof input !== 'string') return '';
  let host = input.trim().toLowerCase();
  const scheme = host.match(/^([a-z][a-z0-9+.-]*):\/\//);
  if (scheme) host = host.slice(scheme[0].length);
  const slash = host.indexOf('/');
  if (slash >= 0) host = host.slice(0, slash);
  const at = host.indexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

export function isValidDomainPattern(pattern: string): boolean {
  const p = normalizeHost(pattern);
  const bare = p.startsWith('*.') ? p.slice(2) : p;
  if (!HOST_RE.test(bare)) return false;
  if (bare.split('.').length < 2) return false;
  return true;
}

export function domainMatches(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const p = normalizeHost(pattern);
  if (!h || !p) return false;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h.endsWith('.' + base) && h !== base;
  }
  return h === p || h.endsWith('.' + p);
}

export function evaluateDomain(host: string, rules: DomainRules): DomainVerdict {
  const h = normalizeHost(host);
  if (!h) return { ok: false, reason: 'domain-empty-host' };
  if (!HOST_RE.test(h)) return { ok: false, reason: 'domain-invalid-host:' + h };
  const deny = Array.isArray(rules?.deny) ? rules.deny : [];
  const allow = Array.isArray(rules?.allow) ? rules.allow : [];
  for (const pattern of deny) {
    if (domainMatches(h, pattern)) return { ok: false, reason: 'domain-denied:' + h };
  }
  if (allow.length > 0) {
    const allowed = allow.some((pattern) => domainMatches(h, pattern));
    if (!allowed) return { ok: false, reason: 'domain-not-allowlisted:' + h };
  }
  return { ok: true };
}

export function validateRuleList(patterns: unknown): string | null {
  if (!Array.isArray(patterns)) return 'rules-not-a-list';
  const seen = new Set<string>();
  for (const raw of patterns) {
    if (typeof raw !== 'string') return 'rules-not-a-string:' + String(raw);
    const p = normalizeHost(raw);
    if (!p) return 'rules-empty-domain';
    if (!isValidDomainPattern(p)) return 'rules-invalid-domain:' + p;
    if (seen.has(p)) return 'rules-duplicate-domain:' + p;
    seen.add(p);
  }
  return null;
}

export function findOverlap(allow: string[], deny: string[]): string | null {
  const denySet = new Set(deny.map((d) => normalizeHost(d)));
  for (const a of allow) {
    const n = normalizeHost(a);
    if (denySet.has(n)) return n;
  }
  return null;
}
