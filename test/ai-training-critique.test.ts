import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, setPlanForTest, startHarness } from './helpers.ts';

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

describe('ai-training self-critique and uncertainty report (AI-086/087)', () => {
  it('refuses the new routes without a session', async () => {
    const h = await startHarness();
    try {
      for (const path of ['/v1/ai-training/critique/run', '/v1/ai-training/uncertainty/report']) {
        const res = await h.post(path, {});
        assert.equal(res.status, 401, path);
        assert.equal(await errorCode(res), 'unauthenticated', path);
      }
    } finally {
      await h.close();
    }
  });

  it('sends unhonest results back for revision (AI-086)', async () => {
    const h = await startHarness();
    try {
      const register = await h.post('/v1/auth/register', { email: 'critic@forge.test', password: GOOD_PASSWORD, displayName: 'Critic' });
      await setPlanForTest(h, ((await register.json()) as { user: { id: string } }).user.id, 'enterprise');
      const cookie = sessionCookie(await h.post('/v1/auth/sign-in', { email: 'critic@forge.test', password: GOOD_PASSWORD }));

      const noSummary = await h.post('/v1/ai-training/critique/run', { resultId: 'r1', summary: ' ', items: [{ kind: 'fact', text: 'x' }] }, { cookie });
      assert.equal(noSummary.status, 400);
      assert.equal(await errorCode(noSummary), 'critique-no-summary');
      const badKind = await h.post('/v1/ai-training/critique/run', { resultId: 'r1', summary: 'done', items: [{ kind: 'guess', text: 'x' }] }, { cookie });
      assert.equal(badKind.status, 400);
      assert.equal(await errorCode(badKind), 'critique-kind-invalid:guess');
      const emptyText = await h.post('/v1/ai-training/critique/run', { resultId: 'r1', summary: 'done', items: [{ kind: 'fact', text: ' ' }] }, { cookie });
      assert.equal(emptyText.status, 400);
      assert.equal(await errorCode(emptyText), 'critique-empty-text:0');

      const factsOnly = await h.post('/v1/ai-training/critique/run', { resultId: 'res-1', summary: 'numbers look fine', items: [{ kind: 'fact', text: 'sum is 3' }, { kind: 'action', text: 'ship it' }] }, { cookie });
      assert.equal(factsOnly.status, 200);
      const revise = (await factsOnly.json()) as { report: { resultId: string; verdict: string; issues: string[]; fingerprint: string }; createdAt: number };
      assert.equal(revise.report.verdict, 'revise');
      assert.deepEqual(revise.report.issues, ['no-caveat-or-uncertainty']);
      assert.match(revise.report.fingerprint, /^sc_[0-9a-f]{8}$/);

      const honest = await h.post('/v1/ai-training/critique/run', { resultId: 'res-2', summary: 'numbers look fine', items: [{ kind: 'fact', text: 'sum is 3' }, { kind: 'uncertainty', text: 'sample size is small' }] }, { cookie });
      assert.equal(honest.status, 200);
      const present = (await honest.json()) as { report: { verdict: string; issues: string[] } };
      assert.equal(present.report.verdict, 'present');
      assert.deepEqual(present.report.issues, []);
    } finally {
      await h.close();
    }
  });

  it('reports uncertainty honestly: empty list is confidence, not error (AI-087)', async () => {
    const h = await startHarness();
    try {
      const register = await h.post('/v1/auth/register', { email: 'uncertain@forge.test', password: GOOD_PASSWORD, displayName: 'Uncertain' });
      await setPlanForTest(h, ((await register.json()) as { user: { id: string } }).user.id, 'enterprise');
      const cookie = sessionCookie(await h.post('/v1/auth/sign-in', { email: 'uncertain@forge.test', password: GOOD_PASSWORD }));

      const badLevel = await h.post('/v1/ai-training/uncertainty/report', { subjectId: 's1', summary: 'scope', items: [{ area: 'a', detail: 'd', level: 'cosmic' }] }, { cookie });
      assert.equal(badLevel.status, 400);
      assert.equal(await errorCode(badLevel), 'uncertainty-level-invalid:cosmic');
      const noArea = await h.post('/v1/ai-training/uncertainty/report', { subjectId: 's1', summary: 'scope', items: [{ area: ' ', detail: 'd', level: 'low' }] }, { cookie });
      assert.equal(noArea.status, 400);
      assert.equal(await errorCode(noArea), 'uncertainty-no-area:0');

      const confident = await h.post('/v1/ai-training/uncertainty/report', { subjectId: 'sub-1', summary: 'all checks passed', items: [] }, { cookie });
      assert.equal(confident.status, 200);
      const cBody = (await confident.json()) as { report: { subjectId: string; items: unknown[]; overall: string; verdict: string; fingerprint: string } };
      assert.deepEqual({ overall: cBody.report.overall, verdict: cBody.report.verdict }, { overall: 'none', verdict: 'confident' });
      assert.match(cBody.report.fingerprint, /^ur_[0-9a-f]{8}$/);

      const report = await h.post('/v1/ai-training/uncertainty/report', { subjectId: 'sub-1', summary: 'scope', items: [{ area: 'dates', detail: 'calendar math', level: 'medium' }, { area: 'ffi', detail: 'unverified', level: 'low' }] }, { cookie });
      assert.equal(report.status, 200);
      const rBody = (await report.json()) as { report: { overall: string; verdict: string } };
      assert.deepEqual({ overall: rBody.report.overall, verdict: rBody.report.verdict }, { overall: 'medium', verdict: 'report' });
    } finally {
      await h.close();
    }
  });
});
