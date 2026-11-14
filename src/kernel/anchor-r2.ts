import { createHash, createHmac } from 'node:crypto';
import { parseAnchorDocument, validateStoredAnchor, type AnchorStore, type AnchorValidation, type StoredAnchor } from './anchor-store.ts';
import type { EventChainAnchor } from './events.ts';

/**
 * CO-076 — Cloudflare R2 anchor adapter (S3-compatible, AWS Signature Version 4).
 *
 * The anchor document is one small JSON object at a fixed key. R2's S3 API gives us
 * cheap, out-of-band storage that nobody who can edit the event database needs to be
 * able to touch. The signing is pure and pinned by tests (fixed key, fixed clock,
 * fixed payload hash), so the wire format cannot drift silently. No third-party SDK:
 * `pg` stays the only runtime dependency.
 */

export interface R2AnchorConfig {
  /** Account-specific S3 endpoint, e.g. https://<account>.r2.cloudflarestorage.com */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** R2 uses the region string "auto". */
  readonly region?: string;
  /** Object key for the anchor document. */
  readonly key?: string;
  /** Injected fetch (tests pass a stub; production uses globalThis.fetch). */
  readonly fetchImpl?: typeof fetch;
}

const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function uriEncode(value: string, encodeSlash: boolean): string {
  let out = '';
  for (const ch of value) {
    if (/[A-Za-z0-9_.~-]/.test(ch)) out += ch;
    else if (ch === '/') out += encodeSlash ? '%2F' : '/';
    else out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export interface SignedR2Request {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer | null;
  /** The canonical request hash — pinned by tests so the signature rules cannot drift. */
  readonly canonicalRequestHash: string;
}

/**
 * Pure: builds one SigV4-signed request against R2's S3 API.
 * payloadHash is the hex sha256 of the body (or the empty-string hash for GET).
 */
export function signR2Request(config: R2AnchorConfig, method: 'PUT' | 'GET', now: Date, payloadHash: string, body: Buffer | null): SignedR2Request {
  const region = config.region ?? 'auto';
  const service = 's3';
  const key = config.key ?? 'forge/event-chain-anchor.json';
  const url = new URL(`${config.endpoint.replace(/\/$/, '')}/${config.bucket}/${uriEncode(key, false)}`);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const host = url.host;
  const canonicalUri = url.pathname;
  const canonicalQuery = '';
  const payloadHashFinal = method === 'GET' ? SHA256_EMPTY : payloadHash;
  const contentLength = body === null ? undefined : String(body.length);

  const headerPairs: Array<[string, string]> = [
    ['host', host],
    ['x-amz-content-sha256', payloadHashFinal],
    ['x-amz-date', amzDate],
  ];
  if (contentLength !== undefined) headerPairs.push(['content-length', contentLength]);
  headerPairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const canonicalHeaders = headerPairs.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = headerPairs.map(([k]) => k).join(';');

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHashFinal].join('\n');
  const canonicalRequestHash = sha256Hex(canonicalRequest);

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, canonicalRequestHash].join('\n');

  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = { authorization, host, 'x-amz-content-sha256': payloadHashFinal, 'x-amz-date': amzDate };
  if (contentLength !== undefined) headers['content-length'] = contentLength;

  return { method, url: url.toString(), headers, body, canonicalRequestHash };
}

/**
 * The R2 anchor store. Writes are PUTs of the newest head; reads parse strictly.
 * A network or storage failure surfaces as the thrown error — the tamper report
 * fails closed, it never guesses.
 */
export class R2AnchorStore implements AnchorStore {
  private readonly config: R2AnchorConfig & { region: string; key: string };
  private readonly fetchImpl: typeof fetch;

  constructor(config: R2AnchorConfig) {
    if (!/^https:\/\//.test(config.endpoint)) throw new TypeError('R2 endpoint must be an https URL');
    if (!config.bucket) throw new TypeError('R2 bucket is required');
    if (!config.accessKeyId || !config.secretAccessKey) throw new TypeError('R2 credentials are required');
    this.config = { region: 'auto', key: 'forge/event-chain-anchor.json', ...config, region: config.region ?? 'auto', key: config.key ?? 'forge/event-chain-anchor.json' };
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  async put(anchor: EventChainAnchor, now: Date): Promise<StoredAnchor> {
    const stored: StoredAnchor = { seq: anchor.seq, hash: anchor.hash, createdAt: now.toISOString() };
    const check = validateStoredAnchor(stored);
    if (!check.ok) throw new TypeError(`refusing to store an invalid anchor: ${check.reason}`);
    const body = Buffer.from(JSON.stringify(stored), 'utf8');
    const signed = signR2Request(this.config, 'PUT', now, sha256Hex(body), body);
    const response = await this.fetchImpl(signed.url, { method: signed.method, headers: signed.headers, body: new Uint8Array(body) });
    if (!response.ok) throw new Error(`anchor_put_failed: R2 answered ${response.status}`);
    return stored;
  }

  async get(): Promise<StoredAnchor | null> {
    const signed = signR2Request(this.config, 'GET', new Date(), SHA256_EMPTY, null);
    const response = await this.fetchImpl(signed.url, { method: signed.method, headers: signed.headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`anchor_get_failed: R2 answered ${response.status}`);
    const text = await response.text();
    const parsed: AnchorValidation = parseAnchorDocument(text);
    if (!parsed.ok) throw new Error(`anchor_invalid: ${parsed.reason}`);
    return parsed.value;
  }
}
