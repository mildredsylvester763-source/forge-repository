/**
 * Password rules follow NIST SP 800-63B: length and blocklists, no composition rules,
 * every printable character (including spaces and Unicode) allowed.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PolicyViolationCode =
  | 'too_short'
  | 'too_long'
  | 'contains_control_characters'
  | 'single_repeated_character'
  | 'contains_email';

export interface PolicyViolation {
  code: PolicyViolationCode;
  message: string;
}

/** NFKC so visually identical passwords hash identically on every device. */
export function normalizePassword(raw: string): string {
  return raw.normalize('NFKC');
}

export function evaluatePassword(raw: string, context: { email?: string } = {}): PolicyViolation[] {
  const password = normalizePassword(raw);
  const chars = [...password];
  const violations: PolicyViolation[] = [];

  if (chars.length < PASSWORD_MIN_LENGTH) {
    violations.push({ code: 'too_short', message: `Use at least ${PASSWORD_MIN_LENGTH} characters.` });
  }
  if (chars.length > PASSWORD_MAX_LENGTH) {
    violations.push({ code: 'too_long', message: `Use at most ${PASSWORD_MAX_LENGTH} characters.` });
  }
  if (/[\u0000-\u001F\u007F]/.test(password)) {
    violations.push({ code: 'contains_control_characters', message: 'Remove control characters.' });
  }
  if (chars.length > 0 && new Set(chars).size === 1) {
    violations.push({ code: 'single_repeated_character', message: 'Do not repeat a single character.' });
  }
  if (context.email) {
    const lower = password.toLowerCase();
    const local = context.email.split('@')[0] ?? '';
    if (lower.includes(context.email) || (local.length >= 4 && lower.includes(local))) {
      violations.push({ code: 'contains_email', message: 'Do not include your email address.' });
    }
  }
  return violations;
}
