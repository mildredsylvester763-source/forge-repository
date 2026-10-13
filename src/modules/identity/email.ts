import { domainToASCII } from 'node:url';

const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Returns the canonical form used as the unique account key, or null if the address is not acceptable.
 * Conservative on purpose: one "@", dot-atom local part, ASCII (punycode) domain with at least one dot.
 */
export function normalizeEmail(raw: string): string | null {
  const s = raw.normalize('NFKC').trim().toLowerCase();
  if (s.length < 3 || s.length > 254) return null;
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return null;
  const local = s.slice(0, at);
  if (local.length > 64 || !LOCAL_PART.test(local)) return null;
  const domain = domainToASCII(s.slice(at + 1));
  if (domain.length === 0 || domain.length > 253 || !DOMAIN.test(domain)) return null;
  return `${local}@${domain}`;
}
