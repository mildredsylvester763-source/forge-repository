import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson } from '../src/kernel/canonical.ts';
import { InMemoryEventStore, verifyChain, type EventEnvelope } from '../src/kernel/events.ts';
import { redact, silentLogger } from '../src/kernel/logger.ts';
import { SlidingWindowLimiter } from '../src/kernel/rate-limit.ts';
import { Semaphore } from '../src/kernel/semaphore.ts';

const draft = (n: number) => ({
  type: 'test.thing.happened',
  version: 1,
  actor: { kind: 'system' as const, id: 'test' },
  subject: { type: 'thing', id: String(n) },
  payload: { n },
});

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: undefined } }), canonicalJson({ a: { d: 2 }, b: 1 }));
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });
});

describe('event store hash chain', () => {
  it('links events and verifies', async () => {
    const store = new InMemoryEventStore({ clock: () => 1, logger: silentLogger });
    const a = await store.append(draft(1));
    const b = await store.append(draft(2));
    assert.equal(a.seq, 1);
    assert.equal(b.prevHash, a.hash);
    const report = await store.verify();
    assert.equal(report.ok, true);
  });

  it('detects edits, deletions and reordering', async () => {
    const store = new InMemoryEventStore({ clock: () => 1, logger: silentLogger });
    for (let i = 1; i <= 4; i += 1) await store.append(draft(i));
    const events = await store.readFrom(1, 100);

    const edited = events.map((e, i): EventEnvelope => (i === 1 ? { ...e, payload: { n: 999 } } : e));
    const r1 = verifyChain(edited);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.brokenAtSeq, 2);

    const deleted = events.filter((e) => e.seq !== 2);
    assert.equal(verifyChain(deleted).ok, false);

    const reordered = [events[1], events[0], events[2], events[3]] as EventEnvelope[];
    assert.equal(verifyChain(reordered).ok, false);
  });

  it('freezes committed events and rejects bad types', async () => {
    const store = new InMemoryEventStore({ clock: () => 1, logger: silentLogger });
    const e = await store.append(draft(1));
    assert.throws(() => {
      (e.payload as Record<string, unknown>).n = 2;
    });
    await assert.rejects(store.append({ ...draft(1), type: 'BadType' }), TypeError);
  });

  it('delivers to prefix subscribers and isolates failing ones', async () => {
    const store = new InMemoryEventStore({ clock: () => 1, logger: silentLogger });
    const seen: string[] = [];
    store.subscribe('test', () => {
      throw new Error('boom');
    });
    store.subscribe('test.thing', (e) => void seen.push(e.type));
    store.subscribe('other', () => void seen.push('wrong'));
    await store.append(draft(1));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, ['test.thing.happened']);
  });
});

describe('rate limiter and semaphore', () => {
  it('blocks after the limit and recovers after the window', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1000, maxKeys: 10, clock: () => now });
    assert.equal(limiter.consume('k').allowed, true);
    assert.equal(limiter.consume('k').allowed, true);
    const blocked = limiter.consume('k');
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);
    now = 1500;
    assert.equal(limiter.consume('k').allowed, true);
  });

  it('bounds memory by evicting the oldest keys', () => {
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1000, maxKeys: 3, clock: () => 0 });
    for (let i = 0; i < 10; i += 1) limiter.consume(`k${i}`);
    assert.equal(limiter.consume('k0').allowed, true); // evicted earlier, so it starts fresh
  });

  it('limits concurrency and sheds load when the queue is full', async () => {
    const gate = new Semaphore(1, 1);
    let release!: () => void;
    const blocker = gate.run(() => new Promise<void>((r) => (release = r)));
    const queued = gate.run(async () => 'ran');
    await assert.rejects(async () => gate.run(async () => 'nope'), { code: 'server_busy' });
    release();
    await blocker;
    assert.equal(await queued, 'ran');
  });
});

describe('log redaction', () => {
  it('hides credentials at any depth', () => {
    const out = redact({ user: 'a', password: 'x', nested: { sessionToken: 'y', ok: 1 }, list: [{ cookie: 'z' }] }) as Record<string, any>;
    assert.equal(out.password, '[REDACTED]');
    assert.equal(out.nested.sessionToken, '[REDACTED]');
    assert.equal(out.nested.ok, 1);
    assert.equal(out.list[0].cookie, '[REDACTED]');
  });
});
