import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  parsePaystackSigningSecrets,
  verifyPaystackWebhookSignature,
} from '../src/modules/plans/paystack-webhooks.ts';

const body = Buffer.from('{ "event": "charge.success", "data": { "amount": 1500 } }', 'utf8');
const currentSecret = 'sk_test_0123456789abcdef0123456789abcdef';
const previousSecret = 'sk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function signature(secret: string, raw = body): string {
  return createHmac('sha512', secret).update(raw).digest('hex');
}

describe('Paystack webhook signature verification', () => {
  it('verifies the exact raw bytes using the Paystack HMAC-SHA512 header value', () => {
    const digest = signature(currentSecret);
    assert.equal(digest.length, 128);
    assert.equal(verifyPaystackWebhookSignature({
      rawBody: body,
      signatureHeader: digest,
      secrets: [currentSecret],
      nowMs: 1_800_000_000_000,
    }), true);
  });

  it('accepts a valid signature from either configured key during secret rotation', () => {
    const digest = signature(previousSecret);
    assert.equal(verifyPaystackWebhookSignature({
      rawBody: body,
      signatureHeader: digest,
      secrets: [currentSecret, previousSecret],
      nowMs: 1_800_000_000_000,
    }), true);
  });

  it('rejects a body that was parsed and reserialized differently', () => {
    const digest = signature(currentSecret);
    const changedBody = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))), 'utf8');
    assert.notDeepEqual(changedBody, body);
    assert.equal(verifyPaystackWebhookSignature({
      rawBody: changedBody,
      signatureHeader: digest,
      secrets: [currentSecret],
      nowMs: 1_800_000_000_000,
    }), false);
  });

  it('rejects malformed, wrapped, missing and unmatched signature headers', () => {
    const secrets = [currentSecret];
    const digest = signature(currentSecret);
    for (const header of [
      undefined,
      '',
      'not-a-signature',
      `t=1800000000,v1=${digest}`,
      `v1=whk_testkey:${digest}`,
      '0'.repeat(128),
      'a'.repeat(127),
    ]) {
      assert.equal(verifyPaystackWebhookSignature({
        rawBody: body,
        signatureHeader: header,
        secrets,
        nowMs: 1_800_000_000_000,
      }), false);
    }
    assert.equal(verifyPaystackWebhookSignature({
      rawBody: body,
      signatureHeader: digest,
      secrets: [],
      nowMs: 1_800_000_000_000,
    }), false);
    assert.equal(verifyPaystackWebhookSignature({
      rawBody: Buffer.alloc(0),
      signatureHeader: digest,
      secrets,
      nowMs: 1_800_000_000_000,
    }), false);
  });

  it('parses Paystack secret keys and rejects invalid or duplicate entries', () => {
    const parsed = parsePaystackSigningSecrets(`${currentSecret}, ${previousSecret}`);
    assert.deepEqual(parsed, [currentSecret, previousSecret]);
    assert.deepEqual(parsePaystackSigningSecrets(undefined), []);
    assert.throws(() => parsePaystackSigningSecrets('wrong-format'));
    assert.throws(() => parsePaystackSigningSecrets(`${currentSecret},${currentSecret}`));
  });
});
