import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { CompositeBreachChecker, HibpBreachChecker, LocalBlocklistChecker } from '../src/modules/identity/breach-check.ts';
import { normalizeEmail } from '../src/modules/identity/email.ts';
import { PasswordHasher } from '../src/modules/identity/password-hasher.ts';
import { evaluatePassword } from '../src/modules/identity/password-policy.ts';

const hasher = (peppers: Array<[number, number]>, current: number, logN = 10) =>
  new PasswordHasher({
    params: { logN, r: 8, p: 1 },
    peppers: new Map(peppers.map(([v, fill]) => [v, Buffer.alloc(32, fill)] as [number, Buffer])),
    currentPepperVersion: current,
    concurrency: 2,
    maxQueue: 8,
  });

describe('password policy (NIST 800-63B style)', () => {
  it('accepts long passphrases with spaces and unicode, no composition rules', () => {
    assert.deepEqual(evaluatePassword('correct horse battery', {}), []);
    assert.deepEqual(evaluatePassword('пароль-очень-длинный-123', {}), []);
  });
  it('rejects short, huge, control characters, repeats and email reuse', () => {
    const codes = (p: string, email?: string) => evaluatePassword(p, { email }).map((v) => v.code);
    assert.deepEqual(codes('short'), ['too_short']);
    assert.ok(codes('x'.repeat(129)).includes('too_long'));
    assert.ok(codes('abcdefgh\u0000ijkl').includes('contains_control_characters'));
    assert.ok(codes('aaaaaaaaaaaaaa').includes('single_repeated_character'));
    assert.ok(codes('my-alice.smith-pw-1', 'alice.smith@example.com').includes('contains_email'));
  });
  it('normalises compatibility characters (NFKC)', () => {
    // Fullwidth letters collapse to ASCII, so a 12-char fullwidth string is judged as 12 ASCII chars.
    assert.deepEqual(evaluatePassword('ａｂｃｄｅｆｇｈｉｊｋｌ', {}), []);
  });
});

describe('email normalisation', () => {
  it('canonicalises valid addresses', () => {
    assert.equal(normalizeEmail('  Alice+Tag@Example.COM '), 'alice+tag@example.com');
    assert.equal(normalizeEmail('a@b.com\n'), 'a@b.com'); // surrounding whitespace is trimmed
    assert.equal(normalizeEmail('bob@bücher.example'), 'bob@xn--bcher-kva.example');
  });
  it('rejects malformed addresses', () => {
    for (const bad of ['', 'no-at', 'a@b', 'a@@b.com', '.a@b.com', 'a..b@c.com', 'a b@c.com', 'a@-b.com', 'a@b.com.', `${'x'.repeat(65)}@b.com`]) {
      assert.equal(normalizeEmail(bad), null, bad);
    }
  });
});

describe('password hasher', () => {
  it('hashes with a random salt and verifies', async () => {
    const h = hasher([[1, 7]], 1);
    const a = await h.hash('correct horse battery');
    const b = await h.hash('correct horse battery');
    assert.notEqual(a, b);
    assert.match(a, /^\$scrypt\$ln=10,r=8,p=1,pv=1\$/);
    assert.equal(await h.verify('correct horse battery', a), true);
    assert.equal(await h.verify('correct horse batterz', a), false);
  });
  it('treats malformed or tampered stored hashes as a failed match, never a crash', async () => {
    const h = hasher([[1, 7]], 1);
    for (const bad of ['', 'plaintext', '$scrypt$ln=99,r=8,p=1,pv=1$AAAA$BBBB', '$argon2id$v=19$whatever']) {
      assert.equal(await h.verify('x', bad), false);
    }
  });
  it('a different pepper cannot verify (stolen database alone is not enough)', async () => {
    const stolen = await hasher([[1, 7]], 1).hash('correct horse battery');
    assert.equal(await hasher([[1, 9]], 1).verify('correct horse battery', stolen), false);
  });
  it('supports pepper rotation and flags old hashes for rehash', async () => {
    const old = await hasher([[1, 7]], 1).hash('correct horse battery');
    const rotated = hasher([[1, 7], [2, 8]], 2);
    assert.equal(await rotated.verify('correct horse battery', old), true);
    assert.equal(rotated.needsRehash(old), true);
    assert.equal(rotated.needsRehash(await rotated.hash('x'.repeat(14))), false);
  });
  it('flags weaker cost parameters for rehash', async () => {
    const weak = await hasher([[1, 7]], 1, 10).hash('correct horse battery');
    assert.equal(hasher([[1, 7]], 1, 11).needsRehash(weak), true);
  });
  it('unknown-account dummy verification completes without error', async () => {
    await hasher([[1, 7]], 1).verifyDummy('anything at all');
  });
});

describe('breach checking', () => {
  const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();

  it('sends only a 5-character hash prefix and finds the suffix in the response', async () => {
    const password = 'hunter2-hunter2';
    const hash = sha1(password);
    let requested = '';
    const fetchImpl = (async (url: string) => {
      requested = url;
      const body = ['0018A45C4D1DEF81644B54AB7F969B88D65:0', `${hash.slice(5)}:1337`, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:3'].join('\r\n');
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const result = await new HibpBreachChecker({ fetchImpl }).check(password);
    assert.deepEqual(result, { status: 'breached', count: 1337 });
    assert.ok(requested.endsWith(`/range/${hash.slice(0, 5)}`));
    assert.ok(!requested.includes(hash.slice(5)), 'the rest of the hash must never be sent');
    assert.ok(!requested.includes(password));
  });

  it('ignores zero-count padding rows and reports clean when absent', async () => {
    const password = 'a-perfectly-unique-passphrase';
    const body = `${sha1(password).slice(5)}:0\r\n0018A45C4D1DEF81644B54AB7F969B88D65:5`;
    const fetchImpl = (async () => new Response(body)) as unknown as typeof fetch;
    assert.deepEqual(await new HibpBreachChecker({ fetchImpl }).check(password), { status: 'clean' });
  });

  it('reports unavailable on network errors, timeouts, bad status and oversized replies', async () => {
    const fail = (impl: unknown) => new HibpBreachChecker({ fetchImpl: impl as typeof fetch, maxBytes: 100 }).check('whatever-password');
    assert.equal((await fail(async () => { throw new TypeError('down'); })).status, 'unavailable');
    assert.deepEqual(await fail(async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }), { status: 'unavailable', reason: 'timeout' });
    assert.deepEqual(await fail(async () => new Response('', { status: 503 })), { status: 'unavailable', reason: 'http_503' });
    assert.deepEqual(await fail(async () => new Response('x'.repeat(500))), { status: 'unavailable', reason: 'bad_response' });
  });

  it('composite short-circuits on the local blocklist and surfaces outages otherwise', async () => {
    let remoteCalls = 0;
    const remote = { check: async () => { remoteCalls += 1; return { status: 'unavailable', reason: 'timeout' } as const; } };
    const composite = new CompositeBreachChecker([new LocalBlocklistChecker(), remote]);
    assert.equal((await composite.check('PasswordPassword')).status, 'breached');
    assert.equal(remoteCalls, 0);
    assert.equal((await composite.check('some-other-passphrase')).status, 'unavailable');
  });
});
