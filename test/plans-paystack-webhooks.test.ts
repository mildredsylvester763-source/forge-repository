import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  parsePaystackSigningSecrets,
  verifyPaystackWebhookSignature,
} from '../src/modules/plans/paystack-webhooks.ts';

const body = Buffer.from('{ "event": "charge.success", "data": { "amount": 1500 } }', 'utf8');
const nowMs = 1_800_000_000_000;
const timestamp = Math.floor(nowMs / 1000);
const signingSecret = 'whsec_0123456789abcdef0123456789abcdef';

function signature(secret: string, keyId: string, raw = body, time = timestamp): string {
  const digest = createHmac('sha512', secret).update(`${time}.`).update(raw).digest('hex');
  return `t=${time},v1=${keyId}:${digest}`;
}

describe('Paystack webhook signature verification', () => {
  it('verifies the exact raw bytes and accepts a matching key during rotation', () => {
    const oldSecret = 'whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const secrets = [
      { keyId: 'whk_oldkey1', secret: oldSecret },
      { keyId: 'whk_newkey2', secret: signingSecret },
    ];
    const header = `t=${timestamp},v1=whk_oldkey1:${'0'.repeat(128)},v1=${signature(signingSecret, 'whk_newkey2').split('v1=')[1]}`;
    assert.equal(verifyPaystackWebhookSignature({ rawBody: body, signatureHeader: header, secrets, nowMs }), true);
  });

  it('rejects a body that was parsed and reserialized differently', () => {
    const header = signature(signingSecret, 'whk_testkey');
    const changedBody = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))), 'utf8');
    assert.notDeepEqual(changedBody, body);
    assert.equal(verifyPaystackWebhookSignature({
      rawBody: changedBody,
      signatureHeader: header,
      secrets: [{ keyId: 'whk_testkey', secret: signingSecret }],
      nowMs,
    }), false);
  });

  it('rejects stale timestamps, unknown key ids, malformed signatures and missing headers', () => {
    const secrets = [{ keyId: 'whk_testkey', secret: signingSecret }];
    assert.equal(verifyPaystackWebhookSignature({
      rawBody: body, signatureHeader: signature(signingSecret, 'whk_testkey', body, timestamp - 301), secrets, nowMs,
    }), false);
    assert.equal(verifyPaystackWebhookSignature({
      rawBody: body, signatureHeader: signature(signingSecret, 'whk_unknown'), secrets, nowMs,
    }), false);
    assert.equal(verifyPaystackWebhookSignature({
      rawBody: body, signatureHeader: `t=${timestamp},v1=whk_testkey:1234`, secrets, nowMs,
    }), false);
    assert.equal(verifyPaystackWebhookSignature({
      rawBody: body, signatureHeader: undefined, secrets, nowMs,
    }), false);
  });

  it('parses multiple configured signing keys and rejects invalid or duplicate entries', () => {
    const parsed = parsePaystackSigningSecrets(
      'whk_oldkey1:whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,whk_newkey2:whsec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.keyId, 'whk_oldkey1');
    assert.throws(() => parsePaystackSigningSecrets('whk_bad:short'));
    assert.throws(() => parsePaystackSigningSecrets(
      'whk_sameid:whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,whk_sameid:whsec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ));
  });
});
