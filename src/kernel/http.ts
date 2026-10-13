import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from './errors.ts';
import type { Logger } from './logger.ts';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const STATE_CHANGING = new Set<string>(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface HttpResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string | string[]>;
}

export interface RequestContext {
  readonly requestId: string;
  readonly ip: string;
  readonly userAgent: string;
  readonly method: string;
  readonly path: string;
  header(name: string): string | undefined;
  cookie(name: string): string | undefined;
  json(): Promise<Record<string, unknown>>;
}

export type RouteHandler = (ctx: RequestContext) => Promise<HttpResult>;
export type RouteTable = Record<string, Partial<Record<Method, RouteHandler>>>;

export interface HttpOptions {
  routes: RouteTable;
  logger: Logger;
  allowedOrigins: readonly string[];
  trustProxyHops: number;
  hsts: boolean;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 16 * 1024;

/** Real client address. X-Forwarded-For is only believed for the number of proxies we run behind. */
export function clientIp(req: IncomingMessage, trustProxyHops: number): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (trustProxyHops <= 0) return remote;
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return remote;
  const parts = raw.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  const candidate = parts[parts.length - trustProxyHops];
  return candidate !== undefined && candidate.length <= 64 ? candidate : remote;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  if (!header || header.length > 4096) return jar;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!jar.has(name)) jar.set(name, pair.slice(eq + 1).trim());
  }
  return jar;
}

export function serializeCookie(name: string, value: string, options: { maxAgeSec: number; secure: boolean }): string {
  return `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}; HttpOnly; SameSite=Strict${
    options.secure ? '; Secure' : ''
  }`;
}

/** CSRF defence for cookie-authenticated requests: the browser tells us where the request came from. */
function enforceSameOrigin(req: IncomingMessage, allowed: readonly string[]): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    if (!allowed.includes(origin)) throw new AppError(403, 'origin_not_allowed', 'Cross-origin request rejected.');
    return;
  }
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') {
    throw new AppError(403, 'origin_not_allowed', 'Cross-origin request rejected.');
  }
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    const n = Number(declared);
    if (!Number.isInteger(n) || n < 0) throw new AppError(400, 'invalid_request', 'Invalid Content-Length.');
    if (n > max) throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > max) throw tooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function tooLarge(): AppError {
  return new AppError(413, 'payload_too_large', 'Request body too large.', { headers: { Connection: 'close' } });
}

function applySecurityHeaders(res: ServerResponse, requestId: string, hsts: boolean): void {
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.removeHeader('X-Powered-By');
  if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

function send(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string | string[]>): void {
  if (res.headersSent) return;
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...(payload ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function createHttpHandler(options: HttpOptions) {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = process.hrtime.bigint();
    const requestId = randomUUID();
    applySecurityHeaders(res, requestId, options.hsts);
    let status = 500;
    let route = 'unmatched';
    const ip = clientIp(req, options.trustProxyHops);

    try {
      const rawUrl = req.url ?? '/';
      if (rawUrl.length > 2048) throw new AppError(414, 'uri_too_long', 'Request URI too long.');
      const url = new URL(rawUrl, 'http://forge.invalid');
      const method = (req.method ?? 'GET').toUpperCase();

      if (!Object.hasOwn(options.routes, url.pathname)) throw new AppError(404, 'not_found', 'Not found.');
      const entry = options.routes[url.pathname] ?? {};
      if (!Object.hasOwn(entry, method)) {
        throw new AppError(405, 'method_not_allowed', 'Method not allowed.', {
          headers: { Allow: Object.keys(entry).join(', ') },
        });
      }
      const handler = entry[method as Method];
      if (!handler) throw new AppError(404, 'not_found', 'Not found.');
      route = `${method} ${url.pathname}`;

      if (STATE_CHANGING.has(method)) enforceSameOrigin(req, options.allowedOrigins);

      const cookies = parseCookies(req.headers.cookie);
      let bodyPromise: Promise<Record<string, unknown>> | undefined;
      const ctx: RequestContext = {
        requestId,
        ip,
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 256),
        method,
        path: url.pathname,
        header: (name) => {
          const v = req.headers[name.toLowerCase()];
          return Array.isArray(v) ? v[0] : v;
        },
        cookie: (name) => cookies.get(name),
        json: () => {
          bodyPromise ??= (async () => {
            const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
            if (type !== 'application/json') {
              throw new AppError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
            }
            const raw = await readBody(req, maxBody);
            if (raw.length === 0) throw new AppError(400, 'invalid_request', 'A JSON body is required.');
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw.toString('utf8'));
            } catch {
              throw new AppError(400, 'invalid_json', 'The request body is not valid JSON.');
            }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new AppError(400, 'invalid_request', 'The request body must be a JSON object.');
            }
            return parsed as Record<string, unknown>;
          })();
          return bodyPromise;
        },
      };

      const result = await handler(ctx);
      status = result.status;
      send(res, result.status, result.body, result.headers);
    } catch (err) {
      const known = err instanceof AppError ? err : null;
      status = known?.status ?? 500;
      if (!known) options.logger.error('unhandled error', { requestId, route, err });
      send(
        res,
        status,
        {
          error: {
            code: known?.code ?? 'internal_error',
            message: known?.message ?? 'Something went wrong.',
            requestId,
            ...(known?.details ? { details: known.details } : {}),
          },
        },
        known?.headers,
      );
    } finally {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      options.logger.info('request', { requestId, route, status, ip, durationMs: Math.round(durationMs * 10) / 10 });
    }
  };
}
