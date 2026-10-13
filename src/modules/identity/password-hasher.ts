import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { Semaphore } from '../../kernel/semaphore.ts';

export interface ScryptParams {
  logN: number;
  r: number;
  p: number;
}

export interface HasherConfig {
  params: ScryptParams;
  /** version -> secret. Held outside the database so a stolen hash table alone is not crackable. */
  peppers: ReadonlyMap<number, Buffer>;
  currentPepperVersion: number;
  concurrency: number;
  maxQueue: number;
}

const KEY_LENGTH = 32;
const HASH_FORMAT = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2}),pv=(\d{1,5})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface ParsedHash {
  params: ScryptParams;
  pepperVersion: number;
  salt: Buffer;
  key: Buffer;
}

function scryptAsync(password: Buffer, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const b64 = (buf: Buffer): string => buf.toString('base64').replace(/=+$/, '');

function parse(stored: string): ParsedHash | null {
  const m = HASH_FORMAT.exec(stored);
  if (!m) return null;
  const logN = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  const pepperVersion = Number(m[4]);
  if (logN < 10 || logN > 22 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = Buffer.from(m[5] ?? '', 'base64');
  const key = Buffer.from(m[6] ?? '', 'base64');
  if (salt.length < 16 || key.length !== KEY_LENGTH) return null;
  return { params: { logN, r, p }, pepperVersion, salt, key };
}

/**
 * scrypt (OWASP-recommended N=2^17, r=8, p=1) over an HMAC-SHA256 "peppered" digest of the password.
 * The stored string is self-describing so parameters and pepper can be upgraded without a flag day.
 */
export class PasswordHasher {
  private readonly config: HasherConfig;
  private readonly gate: Semaphore;
  private dummy: Promise<string> | null = null;

  constructor(config: HasherConfig) {
    if (!config.peppers.has(config.currentPepperVersion)) throw new Error('current pepper version missing');
    this.config = config;
    this.gate = new Semaphore(config.concurrency, config.maxQueue);
  }

  private pepperInput(password: string, version: number): Buffer | null {
    const pepper = this.config.peppers.get(version);
    if (!pepper) return null;
    return createHmac('sha256', pepper).update(password, 'utf8').digest();
  }

  private derive(input: Buffer, salt: Buffer, params: ScryptParams): Promise<Buffer> {
    const N = 2 ** params.logN;
    return this.gate.run(() =>
      scryptAsync(input, salt, KEY_LENGTH, { N, r: params.r, p: params.p, maxmem: 128 * N * params.r * 2 + (1 << 20) }),
    );
  }

  async hash(password: string): Promise<string> {
    const { params, currentPepperVersion } = this.config;
    const input = this.pepperInput(password, currentPepperVersion);
    if (!input) throw new Error('pepper unavailable');
    const salt = randomBytes(16);
    const key = await this.derive(input, salt, params);
    return `$scrypt$ln=${params.logN},r=${params.r},p=${params.p},pv=${currentPepperVersion}$${b64(salt)}$${b64(key)}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) return false;
    const input = this.pepperInput(password, parsed.pepperVersion);
    if (!input) return false;
    const candidate = await this.derive(input, parsed.salt, parsed.params);
    return timingSafeEqual(candidate, parsed.key);
  }

  /** Spend the same time as a real verification, so unknown accounts are not distinguishable by latency. */
  async verifyDummy(password: string): Promise<void> {
    this.dummy ??= this.hash(randomBytes(18).toString('base64'));
    await this.verify(password, await this.dummy);
  }

  needsRehash(stored: string): boolean {
    const parsed = parse(stored);
    if (!parsed) return true;
    const { params, currentPepperVersion } = this.config;
    return (
      parsed.pepperVersion !== currentPepperVersion ||
      parsed.params.logN !== params.logN ||
      parsed.params.r !== params.r ||
      parsed.params.p !== params.p
    );
  }
}
