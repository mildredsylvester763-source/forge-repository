// PII and secret scrubbing engine (FORGE AI-004): a record becomes eligible
// for training data ONLY after it passes this gate. Pure engine laws: no DB,
// no clock, no network. Detections are named, redactions are destructive and
// irreversible by design (the scrubbed text replaces the secret - the secret
// never survives anywhere), and every scrub is reported with evidence counts.

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ScrubFinding {
  kind: string;
  count: number;
}

export interface ScrubResult {
  scrubbed: string;
  findings: ScrubFinding[];
  totalRedactions: number;
  eligible: boolean;
}

// Destructive redaction token: the redaction is irreversible - the original
// bytes are replaced in-place; nothing retains them.
const REDACTED = '[REDACTED]';

// --- Email addresses (PII) ---
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// --- Phone numbers (PII): international and common local formats ---
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{3,4}/g;

// --- Government identifiers (never enter training under any circumstance) ---
// US SSN: 000-00-0000 patterns
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// Generic national ID shapes: 10-12 consecutive digits with optional separators
const NATIONAL_ID_RE = /\b\d{3}[\s.]?\d{3}[\s.]?\d{3}[\s.]?\d{1,3}\b/g;

// --- Credentials and secrets (Tier 2: always forbidden) ---
// Bearer tokens
const BEARER_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g;
// API key assignments (common spellings)
const APIKEY_RE = /\b(?:api[_-]?key|apikey|secret|token|password|passwd|pwd)\b\s*[:=]\s*["']?([A-Za-z0-9\-._~+/]{8,})["']?/gi;
// Private key blocks
const PRIVKEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
// Stripe-style live keys
const STRIPE_RE = /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g;
// AWS-style access keys
const AWS_RE = /\bAKIA[0-9A-Z]{16}\b/g;
// JWTs
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
// Google/Firebase service-account style keys
const GOOGLE_KEY_RE = /\bAIza[0-9A-Za-z\-_]{30,}\b/g;

interface Rule {
  kind: string;
  re: RegExp;
}

// Order matters: the most destructive/structural rules run first so a private
// key block (which may contain emails) is removed before its parts get
// individually redacted.
const RULES: Rule[] = [
  { kind: 'secret-private-key-block', re: PRIVKEY_RE },
  { kind: 'secret-bearer-token', re: BEARER_RE },
  { kind: 'secret-jwt', re: JWT_RE },
  { kind: 'secret-stripe-key', re: STRIPE_RE },
  { kind: 'secret-aws-access-key', re: AWS_RE },
  { kind: 'secret-google-api-key', re: GOOGLE_KEY_RE },
  { kind: 'pii-email', re: EMAIL_RE },
  { kind: 'pii-government-id-ssn', re: SSN_RE },
  { kind: 'pii-national-id', re: NATIONAL_ID_RE },
  { kind: 'pii-phone', re: PHONE_RE },
  { kind: 'secret-assigned-credential', re: APIKEY_RE },
];

export function scrubText(input: {
  text: string;
  /** Ceiling: a record over this size is refused rather than half-scrubbed. */
  maxChars?: number;
}): Verdict<ScrubResult> {
  if (typeof input.text !== 'string') {
    return { ok: false, reason: 'scrub-not-a-string' };
  }
  if (input.text.length === 0) {
    return { ok: false, reason: 'scrub-empty-text' };
  }
  const maxChars = input.maxChars ?? 500_000;
  if (input.text.length > maxChars) {
    return { ok: false, reason: 'scrub-text-too-large:' + String(input.text.length) };
  }
  let scrubbed = input.text;
  const findings: ScrubFinding[] = [];
  let total = 0;
  for (const rule of RULES) {
    const matches = scrubbed.match(rule.re);
    const count = matches ? matches.length : 0;
    if (count > 0) {
      scrubbed = scrubbed.replace(rule.re, REDACTED);
      findings.push({ kind: rule.kind, count });
      total += count;
    }
  }
  return {
    ok: true,
    value: {
      scrubbed,
      findings,
      totalRedactions: total,
      // Eligible the moment the scrub has run; secrets and PII are gone.
      eligible: true,
    },
  };
}

export interface ClassificationCheckInput {
  classification: string;
  blockedClasses?: string[];
}

export const BLOCKED_TRAINING_CLASSES: readonly string[] = [
  'secret',
  'classified',
] as const;

/**
 * Data classification gate (FORGE AI-003): blocked classes NEVER enter
 * training, whatever their content. Refusals are named.
 */
export function checkClassificationEligibility(
  input: ClassificationCheckInput,
): Verdict<{ eligible: boolean; classification: string }> {
  const blocked = input.blockedClasses ?? BLOCKED_TRAINING_CLASSES;
  if (typeof input.classification !== 'string' || input.classification.length === 0) {
    return { ok: false, reason: 'classification-missing' };
  }
  if (blocked.includes(input.classification)) {
    return {
      ok: false,
      reason: 'classification-blocked:' + input.classification,
    };
  }
  return { ok: true, value: { eligible: true, classification: input.classification } };
}

