import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, setPlanForTest, startHarness } from './helpers.ts';

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

const AMBIG = {
  intent: 'rename the export support',
  signals: [{ id: 'sig-1', kind: 'multiple-interpretations', description: 'which export format' }],
  questions: [{ text: 'Which format?', anchors: ['sig-1'] }],
};

describe('ai-training clarifying questions, the no-ambiguity law (AI-088)', () => {
  it('refuses the route without a session', async () => {
    const h = await startHarness();
    try {
      const res = await h.post('/v1/ai-training/clarify/decide', {});
      assert.equal(res.status, 401);
      assert.equal(await errorCode(res), 'unauthenticated');
    } finally {
      await h.close();
    }
  });

  it('never interrogates a clear intent, only anchored ambiguity', async () => {
    const h = await startHarness();
    try {
      const register = await h.post('/v1/auth/register', { email: 'clarify@forge.test', password: GOOD_PASSWORD, displayName: 'Clarifier' });
      await setPlanForTest(h, ((await register.json()) as { user: { id: string } }).user.id, 'enterprise');
      const cookie = sessionCookie(await h.post('/v1/auth/sign-in', { email: 'clarify@forge.test', password: GOOD_PASSWORD }));

      const noIntent = await h.post('/v1/ai-training/clarify/decide', { intent: ' ', signals: [], questions: [] }, { cookie });
      assert.equal(noIntent.status, 400);
      assert.equal(await errorCode(noIntent), 'clarify-no-intent');

      // the no-ambiguity law: a well-formed question on a clear intent is refused as such
      const clear = await h.post('/v1/ai-training/clarify/decide', { intent: 'ship the build', signals: [], questions: [{ text: 'Which branch?', anchors: ['nothing'] }] }, { cookie });
      assert.equal(clear.status, 400);
      assert.equal(await errorCode(clear), 'clarify-no-ambiguity');

      const unanchored = await h.post('/v1/ai-training/clarify/decide', { ...AMBIG, questions: [{ text: 'Which format?', anchors: [] }] }, { cookie });
      assert.equal(unanchored.status, 400);
      assert.equal(await errorCode(unanchored), 'clarify-question-unanchored:0');
      const unknownAnchor = await h.post('/v1/ai-training/clarify/decide', { ...AMBIG, questions: [{ text: 'Which format?', anchors: ['sig-9'] }] }, { cookie });
      assert.equal(unknownAnchor.status, 400);
      assert.equal(await errorCode(unknownAnchor), 'clarify-anchor-unknown:sig-9');
      const dupSignal = await h.post('/v1/ai-training/clarify/decide', { ...AMBIG, signals: [...AMBIG.signals, { id: 'sig-1', kind: 'unknown-scope', description: 'x' }] }, { cookie });
      assert.equal(dupSignal.status, 400);
      assert.equal(await errorCode(dupSignal), 'clarify-signal-duplicate:sig-1');
      const badKind = await h.post('/v1/ai-training/clarify/decide', { ...AMBIG, signals: [{ id: 's', kind: 'vibes', description: 'x' }] }, { cookie });
      assert.equal(badKind.status, 400);
      assert.equal(await errorCode(badKind), 'clarify-kind-invalid:vibes');

      const needed = await h.post('/v1/ai-training/clarify/decide', AMBIG, { cookie });
      assert.equal(needed.status, 200);
      const nBody = (await needed.json()) as { decision: { needed: boolean; reason: string; questions: Array<{ text: string; anchors: string[] }>; issues: string[]; fingerprint: string } };
      assert.deepEqual({ needed: nBody.decision.needed, reason: nBody.decision.reason, issues: nBody.decision.issues }, { needed: true, reason: 'intent-ambiguous', issues: [] });
      assert.deepEqual(nBody.decision.questions, [{ text: 'Which format?', anchors: ['sig-1'] }]);
      assert.match(nBody.decision.fingerprint, /^cq_[0-9a-f]{8}$/);

      // ambiguous but no questions drafted: allowed, with the honest issue
      const silent = await h.post('/v1/ai-training/clarify/decide', { ...AMBIG, questions: [] }, { cookie });
      assert.equal(silent.status, 200);
      const sBody = (await silent.json()) as { decision: { needed: boolean; questions: unknown[]; issues: string[] } };
      assert.deepEqual({ needed: sBody.decision.needed, questions: sBody.decision.questions, issues: sBody.decision.issues }, { needed: true, questions: [], issues: ['no-questions-drafted'] });

      // clear intent, no questions: plain pass
      const calm = await h.post('/v1/ai-training/clarify/decide', { intent: 'ship the build', signals: [], questions: [] }, { cookie });
      assert.equal(calm.status, 200);
      const calmBody = (await calm.json()) as { decision: { needed: boolean; reason: string } };
      assert.deepEqual({ needed: calmBody.decision.needed, reason: calmBody.decision.reason }, { needed: false, reason: 'intent-clear' });
    } finally {
      await h.close();
    }
  });
});
