import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { healthRoutes } from '../src/kernel/health.ts';
import { createHttpHandler } from '../src/kernel/http.ts';
import { silentLogger } from '../src/kernel/logger.ts';

async function serve(head: () => Promise<{ seq: number; hash: string }>) {
  const routes = healthRoutes({ head }, silentLogger);
  const handler = createHttpHandler({
    routes,
    logger: silentLogger,
    allowedOrigins: [],
    trustProxyHops: 0,
    hsts: false,
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

describe('CO-091 health and readiness probes', () => {
  it('keeps liveness independent and reports readiness when the event store responds', async () => {
    const api = await serve(async () => ({ seq: 17, hash: 'a'.repeat(64) }));
    try {
      const live = await fetch(api.baseUrl + '/healthz');
      assert.equal(live.status, 200);
      assert.deepEqual(await live.json(), { status: 'ok' });

      const ready = await fetch(api.baseUrl + '/readyz');
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { status: 'ready', auditSeq: 17 });
    } finally {
      await api.close();
    }
  });

  it('keeps liveness healthy but fails readiness with a safe 503 when storage is unavailable', async () => {
    const api = await serve(async () => {
      throw new Error('sensitive database endpoint and credentials must not be exposed');
    });
    try {
      const live = await fetch(api.baseUrl + '/healthz');
      assert.equal(live.status, 200);

      const ready = await fetch(api.baseUrl + '/readyz');
      assert.equal(ready.status, 503);
      const body = await ready.json() as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'not_ready');
      assert.equal(body.error.message, 'A required service is unavailable.');
      assert.ok(!JSON.stringify(body).includes('sensitive database endpoint'));
    } finally {
      await api.close();
    }
  });
});
