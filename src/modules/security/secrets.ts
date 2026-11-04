import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fingerprintOf, type Finding, type Severity } from './findings.ts';
import type { SecurityPolicy } from './policy.ts';

/**
 * SC-006 and CG-088: finds credentials in code, logs, and anything else that is text.
 * Findings only ever carry a short redacted hint, never the full secret.
 */

const ALLOW_MARKER = 'forge:allow-secret';
const MAX_LINE = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next']);

const FIX =
  'Revoke it at the provider, create a new one, and keep the new one in your secret settings, never in code. ' +
  'Deleting it from the file is not enough: it stays in the history until it is revoked.';

export interface Rule {
  id: string;
  description: string;
  severity: Severity;
  regex: RegExp;
  /** Return false to reject a match (placeholders, local addresses, low-entropy text). */
  accept?: (match: RegExpExecArray) => boolean;
  /** Which capture group holds the secret itself (default: the whole match). */
  group?: number;
}

export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const PLACEHOLDER =
  /^(?:<.*>|\$\{.*\}|\$[A-Z_]+|%[A-Z_]+%|\{\{.*\}\}|\*+|x{4,}|\.{3,}|(?:your|my)[-_ ]|changeme|change[-_]me|example|placeholder|dummy|sample|todo|null|undefined|none|redacted|password|secret|process\.env)/i;

export const isPlaceholder = (value: string): boolean => PLACEHOLDER.test(value) || /replace[_-]?with/i.test(value);

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)$|(?:^|\.)(?:example\.(?:com|org|net)|test|invalid|local)$/i;

function charClasses(s: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
}

const looksSecret = (value: string): boolean => value.length >= 16 && !isPlaceholder(value) && shannonEntropy(value) >= 3.4 && charClasses(value) >= 2;

const RULES: Rule[] = [
  { id: 'private-key', description: 'A private key', severity: 'high', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'aws-access-key', description: 'An AWS access key ID', severity: 'high', regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', description: 'A GitHub token', severity: 'high', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { id: 'slack-token', description: 'A Slack token', severity: 'high', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'google-api-key', description: 'A Google API key', severity: 'high', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe-key', description: 'A live Stripe key', severity: 'high', regex: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g },
  { id: 'anthropic-key', description: 'An Anthropic API key', severity: 'high', regex: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g },
  { id: 'openai-key', description: 'An OpenAI-style API key', severity: 'high', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { id: 'forge-token', description: 'A FORGE personal API token', severity: 'high', regex: /\bfrg_[A-Za-z0-9_-]{43}\b/g },
  {
    id: 'database-url-password',
    description: 'A database address that contains a password',
    severity: 'high',
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s:@/]+:([^\s@/]{3,})@([^\s/:?]+)/g,
    group: 1,
    accept: (m) => !isPlaceholder(m[1] ?? '') && !LOCAL_HOST.test(m[2] ?? ''),
  },
  { id: 'json-web-token', description: 'A JSON Web Token', severity: 'medium', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    id: 'secret-assignment',
    description: 'A value assigned to something named like a secret',
    severity: 'medium',
    regex: /(?:secret|passw(?:or)?d|token|pepper|credential|api[_-]?key|private[_-]?key|auth[_-]?key|audit[_-]?key|signing[_-]?key|encryption[_-]?key|access[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*["']([^"'\s]{16,})["']/gi,
    group: 1,
    accept: (m) => looksSecret(m[1] ?? ''),
  },
  {
    id: 'secret-env-line',
    description: 'A secret-looking value on an environment-style line',
    severity: 'medium',
    regex: /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|PEPPER|CREDENTIAL|API_?KEY|PRIVATE_KEY|AUDIT_KEY|SIGNING_KEY|ENCRYPTION_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*([^\s#"']{16,})\s*$/g,
    group: 1,
    accept: (m) => looksSecret(m[1] ?? ''),
  },
];

/** Turns the policy's custom rules into scanner rules. */
export function compileCustomRules(custom: SecurityPolicy['secrets']['customRules']): Rule[] {
  return custom.map((c) => ({ id: c.id, description: c.description, severity: c.severity, regex: new RegExp(c.pattern, 'g') }));
}

const hint = (secret: string): string => `${secret.slice(0, 4)}… (${secret.length} characters, redacted)`;

/** Scans text and returns findings with 1-based line numbers. A line containing "forge:allow-secret" is skipped. */
export function scanText(text: string, file: string, extraRules: readonly Rule[] = []): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    if (rawLine.includes(ALLOW_MARKER)) return;
    const line = rawLine.length > MAX_LINE ? rawLine.slice(0, MAX_LINE) : rawLine;
    const covered: Array<[number, number]> = [];
    for (const rule of [...RULES, ...extraRules]) {
      rule.regex.lastIndex = 0;
      for (const m of line.matchAll(rule.regex)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (covered.some(([a, b]) => start < b && end > a)) continue; // a more specific rule already reported this
        if (rule.accept && !rule.accept(m as RegExpExecArray)) continue;
        covered.push([start, end]);
        const secret = (rule.group !== undefined ? m[rule.group] : m[0]) ?? m[0];
        findings.push({
          check: 'secret',
          ruleId: rule.id,
          severity: rule.severity,
          message: `${rule.description} appears to be in this file.`,
          file,
          line: i + 1,
          detail: hint(secret),
          fingerprint: fingerprintOf(rule.id, file, secret),
          fix: FIX,
        });
      }
    }
  });
  return findings;
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** Scans one file. Skips binary and very large files. */
export function scanFile(absolutePath: string, displayPath: string, extraRules: readonly Rule[] = []): Finding[] {
  const size = statSync(absolutePath).size;
  if (size > MAX_FILE_BYTES) return [];
  const buf = readFileSync(absolutePath);
  if (looksBinary(buf)) return [];
  return scanText(buf.toString('utf8'), displayPath, extraRules);
}

export interface DirectoryScan {
  filesScanned: number;
  findings: Finding[];
}

/** Walks a folder (not following links), skipping .git, node_modules, build output and the policy's ignored paths. */
export function scanDirectory(root: string, policy: SecurityPolicy): DirectoryScan {
  const findings: Finding[] = [];
  let filesScanned = 0;
  const ignored = policy.secrets.ignorePaths;
  const extra = compileCustomRules(policy.secrets.customRules);

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split('\\').join('/');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || ignored.some((p) => `${rel}/`.startsWith(p))) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (ignored.some((p) => rel.startsWith(p))) continue;
        filesScanned += 1;
        findings.push(...scanFile(full, rel, extra));
      }
    }
  };
  walk(root);
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  return { filesScanned, findings };
}
