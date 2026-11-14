import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { GENESIS_HASH, buildEnvelope, verifyChain, type EventDraft, type EventEnvelope } from '../src/kernel/events.ts';
import { InMemoryAnchorStore, parseAnchorDocument, validateStoredAnchor } from '../src/kernel/anchor-store.ts';
import { R2AnchorStore, signR2Request } from '../src/kernel/anchor-r2.ts';
import { buildTamperEvidenceReport } from '../src/kernel/tamper-report.ts';

const draft: EventDraft = {
  type: 'identity.test.tamper',
  version: 1,
  actor: { kind: 'user', id: 'u-co-076' },
  subject: { type: 'user', id: 'u-co-076' },
  payload: { note: 'co-076' },
};

function sealedChain(count: number): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  let prev: { seq: number; hash: string } | null = null;
  for (let i = 0; i < count; i += 1) {
    const e = buildEnvelope(draft, prev, 1_700_000_000_000 + i);
    events.push(e);
    prev = { seq: e.seq, hash: e.hash };
  }
  return events;
}

describe('CO-076 anchor document validation', () => {
  it('accepts a well-formed anchor and refuses every malformed one by name', () => {
    const good = validateStoredAnchor({ seq: 3, hash: 'a'.repeat(64), createdAt: '2026-11-11T00:00:00.000Z' });
    assert.ok(good.ok);
    assert.equal(good.ok && good.value.seq, 3);
    assert.equal(validateStoredAnchor(null).ok, false);
    assert.equal(validateStoredAnchor('x').ok, false);
    assert.match(JSON.stringify(validateStoredAnchor({ seq: -1, hash: 'a'.repeat(64), createdAt: 'x' })), /anchor_invalid_sequence/);
    assert.match(JSON.stringify(validateStoredAnchor({ seq: 1, hash: 'nothex', createdAt: 'x' })), /anchor_invalid_hash/);
    assert.match(JSON.stringify(validateStoredAnchor({ seq: 1, hash: 'a'.repeat(64), createdAt: 5 })), /anchor_invalid_created_at/);
    assert.match(JSON.stringify(parseAnchorDocument('not json')), /anchor_unparseable/);
    const parsed = parseAnchorDocument(JSON.stringify({ seq: 2, hash: 'b'.repeat(64), createdAt: '2026-11-11T01:00:00.000Z' }));
    assert.ok(parsed.ok);
  });
});

describe('CO-076 in-memory anchor store', () => {
  it('stores the head, refuses regressions, and reads back what was written', async () => {
    const store = new InMemoryAnchorStore();
    assert.equal(await store.get(), null);
    const first = await store.put({ seq: 1, hash: 'a'.repeat(64) }, new Date(1_000));
    assert.deepEqual(first, { seq: 1, hash: 'a'.repeat(64), createdAt: new Date(1_000).toISOString() });
    await store.put({ seq: 2, hash: 'b'.repeat(64) }, new Date(2_000));
    assert.equal((await store.get())?.seq, 2);
    await assert.rejects(() => store.put({ seq: 1, hash: 'a'.repeat(64) }, new Date(3_000)), /anchor_regression/);
  });
});

describe('CO-076 R2 SigV4 signing (pinned wire format)', () => {
  const config = {
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    bucket: 'forge-anchor',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  };
  const fixedNow = new Date('2026-11-11T00:00:00.000Z');

  it('produces a deterministic canonical request hash and authorization header', () => {
    const body = Buffer.from('{"seq":1}', 'utf8');
    const signed = signR2Request(config, 'PUT', fixedNow, 'deadbeef' + '0'.repeat(56), body);
    assert.equal(signed.method, 'PUT');
    assert.equal(signed.url, 'https://acct.r2.cloudflarestorage.com/forge-anchor/forge/event-chain-anchor.json');
    assert.equal(signed.headers['x-amz-date'], '20261111T000000Z');
    assert.equal(signed.headers['content-length'], '9');
    assert.match(signed.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261111\/auto\/s3\/aws4_request, SignedHeaders=content-length;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
    // pin the canonical request hash so signing rules cannot drift silently
    const canonicalRequest = [
      'PUT',
      '/forge-anchor/forge/event-chain-anchor.json',
      '',
      'content-length:9\nhost:acct.r2.cloudflarestorage.com\nx-amz-content-sha256:deadbeef' + '0'.repeat(56) + '\nx-amz-date:20261111T000000Z\n',
      'content-length;host;x-amz-content-sha256;x-amz-date',
      'deadbeef' + '0'.repeat(56),
    ].join('\n');
    assert.equal(signed.canonicalRequestHash, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'));
  });

  it('signs GET with the empty-payload hash and no content-length', () => {
    const signed = signR2Request(config, 'GET', fixedNow, '', null);
    assert.equal(signed.headers['x-amz-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(signed.headers['content-length'], undefined);
    assert.equal(signed.body, null);
  });

  it('the R2 store round-trips through a stubbed fetch and answers null before the first anchor', async () => {
    let served: string | null = null;
    const fetchImpl = (async (url: string | URL, init?: { method?: string; body?: Uint8Array }) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT') {
        served = Buffer.from(init?.body ?? new Uint8Array()).toString('utf8');
        return new Response(null, { status: 200 });
      }
      if (served === null) return new Response(null, { status: 404 });
      return new Response(served, { status: 200 });
    }) as unknown as typeof fetch;
    const store = new R2AnchorStore({ ...config, fetchImpl });
    assert.equal(await store.get(), null, 'no anchor yet answers null, not an error');
    await store.put({ seq: 4, hash: 'c'.repeat(64) }, fixedNow);
    const read = await store.get();
    assert.deepEqual(read, { seq: 4, hash: 'c'.repeat(64), createdAt: fixedNow.toISOString() });
    assert.match(served ?? '', /"seq":4/);
  });
});

describe('CO-076 tamper-evidence verification report', () => {
  it('a sound chain with an agreeing anchor verifies', () => {
    const events = sealedChain(3);
    const report = verifyChain(events);
    assert.ok(report.ok);
    const anchor = { seq: 3, hash: report.ok ? report.headHash : '', createdAt: '2026-11-11T00:00:00.000Z' };
    const evidence = buildTamperEvidenceReport({ chain: report, anchor, now: new Date(5_000) });
    assert.equal(evidence.verified, true);
    assert.deepEqual(evidence.failures, []);
    assert.equal(evidence.anchor.agreement, 'agree');
    assert.equal(evidence.chain.count, 3);
  });

  it('an edited event is caught, and a missing or stale anchor fails closed by name', () => {
    const events = sealedChain(3);
    const tampered = events.map((e, i) => (i === 1 ? { ...e, payload: { note: 'edited' } } : e)) as EventEnvelope[];
    const broken = verifyChain(tampered);
    assert.equal(broken.ok, false);
    const fromBroken = buildTamperEvidenceReport({ chain: broken, anchor: null, now: new Date(5_000) });
    assert.equal(fromBroken.verified, false);
    assert.deepEqual(fromBroken.failures, ['chain_hash_mismatch_at_2']);

    const sound = verifyChain(events);
    assert.ok(sound.ok);
    const noAnchor = buildTamperEvidenceReport({ chain: sound, anchor: null, now: new Date(5_000) });
    assert.equal(noAnchor.verified, false, 'unproven is not sound');
    assert.deepEqual(noAnchor.failures, ['anchor_unavailable']);

    const stale = buildTamperEvidenceReport({ chain: sound, anchor: { seq: 2, hash: 'a'.repeat(64) }, now: new Date(5_000) });
    assert.equal(stale.verified, false);
    assert.match(JSON.stringify(stale.failures), /anchor_sequence_mismatch/);

    const wrongHash = buildTamperEvidenceReport({ chain: sound, anchor: { seq: 3, hash: 'f'.repeat(64) }, now: new Date(5_000) });
    assert.equal(wrongHash.verified, false);
    assert.match(JSON.stringify(wrongHash.failures), /anchor_hash_mismatch/);
  });

  it('carries backup evidence into the same report', () => {
    const events = sealedChain(1);
    const sound = verifyChain(events);
    assert.ok(sound.ok);
    const anchor = { seq: 1, hash: sound.ok ? sound.headHash : '', createdAt: '2026-11-11T00:00:00.000Z' };
    const withBackups = buildTamperEvidenceReport({
      chain: sound,
      anchor,
      now: new Date(5_000),
      backups: [
        { name: 'forge-20261111T000000000Z.sqlite', sha256: 'a'.repeat(64), ok: true },
        { name: 'forge-20261110T000000000Z.sqlite', sha256: 'b'.repeat(64), ok: false, reason: 'checksum_mismatch' },
      ],
    });
    assert.equal(withBackups.verified, false);
    assert.match(JSON.stringify(withBackups.failures), /backup_forge-20261110T000000000Z\.sqlite_checksum_mismatch/);
    assert.equal(withBackups.backups.length, 2);
  });

  it('genesis (empty chain) with a zero anchor verifies', () => {
    const empty = verifyChain([]);
    assert.deepEqual(empty, { ok: true, count: 0, headHash: GENESIS_HASH });
    const evidence = buildTamperEvidenceReport({ chain: empty, anchor: { seq: 0, hash: GENESIS_HASH, createdAt: '2026-11-11T00:00:00.000Z' }, now: new Date(5_000) });
    assert.equal(evidence.verified, true);
  });
});
