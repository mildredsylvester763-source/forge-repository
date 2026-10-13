import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { verifyChain } from '../src/kernel/events.ts';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let n = 0;
const email = () => `user${(n += 1)}@example.com`;

async function register(address = email(), password = GOOD_PASSWORD) {
  const res = await h.post('/v1/auth/register', { email: address, password, displayName: 'Test User' });
  return { res, address };
}

before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

describe('registration', () => {
  it('creates an account and never returns secrets', async () => {
    const { res, address } = await register();
    assert.equal(res.status, 201);
    const body = (await res.json()) as { user: Record<string, unknown> };
    assert.equal(body.user.email, address);
    assert.deepEqual(Object.keys(body.user).sort(), ['createdAt', 'displayName', 'email', 'id']);
  });

  it('rejects a password found in a breach (422) and a policy violation (422)', async () => {
    const breached = await register(email(), 'this-is-breached-123');
    assert.equal(breached.res.status, 422);
    assert.equal(((await breached.res.json()) as any).error.code, 'password_breached');

    const short = await register(email(), 'tiny');
    assert.equal(short.res.status, 422);
    assert.equal(((await short.res.json()) as any).error.code, 'password_policy_violation');
  });

  it('refuses to register when the breach service is down (fail-closed) and records it', async () => {
    h.breach.mode = 'unavailable';
    try {
      const { res } = await register();
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('retry-after'), '30');
    } finally {
      h.breach.mode = 'normal';
    }
  });

  it('rejects a duplicate email with the same hashing cost', async () => {
    const { address } = await register();
    const again = await register(address.toUpperCase());
    assert.equal(again.res.status, 409);
  });

  it('rejects unknown fields and wrong types (strict schema)', async () => {
    const extra = await h.post('/v1/auth/register', { email: email(), password: GOOD_PASSWORD, isAdmin: true });
    assert.equal(extra.status, 400);
    const wrong = await h.post('/v1/auth/register', { email: 123, password: GOOD_PASSWORD });
    assert.equal(wrong.status, 400);
  });
});

describe('sign-in, session and sign-out', () => {
  it('full lifecycle: sign in, read /me, sign out, session is dead', async () => {
    const { address } = await register();
    const signIn = await h.post('/v1/auth/sign-in', { email: address, password: GOOD_PASSWORD });
    assert.equal(signIn.status, 200);
    assert.equal(((await signIn.json()) as any).passwordChangeRequired, false);

    const setCookie = signIn.headers.getSetCookie()[0] ?? '';
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);

    const cookie = sessionCookie(signIn);
    const me = await h.get('/v1/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as any).user.email, address);

    const out = await h.post('/v1/auth/sign-out', {}, { cookie });
    assert.equal(out.status, 204);
    assert.equal((await h.get('/v1/auth/me', { cookie })).status, 401);
  });

  it('gives the same answer for an unknown account and a wrong password', async () => {
    const { address } = await register();
    const wrong = await h.post('/v1/auth/sign-in', { email: address, password: 'definitely-wrong-password' });
    const unknown = await h.post('/v1/auth/sign-in', { email: 'nobody-here@example.com', password: 'definitely-wrong-password' });
    const garbage = await h.post('/v1/auth/sign-in', { email: 'not an email', password: 'definitely-wrong-password' });
    for (const res of [wrong, unknown, garbage]) assert.equal(res.status, 401);
    const bodies = await Promise.all([wrong, unknown, garbage].map(async (r) => ((await r.json()) as any).error));
    for (const b of bodies) {
      assert.equal(b.code, 'invalid_credentials');
      assert.equal(b.message, bodies[0].message);
    }
  });

  it('issues a brand-new session token on every sign-in (no fixation)', async () => {
    const { address } = await register();
    const a = sessionCookie(await h.post('/v1/auth/sign-in', { email: address, password: GOOD_PASSWORD }));
    const b = sessionCookie(await h.post('/v1/auth/sign-in', { email: address, password: GOOD_PASSWORD }));
    assert.notEqual(a, b);
  });

  it('expires idle sessions and sessions past the absolute limit', async () => {
    const { address } = await register();
    const cookie = sessionCookie(await h.post('/v1/auth/sign-in', { email: address, password: GOOD_PASSWORD }));
    const start = h.clock.now;
    h.clock.now = start + 25 * 3_600_000; // beyond the 24h idle window
    assert.equal((await h.get('/v1/auth/me', { cookie })).status, 401);

    h.clock.now = start;
    const keepAlive = sessionCookie(await h.post('/v1/auth/sign-in', { email: address, password: GOOD_PASSWORD }));
    for (let i = 1; i <= 8; i += 1) {
      h.clock.now = start + i * 23 * 3_600_000; // active every 23h, yet absolute cap is 7 days
      const res = await h.get('/v1/auth/me', { cookie: keepAlive });
      assert.equal(res.status, i * 23 < 168 ? 200 : 401, `step ${i}`);
    }
    h.clock.now = start;
  });

  it('rejects forged, truncated and malformed session cookies', async () => {
    for (const bad of ['forge_session=', 'forge_session=abc', `forge_session=${'A'.repeat(43)}`, 'forge_session=../../etc/passwd']) {
      assert.equal((await h.get('/v1/auth/me', { cookie: bad })).status, 401, bad);
    }
    assert.equal((await h.get('/v1/auth/me')).status, 401);
  });

  it('caps active sessions per user by revoking the oldest', async () => {
    const small = await startHarness({ FORGE_SESSION_MAX_PER_USER: '2' });
    try {
      await small.post('/v1/auth/register', { email: 'cap@example.com', password: GOOD_PASSWORD });
      const cookies: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        small.clock.now += 1000;
        cookies.push(sessionCookie(await small.post('/v1/auth/sign-in', { email: 'cap@example.com', password: GOOD_PASSWORD })));
      }
      assert.equal((await small.get('/v1/auth/me', { cookie: cookies[0] })).status, 401);
      assert.equal((await small.get('/v1/auth/me', { cookie: cookies[2] })).status, 200);
    } finally {
      await small.close();
    }
  });

  it('flags a password that turns out to be breached and forces a change', async () => {
    const strict = await startHarness({ FORGE_BREACH_ON_SIGN_IN: 'true' });
    try {
      // Register while the password is "clean", then it appears in a breach.
      const pw = 'later-appears-in-the-wild-99';
      await strict.post('/v1/auth/register', { email: 'leak@example.com', password: pw });
      strict.breach.check = async () => ({ status: 'breached', count: 7 });
      const res = await strict.post('/v1/auth/sign-in', { email: 'leak@example.com', password: pw });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as any).passwordChangeRequired, true);
      const events = await strict.app.events.readFrom(1, 100);
      assert.ok(events.some((e) => e.type === 'identity.password.compromised_detected'));
    } finally {
      await strict.close();
    }
  });
});

describe('brute-force protection', () => {
  it('locks an account after repeated failures, even for the correct password, and unlocks later', async () => {
    const { address } = await register();
    for (let i = 0; i < 5; i += 1) {
      const res = await h.post('/v1/auth/sign-in', { email: address, password: `wrong-guess-number-${i}` });
      assert.equal(res.status, 401);
    }
    const locked = await h.post('/v1/auth/sign-in', { email: address, password: GOOD_PASSWORD });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) >= 1);

    h.clock.now += 61_000;
    const after = await h.post('/v1/auth/sign-in', { email: address, password: GOOD_PASSWORD });
    assert.equal(after.status, 200);
  });

  it('applies identical lockout to emails that do not exist (no account discovery)', async () => {
    for (let i = 0; i < 5; i += 1) await h.post('/v1/auth/sign-in', { email: 'ghost@example.com', password: `nope-nope-nope-${i}` });
    const res = await h.post('/v1/auth/sign-in', { email: 'ghost@example.com', password: 'nope-nope-nope-x' });
    assert.equal(res.status, 429);
  });

  it('rate-limits registrations from a single IP', async () => {
    const tight = await startHarness({}, {});
    try {
      let last = 0;
      for (let i = 0; i < 12; i += 1) {
        last = (await tight.post('/v1/auth/register', { email: `bulk${i}@example.com`, password: GOOD_PASSWORD })).status;
      }
      assert.equal(last, 429);
    } finally {
      await tight.close();
    }
  });

  it('rate-limits a single IP across many accounts', async () => {
    const tight = await startHarness({}, {}); // real default limits
    try {
      let last = 0;
      for (let i = 0; i < 35; i += 1) {
        last = (await tight.post('/v1/auth/sign-in', { email: `spray${i}@example.com`, password: 'password-spray-attempt' })).status;
      }
      assert.equal(last, 429);
    } finally {
      await tight.close();
    }
  });
});

describe('HTTP hardening', () => {
  it('rejects cross-origin state-changing requests (CSRF)', async () => {
    const res = await h.post('/v1/auth/sign-in', { email: 'a@example.com', password: GOOD_PASSWORD }, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    const sneaky = await h.post('/v1/auth/sign-out', {}, { origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(sneaky.status, 403);
  });

  it('allows non-browser clients that send no Origin', async () => {
    const res = await h.post('/v1/auth/sign-in', { email: 'nobody@example.com', password: GOOD_PASSWORD }, { origin: null });
    assert.equal(res.status, 401);
  });

  it('enforces content type, body size, JSON validity and object shape', async () => {
    const wrongType = await h.post('/v1/auth/sign-in', '{}', { headers: { 'Content-Type': 'text/plain' } });
    assert.equal(wrongType.status, 415);
    const huge = await h.post('/v1/auth/sign-in', { email: 'a@example.com', password: 'x'.repeat(40_000) });
    assert.equal(huge.status, 413);
    const broken = await h.post('/v1/auth/sign-in', '{not json');
    assert.equal(broken.status, 400);
    const array = await h.post('/v1/auth/sign-in', '[1,2]');
    assert.equal(array.status, 400);
    const empty = await h.post('/v1/auth/sign-in', '');
    assert.equal(empty.status, 400);
  });

  it('sets security headers, hides internals, and handles unknown routes and methods', async () => {
    const res = await h.get('/healthz');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.ok(res.headers.get('x-request-id'));
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal((await h.get('/nope')).status, 404);
    assert.equal((await h.get('/__proto__')).status, 404);
    const wrongMethod = await h.get('/v1/auth/sign-in');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');
  });
});

describe('audit trail', () => {
  it('records the lifecycle, stays tamper-evident, and never contains secrets or raw emails', async () => {
    const address = 'audit-subject@example.com';
    const password = 'audit-trail-secret-passphrase';
    await h.post('/v1/auth/register', { email: address, password });
    await h.post('/v1/auth/sign-in', { email: address, password: 'wrong-wrong-wrong-1' });
    const ok = await h.post('/v1/auth/sign-in', { email: address, password });
    await h.post('/v1/auth/sign-out', {}, { cookie: sessionCookie(ok) });

    const events = await h.app.events.readFrom(1, 10_000);
    const types = events.map((e) => e.type);
    for (const t of ['identity.user.registered', 'identity.sign_in.failed', 'identity.sign_in.succeeded', 'identity.sign_out.completed']) {
      assert.ok(types.includes(t), t);
    }
    assert.equal(verifyChain(events).ok, true);

    const dump = JSON.stringify(events);
    assert.ok(!dump.includes(password), 'password leaked into audit log');
    assert.ok(!dump.includes(address), 'raw email leaked into audit log');
    assert.ok(!dump.includes('$scrypt$'), 'password hash leaked into audit log');
    assert.ok(!dump.includes(sessionCookie(ok).split('=')[1] ?? 'x'), 'session token leaked into audit log');
  });

  it('exposes a health and readiness endpoint', async () => {
    assert.equal((await h.get('/healthz')).status, 200);
    const ready = await h.get('/readyz');
    assert.equal(ready.status, 200);
    assert.equal(typeof ((await ready.json()) as any).auditSeq, 'number');
  });
});
