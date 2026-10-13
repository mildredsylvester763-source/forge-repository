import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, type ForgeApp } from '../src/app.ts';
import { loadConfig, type ForgeConfig } from '../src/config.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import type { BreachChecker, BreachResult, ThrottleConfig } from '../src/modules/identity/index.ts';

export const ORIGIN = 'https://app.forge.test';
export const GOOD_PASSWORD = 'violet-lantern-orbit-42';

export class FakeBreachChecker implements BreachChecker {
  mode: 'normal' | 'unavailable' = 'normal';
  calls: string[] = [];
  async check(password: string): Promise<BreachResult> {
    this.calls.push(password);
    if (this.mode === 'unavailable') return { status: 'unavailable', reason: 'timeout' };
    return password.includes('breached') ? { status: 'breached', count: 42 } : { status: 'clean' };
  }
}

export interface Harness {
  app: ForgeApp;
  config: ForgeConfig;
  breach: FakeBreachChecker;
  baseUrl: string;
  clock: { now: number };
  close(): Promise<void>;
  post(path: string, body: unknown, init?: { cookie?: string; origin?: string | null; headers?: Record<string, string> }): Promise<Response>;
  get(path: string, init?: { cookie?: string }): Promise<Response>;
}

export async function startHarness(
  envOverrides: Record<string, string> = {},
  throttle: Partial<ThrottleConfig> = { signInPerMinute: 100_000, registerPerMinute: 100_000 },
): Promise<Harness> {
  const config = loadConfig({
    FORGE_ENV: 'test',
    FORGE_SCRYPT_LOG_N: '10',
    FORGE_ALLOWED_ORIGINS: ORIGIN,
    ...envOverrides,
  });
  const breach = new FakeBreachChecker();
  const clock = { now: 1_800_000_000_000 };
  const app = buildApp(config, { breach, logger: silentLogger, clock: () => clock.now, throttle });
  const server: Server = createServer((req, res) => void app.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    app,
    config,
    breach,
    baseUrl,
    clock,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    post: (path, body, init = {}) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init.headers };
      if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
      if (init.cookie) headers.Cookie = init.cookie;
      return fetch(baseUrl + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    },
    get: (path, init = {}) => fetch(baseUrl + path, { headers: init.cookie ? { Cookie: init.cookie } : {} }),
  };
}

/** "name=value" part of the first Set-Cookie header. */
export function sessionCookie(res: Response): string {
  const raw = res.headers.getSetCookie()[0] ?? '';
  return raw.split(';')[0] ?? '';
}
