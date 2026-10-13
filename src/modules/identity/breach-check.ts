import { createHash } from 'node:crypto';

export type BreachResult =
  | { status: 'clean' }
  | { status: 'breached'; count: number }
  | { status: 'unavailable'; reason: string };

export interface BreachChecker {
  check(password: string): Promise<BreachResult>;
}

/** Fast local screen for the very worst offenders. Not the real defence; the range API is. */
const COMMON = new Set([
  'password1234', 'password12345', 'passwordpassword', 'qwertyuiop12', 'qwertyuiopasdf', '123456789012',
  '1234567890123', 'iloveyou1234', 'letmein12345', 'welcome12345', 'administrator', 'changeme1234',
  'abcdefghijkl', 'abc123abc123', 'forgeforgeforge', 'correcthorsebatterystaple',
]);

export class LocalBlocklistChecker implements BreachChecker {
  async check(password: string): Promise<BreachResult> {
    return COMMON.has(password.toLowerCase()) ? { status: 'breached', count: 1 } : { status: 'clean' };
  }
}

export interface HibpOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Have I Been Pwned "range" API with k-anonymity: only the first 5 hex characters of the
 * SHA-1 hash ever leave this process. The full password and full hash are never sent.
 * (SHA-1 is required by that protocol; it is not used for storing anything.)
 */
export class HibpBreachChecker implements BreachChecker {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HibpOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.pwnedpasswords.com').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.maxBytes = options.maxBytes ?? 512 * 1024;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async check(password: string): Promise<BreachResult> {
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/range/${prefix}`, {
        method: 'GET',
        headers: { 'Add-Padding': 'true', 'User-Agent': 'forge-identity/1' },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { status: 'unavailable', reason: timedOut ? 'timeout' : 'network_error' };
    }
    if (!response.ok) return { status: 'unavailable', reason: `http_${response.status}` };

    let text: string;
    try {
      text = await readLimited(response, this.maxBytes);
    } catch {
      return { status: 'unavailable', reason: 'bad_response' };
    }

    for (const line of text.split('\n')) {
      const [candidate, countRaw] = line.trim().split(':');
      if (candidate !== suffix) continue;
      const count = Number.parseInt(countRaw ?? '', 10);
      // Padding entries are returned with a count of 0 and must be ignored.
      if (Number.isFinite(count) && count > 0) return { status: 'breached', count };
    }
    return { status: 'clean' };
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Local blocklist first (instant), then the remote range check. */
export class CompositeBreachChecker implements BreachChecker {
  private readonly checkers: readonly BreachChecker[];

  constructor(checkers: readonly BreachChecker[]) {
    this.checkers = checkers;
  }

  async check(password: string): Promise<BreachResult> {
    let unavailable: BreachResult | null = null;
    for (const checker of this.checkers) {
      const result = await checker.check(password);
      if (result.status === 'breached') return result;
      if (result.status === 'unavailable') unavailable = result;
    }
    return unavailable ?? { status: 'clean' };
  }
}
