import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  admitLakeRecord,
  composeBatch,
  lineageChain,
  AI_CAP_DEFAULT,
  DIVERSITY_CAP_DEFAULT,
  HUMAN_SHARE_FLOOR,
  LEGAL_FLOOR_CLASSES,
  PROVENANCE_CONFIDENCE_FLOOR,
  PROVENANCE_MULTIPLIERS,
  RIGHTS_REJECT_FLOOR,
  RIGHTS_REVIEW_CEILING,
  type AdmitLakeInput,
  type LakeProvenance,
  type LakeRecord,
} from '../src/modules/training-data/engine/data-lake-engine.ts';
import {
  checkConsent,
  consentLedger,
  grantConsent,
  revokeConsent,
  type ConsentState,
  type GrantConsentInput,
} from '../src/modules/training-data/engine/consent-engine.ts';
import { registerSynthetic, syntheticChain, type RegisterSyntheticInput, type SyntheticRecord } from '../src/modules/training-data/engine/synthetic-engine.ts';
import { bordaCount, registerLabel, type LabelRecord, type RegisterLabelInput } from '../src/modules/training-data/engine/labeling-engine.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = 1_800_000_000_000;

// The engine fingerprints are pinned law: djb2-style, seed 5381, x33 steps, >>> 0, 8 hex chars.
function fp(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h * 33 + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(-8);
}

// The engine rounding is pinned law: 4 decimal places.
function r4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

function unwrap<T>(verdict: Verdict<T>): T {
  if (!verdict.ok) throw new Error('expected ok, refused: ' + verdict.reason);
  return verdict.value;
}

function refusal<T>(verdict: Verdict<T>): string {
  if (verdict.ok) throw new Error('expected refusal, got a value');
  return verdict.reason;
}

describe('data lake engine (FORGE AI-001)', () => {
  function baseLake(overrides: Partial<AdmitLakeInput> = {}): AdmitLakeInput {
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
      now: NOW,
      ...overrides,
    };
  }

  function admitNext(lake: LakeRecord[], overrides: Partial<AdmitLakeInput> = {}): LakeRecord & { duplicate: boolean } {
    const verdict = admitLakeRecord(baseLake({ contentHash: 'ch-' + (lake.length + 1), ...overrides }), lake);
    const rec = unwrap(verdict);
    lake.push(rec);
    return rec;
  }

  function batchRecord(id: string, provenance: LakeProvenance, creator: string): LakeRecord {
    return {
      id,
      sourceKind: 'web-corpus',
      contentHash: 'ch-' + id,
      creator,
      license: 'cc-by-4.0',
      derivedFrom: [],
      method: '',
      depth: 0,
      status: 'accepted',
      provenance,
      provenanceConfidence: 0.9,
      provenanceMultiplier: PROVENANCE_MULTIPLIERS[provenance],
      qualityScore: 0.8,
      rightsScore: 1,
      intakeWeight: 0.8,
      fingerprint: 'lakefp_' + fp(id),
      createdAt: NOW,
    };
  }

  function bigBatch(ai: number, human: number, extra: Array<[string, LakeProvenance]> = []): LakeRecord[] {
    const records: LakeRecord[] = [];
    for (let i = 0; i < ai; i++) records.push(batchRecord('lr_a' + i, 'ai', 'ai-' + i));
    for (let i = 0; i < human; i++) records.push(batchRecord('lr_h' + i, 'human', 'hu-' + i));
    for (let i = 0; i < extra.length; i++) {
      const e = extra[i];
      if (e !== undefined) records.push(batchRecord('lr_x' + i, e[1], e[0]));
    }
    return records;
  }

  it('pins the law constants exactly', () => {
    assert.deepEqual(LEGAL_FLOOR_CLASSES, ['stolen-data', 'pirated-dataset', 'illegal-content', 'privacy-violation']);
    assert.equal(RIGHTS_REJECT_FLOOR, 0.4);
    assert.equal(RIGHTS_REVIEW_CEILING, 0.7);
    assert.equal(PROVENANCE_CONFIDENCE_FLOOR, 0.6);
    assert.deepEqual(PROVENANCE_MULTIPLIERS, { human: 1, ai: 0.3, mixed: 0.6, unknown: 0.2 });
    assert.equal(DIVERSITY_CAP_DEFAULT, 0.02);
    assert.equal(AI_CAP_DEFAULT, 0.15);
    assert.equal(HUMAN_SHARE_FLOOR, 0.85);
  });

  it('admits a pinned record with exact scores, fingerprint and id', () => {
    const verdict = admitLakeRecord(baseLake(), []);
    assert.deepEqual(verdict, {
      ok: true,
      value: {
        id: 'lr_1',
        sourceKind: 'web-corpus',
        contentHash: 'ch-1',
        creator: 'ada',
        license: 'cc-by-4.0',
        derivedFrom: [],
        method: '',
        depth: 0,
        status: 'accepted',
        provenance: 'human',
        provenanceConfidence: 0.9,
        provenanceMultiplier: 1,
        qualityScore: 0.8,
        rightsScore: 0.9,
        intakeWeight: 0.8,
        fingerprint: 'lakefp_' + fp('web-corpus:ch-1:ada:cc-by-4.0:'),
        createdAt: NOW,
        duplicate: false,
      },
    });
  });

  it('never appends on its own: the caller owns the lake array', () => {
    const lake: LakeRecord[] = [];
    const rec = unwrap(admitLakeRecord(baseLake(), lake));
    assert.equal(lake.length, 0);
    lake.push(rec);
    assert.equal(lake.length, 1);
    const dup = unwrap(admitLakeRecord(baseLake(), lake));
    assert.ok(dup.duplicate);
    assert.equal(dup.id, 'lr_1');
    assert.equal(lake.length, 1);
  });

  it('refuses every bad admit with the named reason and leaves nothing behind', () => {
    const lake: LakeRecord[] = [];
    const cases: Array<[AdmitLakeInput, string]> = [
      [baseLake({ sourceKind: '' }), 'lake-no-source-kind'],
      [baseLake({ contentHash: '' }), 'lake-no-content-hash'],
      [baseLake({ creator: '' }), 'lake-no-creator'],
      [baseLake({ license: '' }), 'lake-no-license'],
      [baseLake({ sourceTermsScore: 1.5 }), 'lake-invalid-score'],
      [baseLake({ consentScore: -0.1 }), 'lake-invalid-score'],
      [baseLake({ provenance: '' as unknown as LakeProvenance }), 'lake-no-provenance'],
      [baseLake({ sourceKind: 'stolen-data' }), 'lake-legal-floor:stolen-data'],
      [baseLake({ sourceKind: 'pirated-dataset' }), 'lake-legal-floor:pirated-dataset'],
      [baseLake({ sourceKind: 'illegal-content' }), 'lake-legal-floor:illegal-content'],
      [baseLake({ sourceKind: 'privacy-violation' }), 'lake-legal-floor:privacy-violation'],
      [baseLake({ method: 'dedup' }), 'lake-no-lineage'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(refusal(admitLakeRecord(input, lake)), expected);
    }
    assert.equal(lake.length, 0);
  });

  it('pins the rights boundaries exactly: 0.4 admits to review, 0.7 accepts, nothing below 0.4 enters', () => {
    const review = unwrap(admitLakeRecord(baseLake({ sourceTermsScore: 0.4, consentScore: 1, licenseScore: 1 }), []));
    assert.equal(review.rightsScore, 0.4);
    assert.equal(review.status, 'review');
    const accepted = unwrap(admitLakeRecord(baseLake({ sourceTermsScore: 0.7, consentScore: 1, licenseScore: 1 }), []));
    assert.equal(accepted.rightsScore, 0.7);
    assert.equal(accepted.status, 'accepted');
    const between = unwrap(admitLakeRecord(baseLake({ sourceTermsScore: 0.5, consentScore: 1, licenseScore: 1 }), []));
    assert.equal(between.rightsScore, 0.5);
    assert.equal(between.status, 'review');
    const refused = refusal(admitLakeRecord(baseLake({ sourceTermsScore: 0.3999, consentScore: 1, licenseScore: 1 }), []));
    assert.equal(refused, 'lake-rights-rejected:0.3999<0.4');
  });

  it('never lets quality gate admission, only weight', () => {
    const zero = unwrap(admitLakeRecord(baseLake({ qualityScore: 0 }), []));
    assert.equal(zero.status, 'accepted');
    assert.equal(zero.intakeWeight, 0);
  });

  it('downgrades low-confidence provenance to unknown but records the raw confidence', () => {
    const down = unwrap(admitLakeRecord(baseLake({ provenance: 'human', provenanceConfidence: 0.59, qualityScore: 0.5 }), []));
    assert.equal(down.provenance, 'unknown');
    assert.equal(down.provenanceMultiplier, 0.2);
    assert.equal(down.provenanceConfidence, 0.59);
    assert.equal(down.intakeWeight, 0.1);
    const kept = unwrap(admitLakeRecord(baseLake({ provenance: 'human', provenanceConfidence: 0.6 }), []));
    assert.equal(kept.provenance, 'human');
    assert.equal(kept.provenanceMultiplier, 1);
    const aiRec = unwrap(admitLakeRecord(baseLake({ provenance: 'ai', provenanceConfidence: 0.9, qualityScore: 1 }), []));
    assert.equal(aiRec.provenanceMultiplier, 0.3);
    assert.equal(aiRec.intakeWeight, 0.3);
    const mixedRec = unwrap(admitLakeRecord(baseLake({ provenance: 'mixed', provenanceConfidence: 0.9, qualityScore: 1 }), []));
    assert.equal(mixedRec.provenanceMultiplier, 0.6);
    assert.equal(mixedRec.intakeWeight, 0.6);
  });

  it('refuses broken lineage pairs by name, in the engine order', () => {
    const lake: LakeRecord[] = [];
    const root = admitNext(lake);
    // parents without a method are refused before the parents are resolved
    assert.equal(refusal(admitLakeRecord(baseLake({ contentHash: 'ch-x1', derivedFrom: [root.id] }), lake)), 'lake-no-method');
    assert.equal(refusal(admitLakeRecord(baseLake({ contentHash: 'ch-x2', derivedFrom: ['lr_42'], method: 'dedup' }), lake)), 'lake-unknown-parent:lr_42');
    // a fresh lake names its first record lr_1, so listing lr_1 as its own parent is refused by name
    assert.equal(refusal(admitLakeRecord(baseLake({ contentHash: 'ch-x3', derivedFrom: ['lr_1'], method: 'dedup' }), [])), 'lake-self-parent');
    assert.equal(lake.length, 1);
  });

  it('walks lineage root-first, each ancestor once, ordered by depth then id', () => {
    const lake: LakeRecord[] = [];
    const root = admitNext(lake);
    const child = admitNext(lake, { derivedFrom: [root.id], method: 'dedup' });
    const grand = admitNext(lake, { derivedFrom: [child.id], method: 'enrich' });
    assert.equal(grand.depth, 2);
    const chain = unwrap(lineageChain(grand.id, lake));
    assert.deepEqual(chain.map((r) => r.id), ['lr_1', 'lr_2', 'lr_3']);
    assert.equal(refusal(lineageChain('lr_99', lake)), 'lake-unknown-record:lr_99');
    // diamond: two children of the same root, one tip from both
    const left = admitNext(lake, { derivedFrom: [root.id], method: 'normalize' });
    const right = admitNext(lake, { derivedFrom: [root.id], method: 'rewrite' });
    const tip = admitNext(lake, { derivedFrom: [left.id, right.id], method: 'merge' });
    assert.equal(tip.depth, 2);
    const diamond = unwrap(lineageChain(tip.id, lake));
    assert.deepEqual(diamond.map((r) => r.id), ['lr_1', 'lr_4', 'lr_5', 'lr_6']);
  });

  it('treats the same manifest as an idempotent duplicate, method aside', () => {
    const lake: LakeRecord[] = [];
    const first = admitNext(lake);
    const dup = unwrap(admitLakeRecord(baseLake(), lake));
    assert.ok(dup.duplicate);
    assert.equal(dup.id, first.id);
    assert.equal(lake.length, 1);
    // method is not part of identity: a duplicate still wins over a lineage refusal
    const dupWithMethod = unwrap(admitLakeRecord(baseLake({ method: 'relabel' }), lake));
    assert.ok(dupWithMethod.duplicate);
    assert.equal(lake.length, 1);
    const second = admitNext(lake, { contentHash: 'ch-2' });
    assert.ok(!second.duplicate);
    assert.equal(second.id, 'lr_2');
    assert.equal(lake.length, 2);
  });

  it('refuses an empty composition and pins the cap order: ai cap, diversity cap, human pause', () => {
    assert.equal(refusal(composeBatch([])), 'lake-empty-batch');
    // ai cap beats diversity even when the triple creator is relaxed away
    const aiHeavy: LakeRecord[] = bigBatch(16, 81);
    for (let i = 0; i < 3; i++) aiHeavy.push(batchRecord('lr_dup' + i, 'human', 'crowd-3'));
    assert.equal(
      refusal(composeBatch(aiHeavy, { relaxedCreators: ['crowd-3'] })),
      'lake-composition-ai-cap:0.16>0.15',
    );
    // diversity cap beats the human pause: both are violated, only diversity is reported
    const pauseBlocked: LakeRecord[] = bigBatch(15, 81);
    for (let i = 0; i < 3; i++) pauseBlocked.push(batchRecord('lr_dup' + i, 'human', 'crowd-3'));
    pauseBlocked.push(batchRecord('lr_m', 'mixed', 'mx-1'));
    assert.equal(
      refusal(composeBatch(pauseBlocked)),
      'lake-composition-diversity-cap:crowd-3:0.03>0.02',
    );
    // relaxed creators do not relax the ai cap
    const aiCapped = bigBatch(16, 84);
    assert.equal(
      refusal(composeBatch(aiCapped, { relaxedCreators: ['ai-0'] })),
      'lake-composition-ai-cap:0.16>0.15',
    );
  });

  it('composes at the exact boundaries: 15 percent ai is legal, 85 percent human is enough', () => {
    const atCap = bigBatch(15, 85);
    assert.equal(atCap.length, 100);
    assert.deepEqual(composeBatch(atCap), {
      ok: true,
      value: { status: 'ok', flag: null, aiShare: 0.15, humanShare: 0.85 },
    });
    // a creator at exactly 2 percent is legal
    const twoPercent: LakeRecord[] = bigBatch(15, 83);
    twoPercent.push(batchRecord('lr_d0', 'human', 'crowd-2'));
    twoPercent.push(batchRecord('lr_d1', 'human', 'crowd-2'));
    assert.equal(twoPercent.length, 100);
    assert.deepEqual(composeBatch(twoPercent), {
      ok: true,
      value: { status: 'ok', flag: null, aiShare: 0.15, humanShare: 0.85 },
    });
    // a creator at 3 percent is refused unless relaxed
    const threePercent: LakeRecord[] = bigBatch(15, 82);
    threePercent.push(batchRecord('lr_d0', 'human', 'crowd-3'));
    threePercent.push(batchRecord('lr_d1', 'human', 'crowd-3'));
    threePercent.push(batchRecord('lr_d2', 'human', 'crowd-3'));
    assert.equal(threePercent.length, 100);
    assert.equal(
      refusal(composeBatch(threePercent)),
      'lake-composition-diversity-cap:crowd-3:0.03>0.02',
    );
    assert.deepEqual(composeBatch(threePercent, { relaxedCreators: ['crowd-3'] }), {
      ok: true,
      value: { status: 'ok', flag: null, aiShare: 0.15, humanShare: 0.85 },
    });
  });

  it('pauses a thin-human batch instead of refusing it, with a named flag', () => {
    const thinHuman = bigBatch(15, 84, [['mx-1', 'mixed']]);
    assert.equal(thinHuman.length, 100);
    const verdict = composeBatch(thinHuman);
    assert.deepEqual(verdict, {
      ok: true,
      value: {
        status: 'paused',
        flag: 'lake-paused-insufficient-human:0.84<0.85',
        aiShare: 0.15,
        humanShare: 0.84,
      },
    });
  });

  it('sweeps random admits against the rights, status, weight and fingerprint oracles', () => {
    const rnd = mulberry32(42);
    const lake: LakeRecord[] = [];
    let admitted = 0;
    for (let i = 0; i < 500; i++) {
      const a = rnd();
      const b = rnd();
      const c = rnd();
      const input = baseLake({
        contentHash: 'ch-' + i,
        creator: 'cr-' + i,
        sourceTermsScore: a,
        consentScore: b,
        licenseScore: c,
      });
      const verdict = admitLakeRecord(input, lake);
      const expectedRights = r4(a * b * c);
      if (expectedRights < RIGHTS_REJECT_FLOOR) {
        assert.equal(refusal(verdict), 'lake-rights-rejected:' + expectedRights + '<' + RIGHTS_REJECT_FLOOR);
        assert.equal(lake.length, admitted);
      } else {
        const rec = unwrap(verdict);
        assert.equal(rec.rightsScore, expectedRights);
        assert.equal(rec.status, expectedRights < RIGHTS_REVIEW_CEILING ? 'review' : 'accepted');
        assert.equal(rec.intakeWeight, r4(0.8 * PROVENANCE_MULTIPLIERS[rec.provenance]));
        const identity = input.sourceKind + ':' + input.contentHash + ':' + input.creator + ':' + input.license + ':' + (input.derivedFrom ?? []).join(',');
        assert.equal(rec.fingerprint, 'lakefp_' + fp(identity));
        lake.push(rec);
        admitted++;
      }
    }
    // the sweep exercised both paths: some refusals and some admits
    assert.ok(admitted > 5);
    assert.ok(admitted < 500);
  });
});

describe('consent engine (FORGE AI-002)', () => {
  function freshState(): ConsentState {
    return { grants: [], ledger: [] };
  }

  function grantInput(overrides: Partial<GrantConsentInput> = {}): GrantConsentInput {
    return {
      workspace: 'ws-1',
      user: 'subject-1',
      dataType: 'preference',
      purpose: 'training',
      now: NOW,
      ...overrides,
    };
  }

  it('denies by default and a check never mutates state', () => {
    const state = freshState();
    assert.deepEqual(checkConsent({ workspace: 'ws-1', user: 'subject-1', dataType: 'preference', now: NOW }, state), {
      ok: true,
      value: { granted: false, state: 'denied', grantId: null, expiresAt: null },
    });
    assert.equal(state.grants.length, 0);
    assert.equal(state.ledger.length, 0);
  });

  it('grants with a deterministic id, fingerprint and one ledger event', () => {
    const state = freshState();
    const rec = unwrap(grantConsent(grantInput(), state));
    assert.deepEqual(rec, {
      grantId: 'cgr_1',
      workspace: 'ws-1',
      user: 'subject-1',
      dataType: 'preference',
      purpose: 'training',
      grantedAt: NOW,
      expiresAt: null,
      revokedAt: null,
      supersededAt: null,
      regrants: 0,
      fingerprint: 'csntfp_' + fp('ws-1:subject-1:preference:training:' + NOW),
      duplicate: false,
    });
    assert.deepEqual(state.ledger, [
      { eventId: 'cev_1', kind: 'grant', grantId: 'cgr_1', workspace: 'ws-1', user: 'subject-1', dataType: 'preference', at: NOW },
    ]);
    assert.equal(state.grants.length, 1);
  });

  it('is idempotent while a grant is active, whatever the purpose', () => {
    const state = freshState();
    unwrap(grantConsent(grantInput(), state));
    const dup = unwrap(grantConsent(grantInput({ purpose: 'other-purpose' }), state));
    assert.ok(dup.duplicate);
    assert.equal(dup.grantId, 'cgr_1');
    assert.equal(dup.purpose, 'training');
    assert.equal(state.grants.length, 1);
    assert.equal(state.ledger.length, 1);
  });

  it('refuses expiry at or before now and leaves state untouched', () => {
    const state = freshState();
    assert.equal(refusal(grantConsent(grantInput({ expiresAt: NOW }), state)), 'consent-expiry-in-past:' + NOW + '<=' + NOW);
    assert.equal(refusal(grantConsent(grantInput({ expiresAt: NOW - 1 }), state)), 'consent-expiry-in-past:' + (NOW - 1) + '<=' + NOW);
    assert.equal(state.grants.length, 0);
    assert.equal(state.ledger.length, 0);
  });

  it('refuses bad grants and checks with the named reasons', () => {
    const state = freshState();
    const cases: Array<[GrantConsentInput, string]> = [
      [grantInput({ workspace: '' }), 'consent-no-workspace'],
      [grantInput({ user: '' }), 'consent-no-user'],
      [grantInput({ dataType: '' }), 'consent-no-data-type'],
      [grantInput({ purpose: '' }), 'consent-no-purpose'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(refusal(grantConsent(input, state)), expected);
    }
    const checkCases: Array<[Parameters<typeof checkConsent>[0], string]> = [
      [{ workspace: '', user: 'subject-1', dataType: 'preference', now: NOW }, 'consent-no-workspace'],
      [{ workspace: 'ws-1', user: '', dataType: 'preference', now: NOW }, 'consent-no-user'],
      [{ workspace: 'ws-1', user: 'subject-1', dataType: '', now: NOW }, 'consent-no-data-type'],
    ];
    for (const [input, expected] of checkCases) {
      assert.equal(refusal(checkConsent(input, state)), expected);
    }
    assert.equal(state.grants.length, 0);
    assert.equal(state.ledger.length, 0);
  });

  it('revokes immediately, names the triple when there is nothing to revoke', () => {
    const state = freshState();
    unwrap(grantConsent(grantInput(), state));
    assert.deepEqual(revokeConsent({ workspace: 'ws-1', user: 'subject-1', dataType: 'preference', now: NOW + 5 }, state), {
      ok: true,
      value: { grantId: 'cgr_1', revokedAt: NOW + 5 },
    });
    const check = unwrap(checkConsent({ workspace: 'ws-1', user: 'subject-1', dataType: 'preference', now: NOW + 6 }, state));
    assert.equal(check.state, 'denied');
    assert.equal(check.granted, false);
    assert.equal(refusal(revokeConsent({ workspace: 'ws-1', user: 'subject-1', dataType: 'preference', now: NOW + 7 }, state)), 'consent-no-active-grant:ws-1:subject-1:preference');
    assert.equal(refusal(revokeConsent({ workspace: 'ws-9', user: 'ghost', dataType: 'ghost', now: NOW + 8 }, state)), 'consent-no-active-grant:ws-9:ghost:ghost');
    assert.equal(state.ledger.length, 2);
    const revokeEvent = state.ledger[1];
    assert.deepEqual(revokeEvent, { eventId: 'cev_2', kind: 'revoke', grantId: 'cgr_1', workspace: 'ws-1', user: 'subject-1', dataType: 'preference', at: NOW + 5 });
  });

  it('audits a re-grant after revoke as a new grant with a regrant count', () => {
    const state = freshState();
    unwrap(grantConsent(grantInput(), state));
    unwrap(revokeConsent({ workspace: 'ws-1', user: 'subject-1', dataType: 'preference', now: NOW + 5 }, state));
    const regrant = unwrap(grantConsent(grantInput({ purpose: 'training-v2' }), state));
    assert.equal(regrant.grantId, 'cgr_2');
    assert.equal(regrant.regrants, 1);
    assert.equal(regrant.revokedAt, null);
    assert.ok(!regrant.duplicate);
    const check = unwrap(checkConsent({ workspace: 'ws-1', user: 'subject-1', dataType: 'preference', now: NOW + 6 }, state));
    assert.equal(check.state, 'granted');
    assert.equal(check.grantId, 'cgr_2');
    assert.equal(state.grants.length, 2);
    assert.equal(state.ledger.length, 3);
  });

  it('reads an expired grant as expired, and expiry is inclusive of the deadline', () => {
    const state = freshState();
    unwrap(grantConsent(grantInput({ expiresAt: NOW + 1000 }), state));
    const before = unwrap(checkConsent({ workspace: 'ws-1', user: 'subject-1', dataType: 'preference', now: NOW + 999 }, state));
    assert.equal(before.state, 'granted');
    assert.equal(before.granted, true);
    const atDeadline = unwrap(checkConsent({ workspace: 'ws-1', user: 'subject-1', dataType: 'preference', now: NOW + 1000 }, state));
    assert.deepEqual(atDeadline, { granted: false, state: 'expired', grantId: 'cgr_1', expiresAt: NOW + 1000 });
    // an expired grant cannot be revoked, only superseded by a new grant
    assert.equal(refusal(revokeConsent({ workspace: 'ws-1', user: 'subject-1', dataType: 'preference', now: NOW + 1000 }, state)), 'consent-no-active-grant:ws-1:subject-1:preference');
  });

  it('supersedes an expired grant on re-grant so it can never resurface', () => {
    const state = freshState();
    const first = unwrap(grantConsent(grantInput({ expiresAt: NOW + 1000 }), state));
    // time passes the first deadline, then the subject re-grants
    const second = unwrap(grantConsent(grantInput({ expiresAt: NOW + 3000, now: NOW + 2000 }), state));
    assert.equal(second.grantId, 'cgr_2');
    assert.equal(second.regrants, 1);
    const firstAfter = state.grants.find((g) => g.grantId === first.grantId);
    assert.equal(firstAfter?.supersededAt, NOW + 2000);
    // revoke the live grant: the superseded one must not come back
    unwrap(revokeConsent({ workspace: 'ws-1', user: 'subject-1', dataType: 'preference', now: NOW + 4000 }, state));
    const check = unwrap(checkConsent({ workspace: 'ws-1', user: 'subject-1', dataType: 'preference', now: NOW + 5000 }, state));
    assert.equal(check.state, 'denied');
    assert.equal(check.grantId, null);
  });

  it('filters the ledger and always returns copies', () => {
    const state = freshState();
    unwrap(grantConsent(grantInput(), state));
    unwrap(grantConsent(grantInput({ user: 'subject-2' }), state));
    unwrap(revokeConsent({ workspace: 'ws-1', user: 'subject-2', dataType: 'preference', now: NOW + 1 }, state));
    const all = consentLedger(state);
    assert.equal(all.length, 3);
    const revokes = consentLedger(state, { kind: 'revoke' });
    assert.equal(revokes.length, 1);
    assert.equal(revokes[0]?.user, 'subject-2');
    const forUser = consentLedger(state, { user: 'subject-1' });
    assert.equal(forUser.length, 1);
    const forType = consentLedger(state, { dataType: 'preference' });
    assert.equal(forType.length, 3);
    const head = all[0];
    if (head !== undefined) all.push(head);
    assert.equal(state.ledger.length, 3);
  });

  it('sweeps grant expiry against the oracle: granted strictly before the deadline', () => {
    const rnd = mulberry32(42);
    const state = freshState();
    for (let i = 0; i < 200; i++) {
      const dataType = 'dt-' + i;
      const deadline = NOW + 1 + Math.floor(rnd() * 5000);
      unwrap(grantConsent(grantInput({ dataType, expiresAt: deadline }), state));
      const t = NOW + Math.floor(rnd() * 6000);
      const check = unwrap(checkConsent({ workspace: 'ws-1', user: 'subject-1', dataType, now: t }, state));
      if (t < deadline) {
        assert.equal(check.state, 'granted');
        assert.equal(check.granted, true);
        assert.equal(check.expiresAt, deadline);
      } else {
        assert.equal(check.state, 'expired');
        assert.equal(check.granted, false);
      }
    }
    // checks never mutate: exactly one grant per iteration
    assert.equal(state.grants.length, 200);
    assert.equal(state.ledger.length, 200);
  });
});

describe('synthetic engine (FORGE AI-007)', () => {
  const gen = { model: 'forge-gen', version: '1.0', seed: 42 };

  function synInput(overrides: Partial<RegisterSyntheticInput> = {}): RegisterSyntheticInput {
    return { provenance: 'synthetic', generator: gen, bases: [], now: NOW, ...overrides };
  }

  it('registers a baseless manifest with the derived hash and fingerprint', () => {
    const rec = unwrap(registerSynthetic(synInput(), [], []));
    const contentHash = 'syn_' + fp('forge-gen:1.0:42:');
    assert.deepEqual(rec, {
      synId: 'syn_1',
      contentHash,
      generator: { model: 'forge-gen', version: '1.0', seed: 42 },
      bases: [],
      depth: 0,
      provenance: 'synthetic',
      fingerprint: 'sfp_' + fp('forge-gen:1.0:42:' + contentHash + ':'),
      createdAt: NOW,
      duplicate: false,
    });
  });

  it('refuses unattributed or half-declared generations by name', () => {
    const cases: Array<[RegisterSyntheticInput, string]> = [
      [synInput({ provenance: 'human' }), 'synthetic-unattributed:human'],
      [synInput({ provenance: 'ai' }), 'synthetic-unattributed:ai'],
      [synInput({ generator: undefined }), 'synthetic-no-generator-model'],
      [synInput({ generator: { model: '', version: '1.0', seed: 42 } }), 'synthetic-no-generator-model'],
      [synInput({ generator: { model: 'forge-gen', version: '', seed: 42 } }), 'synthetic-no-generator-version'],
      [synInput({ generator: { model: 'forge-gen', version: '1.0', seed: NaN } }), 'synthetic-no-seed'],
      [synInput({ bases: 'not-a-list' as unknown as string[] }), 'synthetic-bases-not-list'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(refusal(registerSynthetic(input, [], [])), expected);
    }
  });

  it('refuses self-bases and unknown bases, and never touches the registries', () => {
    const one: SyntheticRecord[] = [];
    const first = unwrap(registerSynthetic(synInput(), one, []));
    one.push(first);
    // a registry with one record names its next record syn_2, so listing it is a self-base
    assert.equal(refusal(registerSynthetic(synInput({ bases: ['syn_2'] }), one, [])), 'synthetic-self-base');
    assert.equal(refusal(registerSynthetic(synInput({ bases: ['lr_ghost'] }), one, [])), 'synthetic-unknown-base:lr_ghost');
    assert.equal(one.length, 1);
  });

  it('derives depth from existing bases, lake or synthetic, taking the deepest', () => {
    const lake = [{ lakeId: 'lr_1', depth: 0 }, { lakeId: 'lr_2', depth: 4 }];
    const syn: SyntheticRecord[] = [];
    const fromLake = unwrap(registerSynthetic(synInput({ bases: ['lr_1'] }), syn, lake));
    assert.equal(fromLake.depth, 1);
    syn.push(fromLake);
    const fromSyn = unwrap(registerSynthetic(synInput({ bases: ['syn_1'] }), syn, lake));
    assert.equal(fromSyn.depth, 2);
    syn.push(fromSyn);
    const mixed = unwrap(registerSynthetic(synInput({ bases: ['lr_1', 'syn_2'] }), syn, lake));
    assert.equal(mixed.depth, 3);
    syn.push(mixed);
    const deepest = unwrap(registerSynthetic(synInput({ bases: ['lr_2'] }), syn, lake));
    assert.equal(deepest.depth, 5);
  });

  it('re-registers the same manifest as an idempotent duplicate; seed and base order are identity', () => {
    const syn: SyntheticRecord[] = [];
    const first = unwrap(registerSynthetic(synInput(), syn, []));
    syn.push(first);
    const dup = unwrap(registerSynthetic(synInput(), syn, []));
    assert.ok(dup.duplicate);
    assert.equal(dup.synId, 'syn_1');
    const otherSeed = unwrap(registerSynthetic(synInput({ generator: { model: 'forge-gen', version: '1.0', seed: 43 } }), syn, []));
    assert.ok(!otherSeed.duplicate);
    assert.equal(otherSeed.synId, 'syn_2');
    syn.push(otherSeed);
    assert.equal(syn.length, 2);
  });

  it('walks the chain root-first across both registries, depth then id', () => {
    const lake = [{ lakeId: 'lr_1', depth: 0 }];
    const syn: SyntheticRecord[] = [];
    const base = unwrap(registerSynthetic(synInput({ bases: ['lr_1'] }), syn, lake));
    syn.push(base);
    const derived = unwrap(registerSynthetic(synInput({ bases: ['syn_1'] }), syn, lake));
    syn.push(derived);
    const chain = unwrap(syntheticChain('syn_2', syn, lake));
    assert.deepEqual(chain, [
      { id: 'lr_1', kind: 'lake', depth: 0 },
      { id: 'syn_1', kind: 'synthetic', depth: 1 },
      { id: 'syn_2', kind: 'synthetic', depth: 2 },
    ]);
    assert.equal(refusal(syntheticChain('syn_99', syn, lake)), 'synthetic-unknown-record:syn_99');
  });

  it('sweeps manifests against the hash, fingerprint and depth oracles', () => {
    const rnd = mulberry32(42);
    const lake = [{ lakeId: 'lr_1', depth: 0 }, { lakeId: 'lr_2', depth: 7 }];
    const syn: SyntheticRecord[] = [];
    const models = ['forge-gen', 'mistral-7b', 'mixtral-8x7b'];
    const versions = ['1.0', '2.1', '0.9-rc'];
    for (let i = 0; i < 200; i++) {
      const model = models[Math.floor(rnd() * models.length)] ?? 'forge-gen';
      const version = versions[Math.floor(rnd() * versions.length)] ?? '1.0';
      const seed = Math.floor(rnd() * 100000);
      const basePool = ['lr_1', 'lr_2', ...syn.map((r) => r.synId)];
      const bases = rnd() < 0.5 ? [basePool[Math.floor(rnd() * basePool.length)] ?? 'lr_1'] : [];
      const rec = unwrap(registerSynthetic(synInput({ generator: { model, version, seed }, bases }), syn, lake));
      const contentHash = 'syn_' + fp(model + ':' + version + ':' + seed + ':' + bases.join(','));
      assert.equal(rec.contentHash, contentHash);
      assert.equal(rec.fingerprint, 'sfp_' + fp(model + ':' + version + ':' + seed + ':' + contentHash + ':' + bases.join(',')));
      const baseDepth = (b: string): number => (b === 'lr_1' ? 0 : b === 'lr_2' ? 7 : syn.find((r) => r.synId === b)?.depth ?? -1);
      const expectedDepth = bases.length === 0 ? 0 : Math.max(...bases.map((b) => baseDepth(b))) + 1;
      assert.equal(rec.depth, expectedDepth);
      syn.push(rec);
    }
    assert.equal(syn.length, 200);
  });
});

describe('labeling engine (FORGE AI-008)', () => {
  function labelInput(overrides: Partial<RegisterLabelInput> = {}): RegisterLabelInput {
    return { batchId: 'batch-1', labeler: 'ada', ranking: ['a', 'b', 'c'], now: NOW, ...overrides };
  }

  it('registers a label with a deterministic id and never mutates the registry', () => {
    const registry: LabelRecord[] = [];
    const rec = unwrap(registerLabel(labelInput(), registry));
    assert.deepEqual(rec, {
      labelId: 'lbl_1',
      batchId: 'batch-1',
      labeler: 'ada',
      ranking: ['a', 'b', 'c'],
      createdAt: NOW,
    });
    assert.equal(registry.length, 0);
    registry.push(rec);
    assert.equal(registry.length, 1);
  });

  it('refuses bad labels with the named reasons', () => {
    const cases: Array<[RegisterLabelInput, string]> = [
      [labelInput({ batchId: '' }), 'labeling-no-batch'],
      [labelInput({ labeler: '' }), 'labeling-no-labeler'],
      [labelInput({ ranking: 'x' as unknown as string[] }), 'labeling-ranking-not-list'],
      [labelInput({ ranking: [] }), 'labeling-empty-ranking'],
      [labelInput({ ranking: ['a', '', 'c'] }), 'labeling-empty-ranking'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(refusal(registerLabel(input, [])), expected);
    }
  });

  it('takes one label per labeler per batch and refuses the second by name', () => {
    const registry: LabelRecord[] = [];
    const first = unwrap(registerLabel(labelInput(), registry));
    registry.push(first);
    assert.equal(refusal(registerLabel(labelInput(), registry)), 'labeling-duplicate-label:batch-1:ada');
    const otherBatch = unwrap(registerLabel(labelInput({ batchId: 'batch-2' }), registry));
    registry.push(otherBatch);
    const otherLabeler = unwrap(registerLabel(labelInput({ labeler: 'bob' }), registry));
    registry.push(otherLabeler);
    assert.equal(registry.length, 3);
  });

  it('counts Borda points exactly: rank i earns m - 1 - i', () => {
    const registry: LabelRecord[] = [
      { labelId: 'lbl_1', batchId: 'b', labeler: 'ada', ranking: ['a', 'b', 'c'], createdAt: NOW },
    ];
    const verdict = bordaCount('b', registry);
    assert.deepEqual(verdict, {
      ok: true,
      value: {
        batchId: 'b',
        labelers: 1,
        ordered: [
          { candidate: 'a', points: 2 },
          { candidate: 'b', points: 1 },
          { candidate: 'c', points: 0 },
        ],
        winner: 'a',
      },
    });
  });

  it('breaks exact ties by candidate name ascending, so the outcome is deterministic', () => {
    const registry: LabelRecord[] = [
      { labelId: 'lbl_1', batchId: 'b', labeler: 'ada', ranking: ['a', 'b', 'c'], createdAt: NOW },
      { labelId: 'lbl_2', batchId: 'b', labeler: 'bob', ranking: ['c', 'b', 'a'], createdAt: NOW },
    ];
    const result = unwrap(bordaCount('b', registry));
    assert.deepEqual(result.ordered, [
      { candidate: 'a', points: 2 },
      { candidate: 'b', points: 2 },
      { candidate: 'c', points: 2 },
    ]);
    assert.equal(result.winner, 'a');
    assert.equal(result.labelers, 2);
  });

  it('tallies only the named batch and refuses an empty one', () => {
    const registry: LabelRecord[] = [
      { labelId: 'lbl_1', batchId: 'b1', labeler: 'ada', ranking: ['a', 'b'], createdAt: NOW },
      { labelId: 'lbl_2', batchId: 'b2', labeler: 'ada', ranking: ['x', 'y'], createdAt: NOW },
    ];
    const b1 = unwrap(bordaCount('b1', registry));
    assert.deepEqual(b1.ordered, [
      { candidate: 'a', points: 1 },
      { candidate: 'b', points: 0 },
    ]);
    const b2 = unwrap(bordaCount('b2', registry));
    assert.equal(b2.winner, 'x');
    assert.equal(refusal(bordaCount('ghost', registry)), 'labeling-no-labels:ghost');
    assert.equal(refusal(bordaCount('', registry)), 'labeling-no-batch');
  });

  it('sweeps random ballots against a reference Borda count', () => {
    const rnd = mulberry32(42);
    function referenceBorda(ballots: string[][]): Array<{ candidate: string; points: number }> {
      const totals = new Map<string, number>();
      for (const ballot of ballots) {
        for (let i = 0; i < ballot.length; i++) {
          const c = ballot[i];
          if (c === undefined) continue;
          totals.set(c, (totals.get(c) ?? 0) + (ballot.length - 1 - i));
        }
      }
      return Array.from(totals.entries())
        .map(([candidate, points]) => ({ candidate, points }))
        .sort((x, y) => y.points - x.points || (x.candidate < y.candidate ? -1 : x.candidate > y.candidate ? 1 : 0));
    }
    const pool = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (let iter = 0; iter < 200; iter++) {
      const ballots: string[][] = [];
      const voterCount = 1 + Math.floor(rnd() * 5);
      for (let v = 0; v < voterCount; v++) {
        const shuffled = [...pool];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          const tmp = shuffled[i];
          const other = shuffled[j];
          if (tmp !== undefined && other !== undefined) {
            shuffled[i] = other;
            shuffled[j] = tmp;
          }
        }
        ballots.push(shuffled.slice(0, 1 + Math.floor(rnd() * 5)));
      }
      const registry: LabelRecord[] = ballots.map((ranking, i) => ({
        labelId: 'lbl_' + (i + 1),
        batchId: 'sweep',
        labeler: 'labeler-' + i,
        ranking,
        createdAt: NOW,
      }));
      const result = unwrap(bordaCount('sweep', registry));
      const reference = referenceBorda(ballots);
      assert.deepEqual(result.ordered, reference);
      assert.equal(result.winner, reference[0]?.candidate ?? '');
      assert.equal(result.labelers, ballots.length);
    }
  });
});
