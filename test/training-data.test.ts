import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

const NOW = 1_800_000_000_000;

async function signedInUser(h: Harness, email: string): Promise<string> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'TD Tester' });
  assert.equal(register.status, 201);
  const signIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signIn.status, 200);
  return sessionCookie(signIn);
}

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

interface LakeRow {
  lakeId: string;
  contentHash: string;
  creator: string;
  status: string;
  depth: number;
  provenance: string;
  rightsScore: number;
  intakeWeight: number;
  duplicate: boolean;
  createdAt: number;
}

interface AdmitBody {
  sourceKind: string;
  contentHash: string;
  creator: string;
  license: string;
  derivedFrom?: string[];
  method?: string;
  sourceTermsScore: number;
  consentScore: number;
  licenseScore: number;
  qualityScore: number;
  provenance: string;
  provenanceConfidence: number;
}

function admitBody(overrides: Partial<AdmitBody> = {}): AdmitBody {
  return {
    sourceKind: 'web-corpus',
    contentHash: 'ch-1',
    creator: 'ada',
    license: 'cc-by-4.0',
    sourceTermsScore: 1,
    consentScore: 0.9,
    licenseScore: 1,
    qualityScore: 0.8,
    provenance: 'human',
    provenanceConfidence: 0.9,
    ...overrides,
  };
}

describe('training data routes (FORGE AI-001, AI-002, AI-007, AI-008, AI-009, AI-010)', () => {
  it('refuses every route without a session', async () => {
    const h = await startHarness();
    try {
      const paths = [
        '/v1/training-data/lake/admit',
        '/v1/training-data/lake/compose',
        '/v1/training-data/lake/lineage',
        '/v1/training-data/lake/list',
        '/v1/training-data/consent/grant',
        '/v1/training-data/consent/revoke',
        '/v1/training-data/consent/check',
        '/v1/training-data/consent/ledger',
        '/v1/training-data/consent/list',
        '/v1/training-data/synthetic/register',
        '/v1/training-data/synthetic/chain',
        '/v1/training-data/synthetic/list',
        '/v1/training-data/labeling/submit',
        '/v1/training-data/labeling/borda',
        '/v1/training-data/labeling/list',
        '/v1/training-data/preference/store',
        '/v1/training-data/preference/list',
        '/v1/training-data/codedata/register',
        '/v1/training-data/codedata/deploy',
        '/v1/training-data/codedata/list',
      ];
      for (const path of paths) {
        const res = await h.post(path, {});
        assert.equal(res.status, 401, path + ' should refuse without a session');
        assert.equal(await errorCode(res), 'unauthenticated');
      }
    } finally {
      await h.close();
    }
  });

  it('admits lake records end to end: duplicate manifests are idempotent, refusals are named', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'td-lake@forge.test');
      const admit = await h.post('/v1/training-data/lake/admit', admitBody(), { cookie });
      assert.equal(admit.status, 201);
      const row = (await admit.json()) as LakeRow;
      assert.equal(row.lakeId, 'lr_1');
      assert.equal(row.contentHash, 'ch-1');
      assert.equal(row.status, 'accepted');
      assert.equal(row.rightsScore, 0.9);
      assert.equal(row.intakeWeight, 0.8);
      assert.equal(row.depth, 0);
      assert.equal(row.provenance, 'human');
      assert.equal(row.duplicate, false);
      assert.equal(row.createdAt, NOW);
      // the same manifest returns the same record, nothing is appended
      const dup = await h.post('/v1/training-data/lake/admit', admitBody(), { cookie });
      assert.equal(dup.status, 201);
      const dupRow = (await dup.json()) as LakeRow;
      assert.equal(dupRow.duplicate, true);
      assert.equal(dupRow.lakeId, 'lr_1');
      // the legal floor is binary: perfect scores cannot rehabilitate stolen data
      const floor = await h.post(
        '/v1/training-data/lake/admit',
        admitBody({ sourceKind: 'stolen-data', contentHash: 'ch-2', sourceTermsScore: 1, consentScore: 1, licenseScore: 1, qualityScore: 1, provenanceConfidence: 1 }),
        { cookie },
      );
      assert.equal(floor.status, 400);
      assert.equal(await errorCode(floor), 'lake-legal-floor:stolen-data');
      // rights below the floor are refused with the exact score
      const rights = await h.post(
        '/v1/training-data/lake/admit',
        admitBody({ contentHash: 'ch-3', consentScore: 0.5, licenseScore: 0.5 }),
        { cookie },
      );
      assert.equal(rights.status, 400);
      assert.equal(await errorCode(rights), 'lake-rights-rejected:0.25<0.4');
      // unknown fields are refused, not ignored
      const bad = await h.post('/v1/training-data/lake/admit', { ...admitBody(), bogus: 1 }, { cookie });
      assert.equal(bad.status, 400);
      assert.equal(await errorCode(bad), 'invalid_request');
      // parents need a method
      const methodless = await h.post('/v1/training-data/lake/admit', admitBody({ contentHash: 'ch-4', derivedFrom: ['lr_1'] }), { cookie });
      assert.equal(methodless.status, 400);
      assert.equal(await errorCode(methodless), 'lake-no-method');
      // refusals left nothing behind: exactly one record is listed
      const list = await h.post('/v1/training-data/lake/list', { page: 1, limit: 20 }, { cookie });
      assert.equal(list.status, 200);
      const listed = (await list.json()) as { data: LakeRow[]; total: number; page: number; limit: number };
      assert.equal(listed.total, 1);
      assert.equal(listed.page, 1);
      assert.equal(listed.data.length, 1);
    } finally {
      await h.close();
    }
  });

  it('walks lake lineage and composes batches with caps, pauses and relaxation', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'td-compose@forge.test');
      // seven records from seven distinct creators: 5 human, 1 ai, 1 mixed
      const first = await h.post('/v1/training-data/lake/admit', admitBody({ contentHash: 'ch-1', creator: 'c-1' }), { cookie });
      assert.equal(first.status, 201);
      const child = await h.post(
        '/v1/training-data/lake/admit',
        admitBody({ contentHash: 'ch-2', creator: 'c-2', derivedFrom: ['lr_1'], method: 'dedup' }),
        { cookie },
      );
      assert.equal(child.status, 201);
      const childRow = (await child.json()) as LakeRow;
      assert.equal(childRow.lakeId, 'lr_2');
      assert.equal(childRow.depth, 1);
      const ai = await h.post(
        '/v1/training-data/lake/admit',
        admitBody({ contentHash: 'ch-3', creator: 'c-3', provenance: 'ai', provenanceConfidence: 0.9 }),
        { cookie },
      );
      assert.equal(ai.status, 201);
      for (const spec of [
        { contentHash: 'ch-4', creator: 'c-4', provenance: 'human' },
        { contentHash: 'ch-5', creator: 'c-5', provenance: 'human' },
        { contentHash: 'ch-6', creator: 'c-6', provenance: 'human' },
        { contentHash: 'ch-7', creator: 'c-7', provenance: 'mixed' },
      ]) {
        const res = await h.post('/v1/training-data/lake/admit', admitBody(spec), { cookie });
        assert.equal(res.status, 201);
      }
      // lineage of the child: root first, both records present
      const lineage = await h.post('/v1/training-data/lake/lineage', { lakeId: 'lr_2' }, { cookie });
      assert.equal(lineage.status, 200);
      const chain = (await lineage.json()) as { data: Array<{ id: string; depth: number }>; total: number };
      assert.equal(chain.total, 2);
      assert.deepEqual(chain.data.map((n) => n.id), ['lr_1', 'lr_2']);
      const unknown = await h.post('/v1/training-data/lake/lineage', { lakeId: 'lr_99' }, { cookie });
      assert.equal(unknown.status, 404);
      assert.equal(await errorCode(unknown), 'lake-unknown-record:lr_99');
      // an unrelaxed batch trips the diversity cap: one creator holding half the batch
      const capless = await h.post('/v1/training-data/lake/compose', { lakeIds: ['lr_1', 'lr_2'] }, { cookie });
      assert.equal(capless.status, 400);
      assert.equal(await errorCode(capless), 'lake-composition-diversity-cap:c-1:0.5>0.02');
      // relaxing both creators lets the two-human batch compose clean
      const twoCreators = await h.post('/v1/training-data/lake/compose', { lakeIds: ['lr_1', 'lr_2'], relaxedCreators: ['c-1', 'c-2'] }, { cookie });
      assert.equal(twoCreators.status, 200);
      const composed = (await twoCreators.json()) as { status: string; flag: string | null; aiShare: number; humanShare: number };
      assert.deepEqual(composed, { status: 'ok', flag: null, aiShare: 0, humanShare: 1 });
      // the ai cap is a hard refusal even when every creator is relaxed
      const aiHeavy = await h.post('/v1/training-data/lake/compose', { lakeIds: ['lr_1', 'lr_3'], relaxedCreators: ['c-1', 'c-3'] }, { cookie });
      assert.equal(aiHeavy.status, 400);
      assert.equal(await errorCode(aiHeavy), 'lake-composition-ai-cap:0.5>0.15');
      // a thin-human batch pauses with a named flag instead of refusing
      const allSeven = await h.post('/v1/training-data/lake/compose', { lakeIds: ['lr_1', 'lr_2', 'lr_3', 'lr_4', 'lr_5', 'lr_6', 'lr_7'], relaxedCreators: ['c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'c-6', 'c-7'] }, { cookie });
      assert.equal(allSeven.status, 200);
      const paused = (await allSeven.json()) as { status: string; flag: string | null; aiShare: number; humanShare: number };
      assert.deepEqual(paused, { status: 'paused', flag: 'lake-paused-insufficient-human:0.7143<0.85', aiShare: 0.1429, humanShare: 0.7143 });
      // unknown members and empty batches are refused by name
      const unknownMember = await h.post('/v1/training-data/lake/compose', { lakeIds: ['lr_99'] }, { cookie });
      assert.equal(unknownMember.status, 404);
      assert.equal(await errorCode(unknownMember), 'lake-unknown-record:lr_99');
      const empty = await h.post('/v1/training-data/lake/compose', { lakeIds: [] }, { cookie });
      assert.equal(empty.status, 400);
      assert.equal(await errorCode(empty), 'lake-empty-batch');
      const notAList = await h.post('/v1/training-data/lake/compose', { lakeIds: 'lr_1' }, { cookie });
      assert.equal(notAList.status, 400);
      assert.equal(await errorCode(notAList), 'lake-batch-not-a-list');
    } finally {
      await h.close();
    }
  });

  it('runs the consent lifecycle end to end: grant, revoke, re-grant, expiry and supersede', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'td-consent@forge.test');
      const grant = await h.post('/v1/training-data/consent/grant', { workspace: 'ws-1', user: 'subject-1', dataType: 'preference', purpose: 'training' }, { cookie });
      assert.equal(grant.status, 201);
      const grantRow = (await grant.json()) as { grantId: string; grantedAt: number; expiresAt: number | null; duplicate: boolean; regrants: number };
      assert.equal(grantRow.grantId, 'cgr_1');
      assert.equal(grantRow.grantedAt, NOW);
      assert.equal(grantRow.expiresAt, null);
      assert.equal(grantRow.duplicate, false);
      assert.equal(grantRow.regrants, 0);
      // a second grant for the live triple is idempotent
      const dup = await h.post('/v1/training-data/consent/grant', { workspace: 'ws-1', user: 'subject-1', dataType: 'preference', purpose: 'other-purpose' }, { cookie });
      assert.equal(dup.status, 201);
      const dupRow = (await dup.json()) as { grantId: string; duplicate: boolean; purpose: string };
      assert.equal(dupRow.duplicate, true);
      assert.equal(dupRow.grantId, 'cgr_1');
      assert.equal(dupRow.purpose, 'training');
      // check granted
      const check = await h.post('/v1/training-data/consent/check', { workspace: 'ws-1', user: 'subject-1', dataType: 'preference' }, { cookie });
      assert.equal(check.status, 200);
      assert.deepEqual(await check.json(), { granted: true, state: 'granted', grantId: 'cgr_1', expiresAt: null });
      // revoke is immediate
      const revoke = await h.post('/v1/training-data/consent/revoke', { workspace: 'ws-1', user: 'subject-1', dataType: 'preference' }, { cookie });
      assert.equal(revoke.status, 200);
      assert.deepEqual(await revoke.json(), { grantId: 'cgr_1', revokedAt: NOW });
      const denied = await h.post('/v1/training-data/consent/check', { workspace: 'ws-1', user: 'subject-1', dataType: 'preference' }, { cookie });
      assert.deepEqual(await denied.json(), { granted: false, state: 'denied', grantId: null, expiresAt: null });
      const revokeAgain = await h.post('/v1/training-data/consent/revoke', { workspace: 'ws-1', user: 'subject-1', dataType: 'preference' }, { cookie });
      assert.equal(revokeAgain.status, 400);
      assert.equal(await errorCode(revokeAgain), 'consent-no-active-grant:ws-1:subject-1:preference');
      // a re-grant after revoke is a new, audited grant
      const regrant = await h.post('/v1/training-data/consent/grant', { workspace: 'ws-1', user: 'subject-1', dataType: 'preference', purpose: 'training-v2' }, { cookie });
      assert.equal(regrant.status, 201);
      const regrantRow = (await regrant.json()) as { grantId: string; regrants: number; duplicate: boolean };
      assert.equal(regrantRow.grantId, 'cgr_2');
      assert.equal(regrantRow.regrants, 1);
      assert.equal(regrantRow.duplicate, false);
      // expiry lifecycle on a second triple, with the clock moved by hand
      h.clock.now = NOW + 10_000;
      const expiring = await h.post('/v1/training-data/consent/grant', { workspace: 'ws-1', user: 'subject-2', dataType: 'creative-work', purpose: 'training', expiresAt: NOW + 11_000 }, { cookie });
      assert.equal(expiring.status, 201);
      const expiringRow = (await expiring.json()) as { grantId: string; expiresAt: number };
      assert.equal(expiringRow.grantId, 'cgr_3');
      assert.equal(expiringRow.expiresAt, NOW + 11_000);
      const beforeDeadline = await h.post('/v1/training-data/consent/check', { workspace: 'ws-1', user: 'subject-2', dataType: 'creative-work' }, { cookie });
      assert.deepEqual(await beforeDeadline.json(), { granted: true, state: 'granted', grantId: 'cgr_3', expiresAt: NOW + 11_000 });
      h.clock.now = NOW + 11_000;
      const atDeadline = await h.post('/v1/training-data/consent/check', { workspace: 'ws-1', user: 'subject-2', dataType: 'creative-work' }, { cookie });
      assert.deepEqual(await atDeadline.json(), { granted: false, state: 'expired', grantId: 'cgr_3', expiresAt: NOW + 11_000 });
      // an expired grant cannot be revoked
      const revokeExpired = await h.post('/v1/training-data/consent/revoke', { workspace: 'ws-1', user: 'subject-2', dataType: 'creative-work' }, { cookie });
      assert.equal(revokeExpired.status, 400);
      assert.equal(await errorCode(revokeExpired), 'consent-no-active-grant:ws-1:subject-2:creative-work');
      // a re-grant over the expired one supersedes it, so it can never resurface
      const superseding = await h.post('/v1/training-data/consent/grant', { workspace: 'ws-1', user: 'subject-2', dataType: 'creative-work', purpose: 'training' }, { cookie });
      assert.equal(superseding.status, 201);
      const supersedingRow = (await superseding.json()) as { grantId: string };
      assert.equal(supersedingRow.grantId, 'cgr_4');
      const grantsList = await h.post('/v1/training-data/consent/list', { page: 1, limit: 20 }, { cookie });
      const grants = (await grantsList.json()) as { data: Array<{ grantId: string; supersededAt: number | null }>; total: number };
      assert.equal(grants.total, 4);
      const superseded = grants.data.find((g) => g.grantId === 'cgr_3');
      assert.equal(superseded?.supersededAt, NOW + 11_000);
      // the ledger records every state change exactly once
      const ledger = await h.post('/v1/training-data/consent/ledger', {}, { cookie });
      assert.equal(ledger.status, 200);
      const ledgerBody = (await ledger.json()) as { data: Array<{ eventId: string; kind: string; grantId: string }>; total: number };
      assert.equal(ledgerBody.total, 5);
      assert.deepEqual(ledgerBody.data.map((e) => e.kind), ['grant', 'revoke', 'grant', 'grant', 'grant']);
      const revokesOnly = await h.post('/v1/training-data/consent/ledger', { kind: 'revoke' }, { cookie });
      const revokesBody = (await revokesOnly.json()) as { data: Array<{ kind: string }>; total: number };
      assert.equal(revokesBody.total, 1);
      assert.equal(revokesBody.data[0]?.kind, 'revoke');
      // validation: expiry at or before now is refused, and the state never moves
      const pastExpiry = await h.post('/v1/training-data/consent/grant', { workspace: 'ws-1', user: 'subject-3', dataType: 'preference', purpose: 'training', expiresAt: NOW + 11_000 }, { cookie });
      assert.equal(pastExpiry.status, 400);
      assert.equal(await errorCode(pastExpiry), 'consent-expiry-in-past:' + (NOW + 11_000) + '<=' + (NOW + 11_000));
      const noPurpose = await h.post('/v1/training-data/consent/grant', { workspace: 'ws-1', user: 'subject-3', dataType: 'preference' }, { cookie });
      assert.equal(noPurpose.status, 400);
      assert.equal(await errorCode(noPurpose), 'consent-no-purpose');
    } finally {
      await h.close();
    }
  });

  it('registers synthetic manifests end to end, derived from lake or synthetic bases', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'td-synth@forge.test');
      const register = await h.post('/v1/training-data/synthetic/register', { provenance: 'synthetic', generator: { model: 'forge-gen', version: '1.0', seed: 42 } }, { cookie });
      assert.equal(register.status, 201);
      const row = (await register.json()) as { synId: string; contentHash: string; depth: number; bases: string[]; duplicate: boolean; generator: { model: string; version: string; seed: number } };
      assert.equal(row.synId, 'syn_1');
      assert.equal(row.depth, 0);
      assert.deepEqual(row.bases, []);
      assert.equal(row.duplicate, false);
      assert.deepEqual(row.generator, { model: 'forge-gen', version: '1.0', seed: 42 });
      assert.match(row.contentHash, /^syn_[0-9a-f]{8}$/);
      // the same manifest is an idempotent duplicate
      const dup = await h.post('/v1/training-data/synthetic/register', { provenance: 'synthetic', generator: { model: 'forge-gen', version: '1.0', seed: 42 } }, { cookie });
      assert.equal(dup.status, 201);
      const dupRow = (await dup.json()) as { synId: string; duplicate: boolean };
      assert.equal(dupRow.duplicate, true);
      assert.equal(dupRow.synId, 'syn_1');
      // a manifest that does not declare itself synthetic is unattributed
      const unattributed = await h.post('/v1/training-data/synthetic/register', { provenance: 'human', generator: { model: 'forge-gen', version: '1.0', seed: 42 } }, { cookie });
      assert.equal(unattributed.status, 400);
      assert.equal(await errorCode(unattributed), 'synthetic-unattributed:human');
      const noGenerator = await h.post('/v1/training-data/synthetic/register', { provenance: 'synthetic' }, { cookie });
      assert.equal(noGenerator.status, 400);
      assert.equal(await errorCode(noGenerator), 'synthetic-no-generator-model');
      const unknownBase = await h.post('/v1/training-data/synthetic/register', { provenance: 'synthetic', generator: { model: 'forge-gen', version: '1.0', seed: 42 }, bases: ['lr_ghost'] }, { cookie });
      assert.equal(unknownBase.status, 400);
      assert.equal(await errorCode(unknownBase), 'synthetic-unknown-base:lr_ghost');
      // a lake base gives the manifest depth 1, and the chain walks into the lake
      const lakeAdmit = await h.post('/v1/training-data/lake/admit', admitBody({ contentHash: 'ch-lake' }), { cookie });
      assert.equal(lakeAdmit.status, 201);
      const fromLake = await h.post('/v1/training-data/synthetic/register', { provenance: 'synthetic', generator: { model: 'forge-gen', version: '1.0', seed: 7 }, bases: ['lr_1'] }, { cookie });
      assert.equal(fromLake.status, 201);
      const fromLakeRow = (await fromLake.json()) as { synId: string; depth: number; duplicate: boolean };
      assert.equal(fromLakeRow.synId, 'syn_2');
      assert.equal(fromLakeRow.depth, 1);
      assert.equal(fromLakeRow.duplicate, false);
      const chain = await h.post('/v1/training-data/synthetic/chain', { synId: 'syn_2' }, { cookie });
      assert.equal(chain.status, 200);
      const chainBody = (await chain.json()) as { data: Array<{ id: string; kind: string; depth: number }>; total: number };
      assert.equal(chainBody.total, 2);
      assert.deepEqual(chainBody.data, [
        { id: 'lr_1', kind: 'lake', depth: 0 },
        { id: 'syn_2', kind: 'synthetic', depth: 1 },
      ]);
      // a synthetic base works the same way
      const fromSyn = await h.post('/v1/training-data/synthetic/register', { provenance: 'synthetic', generator: { model: 'forge-gen', version: '1.0', seed: 9 }, bases: ['syn_1'] }, { cookie });
      const fromSynRow = (await fromSyn.json()) as { synId: string; depth: number };
      assert.equal(fromSynRow.synId, 'syn_3');
      assert.equal(fromSynRow.depth, 1);
      const unknownChain = await h.post('/v1/training-data/synthetic/chain', { synId: 'syn_99' }, { cookie });
      assert.equal(unknownChain.status, 404);
      assert.equal(await errorCode(unknownChain), 'synthetic-unknown-record:syn_99');
      const list = await h.post('/v1/training-data/synthetic/list', { page: 1, limit: 20 }, { cookie });
      const listed = (await list.json()) as { data: Array<{ synId: string }>; total: number };
      assert.equal(listed.total, 3);
      assert.deepEqual(listed.data.map((r) => r.synId), ['syn_1', 'syn_2', 'syn_3']);
    } finally {
      await h.close();
    }
  });

  it('collects labels and tallies Borda counts end to end, one label per labeler per batch', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'td-label@forge.test');
      const submit = await h.post('/v1/training-data/labeling/submit', { batchId: 'batch-1', labeler: 'ada', ranking: ['a', 'b', 'c'] }, { cookie });
      assert.equal(submit.status, 201);
      const row = (await submit.json()) as { labelId: string; batchId: string; labeler: string; ranking: string[]; createdAt: number };
      assert.equal(row.labelId, 'lbl_1');
      assert.equal(row.batchId, 'batch-1');
      assert.equal(row.labeler, 'ada');
      assert.deepEqual(row.ranking, ['a', 'b', 'c']);
      assert.equal(row.createdAt, NOW);
      const second = await h.post('/v1/training-data/labeling/submit', { batchId: 'batch-1', labeler: 'bob', ranking: ['c', 'b', 'a'] }, { cookie });
      assert.equal(second.status, 201);
      const secondRow = (await second.json()) as { labelId: string };
      assert.equal(secondRow.labelId, 'lbl_2');
      // the same labeler on the same batch is a conflict, not a merge
      const repeat = await h.post('/v1/training-data/labeling/submit', { batchId: 'batch-1', labeler: 'ada', ranking: ['b', 'a', 'c'] }, { cookie });
      assert.equal(repeat.status, 409);
      assert.equal(await errorCode(repeat), 'labeling-duplicate-label:batch-1:ada');
      // the tally: both ballots give 2-2-2, ties break by name ascending
      const borda = await h.post('/v1/training-data/labeling/borda', { batchId: 'batch-1' }, { cookie });
      assert.equal(borda.status, 200);
      assert.deepEqual(await borda.json(), {
        batchId: 'batch-1',
        labelers: 2,
        ordered: [
          { candidate: 'a', points: 2 },
          { candidate: 'b', points: 2 },
          { candidate: 'c', points: 2 },
        ],
        winner: 'a',
      });
      const noLabels = await h.post('/v1/training-data/labeling/borda', { batchId: 'ghost' }, { cookie });
      assert.equal(noLabels.status, 404);
      assert.equal(await errorCode(noLabels), 'labeling-no-labels:ghost');
      // validation
      const emptyRanking = await h.post('/v1/training-data/labeling/submit', { batchId: 'batch-9', labeler: 'eve', ranking: [] }, { cookie });
      assert.equal(emptyRanking.status, 400);
      assert.equal(await errorCode(emptyRanking), 'labeling-empty-ranking');
      const notAList = await h.post('/v1/training-data/labeling/submit', { batchId: 'batch-9', labeler: 'eve', ranking: 'abc' }, { cookie });
      assert.equal(notAList.status, 400);
      assert.equal(await errorCode(notAList), 'labeling-ranking-not-list');
      const noBatch = await h.post('/v1/training-data/labeling/submit', { labeler: 'eve', ranking: ['a'] }, { cookie });
      assert.equal(noBatch.status, 400);
      assert.equal(await errorCode(noBatch), 'labeling-no-batch');
      // another batch is a fresh ballot box
      const otherBatch = await h.post('/v1/training-data/labeling/submit', { batchId: 'batch-2', labeler: 'ada', ranking: ['x', 'y'] }, { cookie });
      assert.equal(otherBatch.status, 201);
      const otherTally = await h.post('/v1/training-data/labeling/borda', { batchId: 'batch-2' }, { cookie });
      assert.deepEqual(await otherTally.json(), {
        batchId: 'batch-2',
        labelers: 1,
        ordered: [
          { candidate: 'x', points: 1 },
          { candidate: 'y', points: 0 },
        ],
        winner: 'x',
      });
      const list = await h.post('/v1/training-data/labeling/list', { batchId: 'batch-1', page: 1, limit: 20 }, { cookie });
      const listed = (await list.json()) as { data: Array<{ labelId: string }>; total: number };
      assert.equal(listed.total, 2);
      const listAll = await h.post('/v1/training-data/labeling/list', { page: 1, limit: 20 }, { cookie });
      const allRows = (await listAll.json()) as { total: number };
      assert.equal(allRows.total, 3);
    } finally {
      await h.close();
    }
  });

  it('isolates every record behind its owner: a second user sees nothing of the first', async () => {
    const h = await startHarness();
    try {
      const cookieA = await signedInUser(h, 'iso-a@forge.test');
      const cookieB = await signedInUser(h, 'iso-b@forge.test');
      // user A fills every registry
      const admitA = await h.post('/v1/training-data/lake/admit', admitBody({ contentHash: 'ch-a' }), { cookie: cookieA });
      assert.equal(admitA.status, 201);
      const grantA = await h.post('/v1/training-data/consent/grant', { workspace: 'ws-1', user: 'subject-1', dataType: 'preference', purpose: 'training' }, { cookie: cookieA });
      assert.equal(grantA.status, 201);
      const synthA = await h.post('/v1/training-data/synthetic/register', { provenance: 'synthetic', generator: { model: 'forge-gen', version: '1.0', seed: 1 } }, { cookie: cookieA });
      assert.equal(synthA.status, 201);
      const labelA = await h.post('/v1/training-data/labeling/submit', { batchId: 'batch-iso', labeler: 'ada', ranking: ['a', 'b'] }, { cookie: cookieA });
      assert.equal(labelA.status, 201);
      // user B sees none of it
      const listB = await h.post('/v1/training-data/lake/list', { page: 1, limit: 20 }, { cookie: cookieB });
      const lakeB = (await listB.json()) as { total: number };
      assert.equal(lakeB.total, 0);
      const checkB = await h.post('/v1/training-data/consent/check', { workspace: 'ws-1', user: 'subject-1', dataType: 'preference' }, { cookie: cookieB });
      assert.deepEqual(await checkB.json(), { granted: false, state: 'denied', grantId: null, expiresAt: null });
      const grantsB = await h.post('/v1/training-data/consent/list', { page: 1, limit: 20 }, { cookie: cookieB });
      const grantsBBody = (await grantsB.json()) as { total: number };
      assert.equal(grantsBBody.total, 0);
      const ledgerB = await h.post('/v1/training-data/consent/ledger', {}, { cookie: cookieB });
      const ledgerBBody = (await ledgerB.json()) as { total: number };
      assert.equal(ledgerBBody.total, 0);
      const synthListB = await h.post('/v1/training-data/synthetic/list', { page: 1, limit: 20 }, { cookie: cookieB });
      const synthBBody = (await synthListB.json()) as { total: number };
      assert.equal(synthBBody.total, 0);
      const bordaB = await h.post('/v1/training-data/labeling/borda', { batchId: 'batch-iso' }, { cookie: cookieB });
      assert.equal(bordaB.status, 404);
      assert.equal(await errorCode(bordaB), 'labeling-no-labels:batch-iso');
      const labelsB = await h.post('/v1/training-data/labeling/list', { page: 1, limit: 20 }, { cookie: cookieB });
      const labelsBBody = (await labelsB.json()) as { total: number };
      assert.equal(labelsBBody.total, 0);
      // user B's own records are numbered per owner, starting clean
      const admitB = await h.post('/v1/training-data/lake/admit', admitBody({ contentHash: 'ch-b', creator: 'bee' }), { cookie: cookieB });
      assert.equal(admitB.status, 201);
      const rowB = (await admitB.json()) as LakeRow;
      assert.equal(rowB.lakeId, 'lr_1');
      assert.equal(rowB.contentHash, 'ch-b');
      // and user A's view is untouched
      const lineageB = await h.post('/v1/training-data/lake/lineage', { lakeId: 'lr_1' }, { cookie: cookieB });
      const chainB = (await lineageB.json()) as { data: Array<{ id: string; contentHash: string }>; total: number };
      assert.equal(chainB.total, 1);
      assert.equal(chainB.data[0]?.contentHash, 'ch-b');
      const lineageA = await h.post('/v1/training-data/lake/lineage', { lakeId: 'lr_1' }, { cookie: cookieA });
      const chainA = (await lineageA.json()) as { data: Array<{ id: string; contentHash: string }>; total: number };
      assert.equal(chainA.total, 1);
      assert.equal(chainA.data[0]?.contentHash, 'ch-a');
      const listA = await h.post('/v1/training-data/lake/list', { page: 1, limit: 20 }, { cookie: cookieA });
      const lakeABody = (await listA.json()) as { total: number };
      assert.equal(lakeABody.total, 1);
    } finally {
      await h.close();
    }
  });
  it('gates preference storage behind consent and stores explicit signals end to end', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'td-pref@forge.test');
      // without consent on record the store is refused by name
      const gated = await h.post('/v1/training-data/preference/store', { user: 'subject-1', item: 'item-1', signal: 'like' }, { cookie });
      assert.equal(gated.status, 400);
      assert.equal(await errorCode(gated), 'preference-consent-required');
      // consent is granted in the workspace the service checks
      const grant = await h.post('/v1/training-data/consent/grant', { workspace: 'default', user: 'subject-1', dataType: 'preference', purpose: 'training' }, { cookie });
      assert.equal(grant.status, 201);
      const store = await h.post('/v1/training-data/preference/store', { user: 'subject-1', item: 'item-1', signal: 'like' }, { cookie });
      assert.equal(store.status, 201);
      const row = (await store.json()) as { prefId: string; user: string; item: string; signal: string; fingerprint: string; duplicate: boolean; createdAt: number };
      assert.equal(row.prefId, 'prf_1');
      assert.equal(row.user, 'subject-1');
      assert.equal(row.item, 'item-1');
      assert.equal(row.signal, 'like');
      assert.equal(row.fingerprint, 'pfp_ca0ead59');
      assert.equal(row.duplicate, false);
      assert.equal(row.createdAt, NOW);
      // the same signal is idempotent: the existing record returns, nothing is appended
      const dup = await h.post('/v1/training-data/preference/store', { user: 'subject-1', item: 'item-1', signal: 'like' }, { cookie });
      assert.equal(dup.status, 201);
      const dupRow = (await dup.json()) as { prefId: string; duplicate: boolean };
      assert.equal(dupRow.duplicate, true);
      assert.equal(dupRow.prefId, 'prf_1');
      // contradictory signals on one item coexist: nothing is inferred, replaced or merged
      const dislike = await h.post('/v1/training-data/preference/store', { user: 'subject-1', item: 'item-1', signal: 'dislike' }, { cookie });
      assert.equal(dislike.status, 201);
      const dislikeRow = (await dislike.json()) as { prefId: string; signal: string };
      assert.equal(dislikeRow.prefId, 'prf_2');
      assert.equal(dislikeRow.signal, 'dislike');
      // a subject without consent stays gated
      const other = await h.post('/v1/training-data/preference/store', { user: 'subject-2', item: 'item-1', signal: 'like' }, { cookie });
      assert.equal(other.status, 400);
      assert.equal(await errorCode(other), 'preference-consent-required');
      // explicit means explicit: unknown signals are refused by name
      const invalid = await h.post('/v1/training-data/preference/store', { user: 'subject-1', item: 'item-2', signal: 'upvote' }, { cookie });
      assert.equal(invalid.status, 400);
      assert.equal(await errorCode(invalid), 'preference-invalid-signal:upvote');
      // unknown fields are refused, not ignored
      const bad = await h.post('/v1/training-data/preference/store', { user: 'subject-1', item: 'item-3', signal: 'like', bogus: 1 }, { cookie });
      assert.equal(bad.status, 400);
      assert.equal(await errorCode(bad), 'invalid_request');
      // lists filter by subject and page
      const listAll = await h.post('/v1/training-data/preference/list', { page: 1, limit: 20 }, { cookie });
      assert.equal(listAll.status, 200);
      const all = (await listAll.json()) as { data: Array<{ prefId: string }>; total: number; page: number; limit: number };
      assert.equal(all.total, 2);
      assert.deepEqual(all.data.map((r) => r.prefId), ['prf_1', 'prf_2']);
      const listOne = await h.post('/v1/training-data/preference/list', { user: 'subject-1', page: 1, limit: 1 }, { cookie });
      const one = (await listOne.json()) as { data: Array<{ prefId: string }>; total: number; page: number; limit: number };
      assert.equal(one.total, 2);
      assert.equal(one.data.length, 1);
      assert.equal(one.limit, 1);
      const listGhost = await h.post('/v1/training-data/preference/list', { user: 'ghost' }, { cookie });
      const ghost = (await listGhost.json()) as { total: number };
      assert.equal(ghost.total, 0);
      // revoking consent closes the gate for new signals, but stored ones still read back
      const revoke = await h.post('/v1/training-data/consent/revoke', { workspace: 'default', user: 'subject-1', dataType: 'preference' }, { cookie });
      assert.equal(revoke.status, 200);
      const afterRevoke = await h.post('/v1/training-data/preference/store', { user: 'subject-1', item: 'item-9', signal: 'skip' }, { cookie });
      assert.equal(afterRevoke.status, 400);
      assert.equal(await errorCode(afterRevoke), 'preference-consent-required');
      const still = await h.post('/v1/training-data/preference/list', { page: 1, limit: 20 }, { cookie });
      const stillBody = (await still.json()) as { total: number };
      assert.equal(stillBody.total, 2);
    } finally {
      await h.close();
    }
  });

  it('registers code and data contributions end to end with the deploy lifecycle', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'td-code@forge.test');
      // a fix must reference the failing test that proves the bug
      const fixNoTest = await h.post('/v1/training-data/codedata/register', { kind: 'fix', contentHash: 'h-1', author: 'ada' }, { cookie });
      assert.equal(fixNoTest.status, 400);
      assert.equal(await errorCode(fixNoTest), 'codedata-fix-no-test');
      // a parent must already exist
      const badParent = await h.post('/v1/training-data/codedata/register', { kind: 'diff', contentHash: 'h-1', author: 'ada', parentCode: 'cd_99' }, { cookie });
      assert.equal(badParent.status, 400);
      assert.equal(await errorCode(badParent), 'codedata-unknown-parent:cd_99');
      const badKind = await h.post('/v1/training-data/codedata/register', { kind: 'patch', contentHash: 'h-1', author: 'ada' }, { cookie });
      assert.equal(badKind.status, 400);
      assert.equal(await errorCode(badKind), 'codedata-invalid-kind:patch');
      // a root diff registers
      const diff = await h.post('/v1/training-data/codedata/register', { kind: 'diff', contentHash: 'h-1', author: 'ada' }, { cookie });
      assert.equal(diff.status, 201);
      const diffRow = (await diff.json()) as { codeId: string; kind: string; contentHash: string; author: string; parentCode: string | null; failingTestId: string | null; state: string | null; fingerprint: string; duplicate: boolean; createdAt: number };
      assert.equal(diffRow.codeId, 'cd_1');
      assert.equal(diffRow.kind, 'diff');
      assert.equal(diffRow.contentHash, 'h-1');
      assert.equal(diffRow.author, 'ada');
      assert.equal(diffRow.parentCode, null);
      assert.equal(diffRow.failingTestId, null);
      assert.equal(diffRow.state, null);
      assert.equal(diffRow.fingerprint, 'cdfp_72289d12');
      assert.equal(diffRow.duplicate, false);
      assert.equal(diffRow.createdAt, NOW);
      // the identical manifest is idempotent
      const dup = await h.post('/v1/training-data/codedata/register', { kind: 'diff', contentHash: 'h-1', author: 'ada' }, { cookie });
      assert.equal(dup.status, 201);
      const dupRow = (await dup.json()) as { codeId: string; duplicate: boolean };
      assert.equal(dupRow.duplicate, true);
      assert.equal(dupRow.codeId, 'cd_1');
      // a fix chains onto the diff and carries its failing test in identity
      const fix = await h.post('/v1/training-data/codedata/register', { kind: 'fix', contentHash: 'h-2', author: 'ada', parentCode: 'cd_1', failingTestId: 'ft-1' }, { cookie });
      assert.equal(fix.status, 201);
      const fixRow = (await fix.json()) as { codeId: string; parentCode: string | null; failingTestId: string | null; fingerprint: string };
      assert.equal(fixRow.codeId, 'cd_2');
      assert.equal(fixRow.parentCode, 'cd_1');
      assert.equal(fixRow.failingTestId, 'ft-1');
      assert.equal(fixRow.fingerprint, 'cdfp_5e666050');
      // deploys are born pending; other kinds never have a state
      const deploy = await h.post('/v1/training-data/codedata/register', { kind: 'deploy', contentHash: 'h-3', author: 'ada' }, { cookie });
      assert.equal(deploy.status, 201);
      const deployRow = (await deploy.json()) as { codeId: string; state: string | null; fingerprint: string };
      assert.equal(deployRow.codeId, 'cd_3');
      assert.equal(deployRow.state, 'pending');
      assert.equal(deployRow.fingerprint, 'cdfp_41034128');
      // non-deploys have no state machine
      const notDeploy = await h.post('/v1/training-data/codedata/deploy', { codeId: 'cd_1', toState: 'running' }, { cookie });
      assert.equal(notDeploy.status, 409);
      assert.equal(await errorCode(notDeploy), 'codedata-not-deploy:cd_1');
      // unknown ids are a 404 for this owner
      const unknown = await h.post('/v1/training-data/codedata/deploy', { codeId: 'cd_99', toState: 'running' }, { cookie });
      assert.equal(unknown.status, 404);
      assert.equal(await errorCode(unknown), 'codedata-unknown-code:cd_99');
      // the lifecycle: pending -> running -> succeeded, then locked
      const running = await h.post('/v1/training-data/codedata/deploy', { codeId: 'cd_3', toState: 'running' }, { cookie });
      assert.equal(running.status, 200);
      assert.deepEqual(await running.json(), { codeId: 'cd_3', state: 'running' });
      const succeeded = await h.post('/v1/training-data/codedata/deploy', { codeId: 'cd_3', toState: 'succeeded' }, { cookie });
      assert.equal(succeeded.status, 200);
      assert.deepEqual(await succeeded.json(), { codeId: 'cd_3', state: 'succeeded' });
      const locked = await h.post('/v1/training-data/codedata/deploy', { codeId: 'cd_3', toState: 'aborted' }, { cookie });
      assert.equal(locked.status, 409);
      assert.equal(await errorCode(locked), 'codedata-terminal-state:succeeded');
      // an impossible hop is a conflict named from:to
      const fresh = await h.post('/v1/training-data/codedata/register', { kind: 'deploy', contentHash: 'h-4', author: 'ada' }, { cookie });
      assert.equal(fresh.status, 201);
      const hop = await h.post('/v1/training-data/codedata/deploy', { codeId: 'cd_4', toState: 'succeeded' }, { cookie });
      assert.equal(hop.status, 409);
      assert.equal(await errorCode(hop), 'codedata-invalid-transition:pending:succeeded');
      // unknown fields are refused
      const badField = await h.post('/v1/training-data/codedata/register', { kind: 'diff', contentHash: 'h-9', author: 'ada', bogus: 1 }, { cookie });
      assert.equal(badField.status, 400);
      assert.equal(await errorCode(badField), 'invalid_request');
      // the list pages the registry with live deploy states
      const list = await h.post('/v1/training-data/codedata/list', { page: 1, limit: 20 }, { cookie });
      assert.equal(list.status, 200);
      const listed = (await list.json()) as { data: Array<{ codeId: string; state: string | null }>; total: number; page: number; limit: number };
      assert.equal(listed.total, 4);
      assert.deepEqual(listed.data.map((r) => r.codeId), ['cd_1', 'cd_2', 'cd_3', 'cd_4']);
      assert.equal(listed.data.find((r) => r.codeId === 'cd_3')?.state, 'succeeded');
      assert.equal(listed.data.find((r) => r.codeId === 'cd_4')?.state, 'pending');
    } finally {
      await h.close();
    }
  });

  it('isolates preference and codedata records behind their owner', async () => {
    const h = await startHarness();
    try {
      const cookieA = await signedInUser(h, 'iso-pref-a@forge.test');
      const cookieB = await signedInUser(h, 'iso-pref-b@forge.test');
      // user A grants consent and fills both registries
      const grantA = await h.post('/v1/training-data/consent/grant', { workspace: 'default', user: 'subject-1', dataType: 'preference', purpose: 'training' }, { cookie: cookieA });
      assert.equal(grantA.status, 201);
      const prefA = await h.post('/v1/training-data/preference/store', { user: 'subject-1', item: 'item-1', signal: 'like' }, { cookie: cookieA });
      assert.equal(prefA.status, 201);
      assert.equal(((await prefA.json()) as { prefId: string }).prefId, 'prf_1');
      const codeA = await h.post('/v1/training-data/codedata/register', { kind: 'diff', contentHash: 'h-a', author: 'ada' }, { cookie: cookieA });
      assert.equal(codeA.status, 201);
      assert.equal(((await codeA.json()) as { codeId: string }).codeId, 'cd_1');
      // user B sees none of it: every registry is per owner
      const prefsB = await h.post('/v1/training-data/preference/list', { page: 1, limit: 20 }, { cookie: cookieB });
      assert.equal(((await prefsB.json()) as { total: number }).total, 0);
      const codesB = await h.post('/v1/training-data/codedata/list', { page: 1, limit: 20 }, { cookie: cookieB });
      assert.equal(((await codesB.json()) as { total: number }).total, 0);
      const deployB = await h.post('/v1/training-data/codedata/deploy', { codeId: 'cd_1', toState: 'running' }, { cookie: cookieB });
      assert.equal(deployB.status, 404);
      assert.equal(await errorCode(deployB), 'codedata-unknown-code:cd_1');
      // user B's own consent opens B's own gate, and B's records number from 1
      const grantB = await h.post('/v1/training-data/consent/grant', { workspace: 'default', user: 'subject-1', dataType: 'preference', purpose: 'training' }, { cookie: cookieB });
      assert.equal(grantB.status, 201);
      const prefB = await h.post('/v1/training-data/preference/store', { user: 'subject-1', item: 'item-1', signal: 'like' }, { cookie: cookieB });
      assert.equal(prefB.status, 201);
      assert.equal(((await prefB.json()) as { prefId: string }).prefId, 'prf_1');
      const codeB = await h.post('/v1/training-data/codedata/register', { kind: 'diff', contentHash: 'h-a', author: 'ada' }, { cookie: cookieB });
      assert.equal(codeB.status, 201);
      assert.equal(((await codeB.json()) as { codeId: string }).codeId, 'cd_1');
      // and user A's view is untouched
      const prefsA = await h.post('/v1/training-data/preference/list', { page: 1, limit: 20 }, { cookie: cookieA });
      assert.equal(((await prefsA.json()) as { total: number }).total, 1);
    } finally {
      await h.close();
    }
  });
});
