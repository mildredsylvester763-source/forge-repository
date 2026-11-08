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
import {
  preferencesFor,
  PREFERENCE_SIGNALS,
  storePreference,
  type PreferenceRecord,
  type StorePreferenceInput,
} from '../src/modules/training-data/engine/preference-engine.ts';
import {
  CODE_DATA_KINDS,
  DEPLOY_TERMINAL_STATES,
  DEPLOY_TRANSITIONS,
  registerCodeData,
  updateDeployState,
  type CodeDataRecord,
  type RegisterCodeDataInput,
  type UpdateDeployStateInput,
} from '../src/modules/training-data/engine/codedata-engine.ts';
import {
  approveWork,
  CREATIVE_MEDIA,
  CREATIVE_TERMINAL_STATUSES,
  publishWork,
  registerCreativeWork,
  rejectWork,
  submitRevision,
  type CreativeWork,
  type RegisterCreativeInput,
} from '../src/modules/training-data/engine/creative-engine.ts';
import {
  decodeIndices,
  encodeText,
  registerTokenizer,
  TOKENIZER_VOCAB_MAX,
  tokenizerById,
  trainTokenizer,
  type TokenizerRecord,
  type TrainTokenizerInput,
} from '../src/modules/training-data/engine/tokenizer-engine.ts';

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
    unwrap(revokeConsent({ workspace: 'ws-1', user: 'subject-1', dataType: 'preference', now: NOW + 2500 }, state));
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

describe('preference engine (FORGE AI-009)', () => {
  function prefInput(overrides: Partial<StorePreferenceInput> = {}): StorePreferenceInput {
    return { user: 'u1', item: 'item-1', signal: 'like', consent: { granted: true }, now: NOW, ...overrides };
  }

  function push(rec: PreferenceRecord & { duplicate: boolean }, store: PreferenceRecord[]): void {
    store.push({ prefId: rec.prefId, user: rec.user, item: rec.item, signal: rec.signal, fingerprint: rec.fingerprint, createdAt: rec.createdAt });
  }

  it('pins the signal vocabulary exactly: explicit signals only, never inferred', () => {
    assert.deepEqual(PREFERENCE_SIGNALS, ['like', 'dislike', 'skip']);
  });

  it('stores a pinned record with exact id and fingerprint, and never mutates the store', () => {
    const store: PreferenceRecord[] = [];
    assert.deepEqual(storePreference(prefInput(), store), {
      ok: true,
      value: {
        prefId: 'prf_1',
        user: 'u1',
        item: 'item-1',
        signal: 'like',
        fingerprint: 'pfp_' + fp('u1:item-1:like'),
        createdAt: NOW,
        duplicate: false,
      },
    });
    assert.equal(store.length, 0);
    const first = unwrap(storePreference(prefInput(), store));
    push(first, store);
    const dup = unwrap(storePreference(prefInput(), store));
    assert.ok(dup.duplicate);
    assert.equal(dup.prefId, 'prf_1');
    assert.equal(store.length, 1);
    const second = unwrap(storePreference(prefInput({ item: 'item-2', signal: 'dislike' }), store));
    assert.ok(!second.duplicate);
    assert.equal(second.prefId, 'prf_2');
    assert.equal(second.fingerprint, 'pfp_' + fp('u1:item-2:dislike'));
    assert.equal(store.length, 1);
  });

  it('refuses every bad signal with the named reason, in the engine order, and leaves nothing behind', () => {
    const store: PreferenceRecord[] = [];
    const cases: Array<[StorePreferenceInput, string]> = [
      [prefInput({ user: '' }), 'preference-no-user'],
      [prefInput({ item: '' }), 'preference-no-item'],
      [prefInput({ signal: undefined as unknown as string }), 'preference-no-signal'],
      [prefInput({ signal: 'upvote' }), 'preference-invalid-signal:upvote'],
      [prefInput({ consent: undefined as unknown as { granted: boolean } }), 'preference-no-consent'],
      [prefInput({ consent: { granted: false } }), 'preference-consent-required'],
      [prefInput({ now: NaN }), 'preference-no-now'],
      // the engine order: the signal is validated before the consent is read, the consent before the clock
      [prefInput({ signal: 'upvote', consent: { granted: false } }), 'preference-invalid-signal:upvote'],
      [prefInput({ consent: { granted: false }, now: NaN }), 'preference-consent-required'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(refusal(storePreference(input, store)), expected);
    }
    assert.equal(refusal(storePreference(undefined as unknown as StorePreferenceInput, store)), 'preference-no-input');
    assert.equal(store.length, 0);
  });

  it('keys identity on the full triple: same signal idempotent, any variation a new record', () => {
    const store: PreferenceRecord[] = [];
    push(unwrap(storePreference(prefInput(), store)), store);
    const dup = unwrap(storePreference(prefInput(), store));
    assert.ok(dup.duplicate);
    assert.equal(dup.prefId, 'prf_1');
    assert.equal(store.length, 1);
    const otherSignal = unwrap(storePreference(prefInput({ signal: 'dislike' }), store));
    assert.ok(!otherSignal.duplicate);
    assert.equal(otherSignal.prefId, 'prf_2');
    assert.equal(otherSignal.fingerprint, 'pfp_' + fp('u1:item-1:dislike'));
    push(otherSignal, store);
    const otherItem = unwrap(storePreference(prefInput({ item: 'item-2' }), store));
    assert.ok(!otherItem.duplicate);
    assert.equal(otherItem.prefId, 'prf_3');
    assert.equal(otherItem.fingerprint, 'pfp_' + fp('u1:item-2:like'));
    push(otherItem, store);
    const otherUser = unwrap(storePreference(prefInput({ user: 'u2' }), store));
    assert.ok(!otherUser.duplicate);
    assert.equal(otherUser.prefId, 'prf_4');
    assert.equal(otherUser.fingerprint, 'pfp_' + fp('u2:item-1:like'));
    push(otherUser, store);
    assert.equal(store.length, 4);
    // the caller owns the array: ids number by appended records, so every variation is now idempotent
    assert.ok(unwrap(storePreference(prefInput({ signal: 'dislike' }), store)).duplicate);
    assert.ok(unwrap(storePreference(prefInput({ item: 'item-2' }), store)).duplicate);
    assert.ok(unwrap(storePreference(prefInput({ user: 'u2' }), store)).duplicate);
    assert.equal(store.length, 4);
  });

  it('never infers: one item can carry contradictory signals at once, each its own record', () => {
    const store: PreferenceRecord[] = [];
    const fingerprints = new Set<string>();
    for (const signal of ['like', 'dislike', 'skip'] as const) {
      const rec = unwrap(storePreference(prefInput({ signal }), store));
      assert.ok(!rec.duplicate);
      fingerprints.add(rec.fingerprint);
    }
    assert.equal(fingerprints.size, 3);
    assert.equal(store.length, 0);
  });

  it('reads one user back as copies only: never a reference, never a mutation', () => {
    const store: PreferenceRecord[] = [];
    push(unwrap(storePreference(prefInput(), store)), store);
    push(unwrap(storePreference(prefInput({ item: 'item-2', signal: 'skip' }), store)), store);
    push(unwrap(storePreference(prefInput({ user: 'u2', signal: 'dislike' }), store)), store);
    push(unwrap(storePreference(prefInput({ user: 'u2', item: 'item-9' }), store)), store);
    const u1 = preferencesFor('u1', store);
    assert.equal(u1.length, 2);
    assert.deepEqual(u1.map((p) => p.prefId), ['prf_1', 'prf_2']);
    assert.deepEqual(u1.map((p) => p.item), ['item-1', 'item-2']);
    assert.deepEqual(preferencesFor('u2', store).map((p) => p.signal), ['dislike', 'like']);
    assert.deepEqual(preferencesFor('ghost', store), []);
    const head = u1[0];
    if (head !== undefined) {
      head.signal = 'dislike';
      assert.equal(store[0]?.signal, 'like');
    }
    u1.pop();
    assert.equal(store.length, 4);
  });

  it('sweeps random preference stores against the fingerprint and id oracles', () => {
    const rnd = mulberry32(42);
    const store: PreferenceRecord[] = [];
    const users = ['u1', 'u2', 'u3'];
    const items = ['it-a', 'it-b', 'it-c', 'it-d'];
    let stored = 0;
    for (let i = 0; i < 200; i++) {
      const user = users[Math.floor(rnd() * users.length)] ?? 'u1';
      const item = items[Math.floor(rnd() * items.length)] ?? 'it-a';
      const signal = PREFERENCE_SIGNALS[Math.floor(rnd() * PREFERENCE_SIGNALS.length)] ?? 'like';
      const rec = unwrap(storePreference({ user, item, signal, consent: { granted: true }, now: NOW }, store));
      const fingerprint = 'pfp_' + fp(user + ':' + item + ':' + signal);
      const existing = store.find((p) => p.fingerprint === fingerprint);
      if (existing) {
        assert.ok(rec.duplicate);
        assert.equal(rec.prefId, existing.prefId);
        assert.equal(store.length, stored);
      } else {
        assert.ok(!rec.duplicate);
        assert.equal(rec.prefId, 'prf_' + (stored + 1));
        assert.equal(rec.fingerprint, fingerprint);
        push(rec, store);
        stored++;
      }
      if (rnd() < 0.25) {
        // re-submitting the exact same signal never appends and never re-numbers
        const again = unwrap(storePreference({ user, item, signal, consent: { granted: true }, now: NOW + i }, store));
        assert.ok(again.duplicate);
        assert.equal(again.prefId, rec.prefId);
      }
    }
    // the sweep exercised fresh records and duplicates across a bounded identity space
    assert.ok(stored >= 10);
    assert.ok(stored <= users.length * items.length * PREFERENCE_SIGNALS.length);
    assert.equal(store.length, stored);
  });
});

describe('codedata engine (FORGE AI-010)', () => {
  function codeInput(overrides: Partial<RegisterCodeDataInput> = {}): RegisterCodeDataInput {
    return { kind: 'diff', contentHash: 'h1', author: 'author-a', now: NOW, ...overrides };
  }

  function pushCode(rec: CodeDataRecord & { duplicate: boolean }, registry: CodeDataRecord[]): void {
    registry.push({
      codeId: rec.codeId,
      kind: rec.kind,
      contentHash: rec.contentHash,
      author: rec.author,
      parentCode: rec.parentCode,
      failingTestId: rec.failingTestId,
      state: rec.state,
      fingerprint: rec.fingerprint,
      createdAt: rec.createdAt,
    });
  }

  it('pins the kind vocabulary, the transition table and the terminal states exactly', () => {
    assert.deepEqual(CODE_DATA_KINDS, ['diff', 'fix', 'review', 'test', 'deploy']);
    assert.deepEqual(DEPLOY_TRANSITIONS, {
      pending: ['running', 'aborted', 'failed'],
      running: ['succeeded', 'failed', 'rolled-back', 'aborted'],
    });
    assert.deepEqual(DEPLOY_TERMINAL_STATES, ['succeeded', 'failed', 'rolled-back', 'aborted']);
  });

  it('registers a pinned diff with the exact id and fingerprint, and never mutates the registry', () => {
    const registry: CodeDataRecord[] = [];
    assert.deepEqual(registerCodeData(codeInput(), registry), {
      ok: true,
      value: {
        codeId: 'cd_1',
        kind: 'diff',
        contentHash: 'h1',
        author: 'author-a',
        parentCode: null,
        failingTestId: null,
        state: null,
        fingerprint: 'cdfp_' + fp('diff:h1:author-a::'),
        createdAt: NOW,
        duplicate: false,
      },
    });
    assert.equal(registry.length, 0);
    pushCode(unwrap(registerCodeData(codeInput(), registry)), registry);
    const dup = unwrap(registerCodeData(codeInput(), registry));
    assert.ok(dup.duplicate);
    assert.equal(dup.codeId, 'cd_1');
    assert.equal(registry.length, 1);
    const second = unwrap(registerCodeData(codeInput({ kind: 'review', contentHash: 'h2' }), registry));
    assert.ok(!second.duplicate);
    assert.equal(second.codeId, 'cd_2');
    assert.equal(second.fingerprint, 'cdfp_' + fp('review:h2:author-a::'));
  });

  it('refuses every bad manifest with the named reason, in the engine order, and leaves nothing behind', () => {
    const registry: CodeDataRecord[] = [];
    const cases: Array<[RegisterCodeDataInput, string]> = [
      [codeInput({ kind: '' }), 'codedata-no-kind'],
      [codeInput({ kind: 'patch' }), 'codedata-invalid-kind:patch'],
      [codeInput({ contentHash: '' }), 'codedata-no-content-hash'],
      [codeInput({ author: '' }), 'codedata-no-author'],
      [codeInput({ now: NaN }), 'codedata-no-now'],
      [codeInput({ kind: 'fix' }), 'codedata-fix-no-test'],
      // the engine order: the fix rule fires before the parent is resolved
      [codeInput({ kind: 'fix', parentCode: 'cd_99' }), 'codedata-fix-no-test'],
      [codeInput({ parentCode: 'cd_99' }), 'codedata-unknown-parent:cd_99'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(refusal(registerCodeData(input, registry)), expected);
    }
    assert.equal(refusal(registerCodeData(undefined as unknown as RegisterCodeDataInput, registry)), 'codedata-no-input');
    assert.equal(registry.length, 0);
  });

  it('pins a fix to its failing test, and ignores the test field for every other kind', () => {
    const registry: CodeDataRecord[] = [];
    pushCode(unwrap(registerCodeData(codeInput(), registry)), registry);
    const fix = unwrap(registerCodeData(codeInput({ kind: 'fix', contentHash: 'h2', parentCode: 'cd_1', failingTestId: 'ft-1' }), registry));
    assert.equal(fix.codeId, 'cd_2');
    assert.equal(fix.parentCode, 'cd_1');
    assert.equal(fix.failingTestId, 'ft-1');
    assert.equal(fix.fingerprint, 'cdfp_' + fp('fix:h2:author-a:cd_1:ft-1'));
    pushCode(fix, registry);
    // the failing test is part of a fix's identity: a different test is a different fix
    const otherTest = unwrap(registerCodeData(codeInput({ kind: 'fix', contentHash: 'h2', parentCode: 'cd_1', failingTestId: 'ft-2' }), registry));
    assert.ok(!otherTest.duplicate);
    assert.equal(otherTest.codeId, 'cd_3');
    pushCode(otherTest, registry);
    // but for any other kind the field is not identity and not stored at all
    const review = unwrap(registerCodeData(codeInput({ kind: 'review', contentHash: 'h3', failingTestId: 'ft-9' }), registry));
    assert.equal(review.failingTestId, null);
    pushCode(review, registry);
    const reviewAgain = unwrap(registerCodeData(codeInput({ kind: 'review', contentHash: 'h3' }), registry));
    assert.ok(reviewAgain.duplicate);
    assert.equal(reviewAgain.codeId, review.codeId);
    assert.equal(registry.length, 4);
  });

  it('chains children onto existing parents only, so every chain is well formed', () => {
    const registry: CodeDataRecord[] = [];
    const root = unwrap(registerCodeData(codeInput(), registry));
    pushCode(root, registry);
    const child = unwrap(registerCodeData(codeInput({ kind: 'test', contentHash: 'h2', parentCode: 'cd_1' }), registry));
    assert.equal(child.codeId, 'cd_2');
    assert.equal(child.parentCode, 'cd_1');
    assert.equal(child.failingTestId, null);
    assert.equal(child.fingerprint, 'cdfp_' + fp('test:h2:author-a:cd_1:'));
    pushCode(child, registry);
    const grand = unwrap(registerCodeData(codeInput({ kind: 'diff', contentHash: 'h3', parentCode: 'cd_2' }), registry));
    assert.equal(grand.codeId, 'cd_3');
    assert.equal(grand.parentCode, 'cd_2');
    pushCode(grand, registry);
    // a parent that never existed is refused by name, before any record is made
    assert.equal(refusal(registerCodeData(codeInput({ kind: 'diff', contentHash: 'h4', parentCode: 'cd_99' }), registry)), 'codedata-unknown-parent:cd_99');
    assert.equal(registry.length, 3);
  });

  it('walks the deploy lifecycle and locks every terminal state by name', () => {
    const registry: CodeDataRecord[] = [];
    function newDeploy(): string {
      const rec = unwrap(registerCodeData(codeInput({ kind: 'deploy', contentHash: 'h-d-' + registry.length }), registry));
      assert.equal(rec.state, 'pending');
      pushCode(rec, registry);
      return rec.codeId;
    }
    // the happy path: pending -> running -> succeeded, then locked forever
    const happy = newDeploy();
    assert.deepEqual(unwrap(updateDeployState({ codeId: happy, toState: 'running', now: NOW + 1 }, registry)), { codeId: happy, state: 'running' });
    assert.deepEqual(unwrap(updateDeployState({ codeId: happy, toState: 'succeeded', now: NOW + 2 }, registry)), { codeId: happy, state: 'succeeded' });
    assert.equal(registry.find((r) => r.codeId === happy)?.state, 'succeeded');
    assert.equal(refusal(updateDeployState({ codeId: happy, toState: 'aborted', now: NOW + 3 }, registry)), 'codedata-terminal-state:succeeded');
    // every terminal state is reachable and then refuses any move
    const paths: string[][] = [['aborted'], ['failed'], ['running', 'failed'], ['running', 'rolled-back'], ['running', 'aborted']];
    for (const path of paths) {
      const id = newDeploy();
      for (const toState of path) {
        unwrap(updateDeployState({ codeId: id, toState, now: NOW }, registry));
      }
      const terminal = path[path.length - 1] ?? 'aborted';
      assert.equal(registry.find((r) => r.codeId === id)?.state, terminal);
      assert.equal(refusal(updateDeployState({ codeId: id, toState: 'running', now: NOW }, registry)), 'codedata-terminal-state:' + terminal);
    }
    // invalid hops are refused in the from:to shape and change nothing
    const fresh = newDeploy();
    assert.equal(refusal(updateDeployState({ codeId: fresh, toState: 'succeeded', now: NOW }, registry)), 'codedata-invalid-transition:pending:succeeded');
    assert.equal(refusal(updateDeployState({ codeId: fresh, toState: 'rolled-back', now: NOW }, registry)), 'codedata-invalid-transition:pending:rolled-back');
    assert.equal(refusal(updateDeployState({ codeId: fresh, toState: 'queued', now: NOW }, registry)), 'codedata-invalid-transition:pending:queued');
    unwrap(updateDeployState({ codeId: fresh, toState: 'running', now: NOW }, registry));
    assert.equal(refusal(updateDeployState({ codeId: fresh, toState: 'pending', now: NOW }, registry)), 'codedata-invalid-transition:running:pending');
    assert.equal(refusal(updateDeployState({ codeId: fresh, toState: 'running', now: NOW }, registry)), 'codedata-invalid-transition:running:running');
    assert.equal(registry.find((r) => r.codeId === fresh)?.state, 'running');
  });

  it('refuses state updates on the wrong records with the named reasons', () => {
    const registry: CodeDataRecord[] = [];
    pushCode(unwrap(registerCodeData(codeInput(), registry)), registry);
    assert.equal(refusal(updateDeployState(undefined as unknown as UpdateDeployStateInput, registry)), 'codedata-no-input');
    assert.equal(refusal(updateDeployState({ codeId: '', toState: 'running', now: NOW }, registry)), 'codedata-no-code-id');
    assert.equal(refusal(updateDeployState({ codeId: 'cd_1', toState: '', now: NOW }, registry)), 'codedata-no-state');
    assert.equal(refusal(updateDeployState({ codeId: 'cd_99', toState: 'running', now: NOW }, registry)), 'codedata-unknown-code:cd_99');
    // a diff has no state machine at all
    assert.equal(refusal(updateDeployState({ codeId: 'cd_1', toState: 'running', now: NOW }, registry)), 'codedata-not-deploy:cd_1');
    assert.equal(registry.find((r) => r.codeId === 'cd_1')?.state, null);
  });

  it('sweeps random registrations against the fingerprint, id and state oracles', () => {
    const rnd = mulberry32(42);
    const registry: CodeDataRecord[] = [];
    const authors = ['author-a', 'author-b', 'author-c'];
    let registered = 0;
    for (let i = 0; i < 200; i++) {
      const kind = CODE_DATA_KINDS[Math.floor(rnd() * CODE_DATA_KINDS.length)] ?? 'diff';
      const contentHash = 'h-' + i;
      const author = authors[Math.floor(rnd() * authors.length)] ?? 'author-a';
      const parentCode = registered > 0 && rnd() < 0.5 ? registry[Math.floor(rnd() * registry.length)]?.codeId : undefined;
      const failingTestId = kind === 'fix' ? 'ft-' + i : undefined;
      const input: RegisterCodeDataInput = {
        kind,
        contentHash,
        author,
        now: NOW,
        ...(parentCode !== undefined ? { parentCode } : {}),
        ...(failingTestId !== undefined ? { failingTestId } : {}),
      };
      const rec = unwrap(registerCodeData(input, registry));
      const identity = kind + ':' + contentHash + ':' + author + ':' + (parentCode ?? '') + ':' + (kind === 'fix' ? failingTestId ?? '' : '');
      assert.equal(rec.fingerprint, 'cdfp_' + fp(identity));
      assert.equal(rec.parentCode, parentCode ?? null);
      assert.equal(rec.failingTestId, kind === 'fix' ? failingTestId ?? null : null);
      assert.equal(rec.state, kind === 'deploy' ? 'pending' : null);
      assert.equal(rec.codeId, 'cd_' + (registered + 1));
      pushCode(rec, registry);
      registered++;
      if (rnd() < 0.25) {
        // the identical manifest is always an idempotent duplicate
        const again = unwrap(registerCodeData(input, registry));
        assert.ok(again.duplicate);
        assert.equal(again.codeId, rec.codeId);
        assert.equal(registry.length, registered);
      }
    }
    assert.equal(registry.length, registered);
  });

  it('sweeps deploy walks against the transition table, and terminals refuse everything', () => {
    const rnd = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const registry: CodeDataRecord[] = [];
      const rec = unwrap(registerCodeData(codeInput({ kind: 'deploy', contentHash: 'h-d' }), registry));
      pushCode(rec, registry);
      let state = rec.state ?? 'pending';
      for (let step = 0; step < 5; step++) {
        const allowed = DEPLOY_TRANSITIONS[state] as string[];
        const toState = allowed[Math.floor(rnd() * allowed.length)] ?? 'running';
        assert.deepEqual(unwrap(updateDeployState({ codeId: rec.codeId, toState, now: NOW + step }, registry)), { codeId: rec.codeId, state: toState });
        state = toState;
        assert.equal(registry.find((r) => r.codeId === rec.codeId)?.state, state);
        if (DEPLOY_TERMINAL_STATES.includes(state)) {
          assert.equal(refusal(updateDeployState({ codeId: rec.codeId, toState: 'pending', now: NOW }, registry)), 'codedata-terminal-state:' + state);
          break;
        }
        // the only non-terminal state mid-walk is running, and running cannot go back
        assert.equal(state, 'running');
        assert.equal(refusal(updateDeployState({ codeId: rec.codeId, toState: 'pending', now: NOW }, registry)), 'codedata-invalid-transition:running:pending');
      }
    }
  });
});

describe('creative engine (FORGE AI-011)', () => {
  function creativeInput(overrides: Partial<RegisterCreativeInput> = {}): RegisterCreativeInput {
    return { creator: 'ada', medium: 'manhwa', title: 'Forge Tales', consent: { granted: true }, now: NOW, ...overrides };
  }

  function pushWork(rec: CreativeWork & { duplicate: boolean }, works: CreativeWork[]): void {
    works.push({
      workId: rec.workId,
      creator: rec.creator,
      medium: rec.medium,
      title: rec.title,
      status: rec.status,
      revisions: rec.revisions.map((x) => ({ ...x })),
      fingerprint: rec.fingerprint,
      createdAt: rec.createdAt,
    });
  }

  it('pins the media vocabulary and terminal statuses exactly', () => {
    assert.deepEqual(CREATIVE_MEDIA, ['manhwa', 'music', 'voice']);
    assert.deepEqual(CREATIVE_TERMINAL_STATUSES, ['published', 'rejected']);
  });

  it('registers a pinned work with exact id and fingerprint, and never mutates the works array', () => {
    const works: CreativeWork[] = [];
    assert.deepEqual(registerCreativeWork(creativeInput(), works), {
      ok: true,
      value: {
        workId: 'cr_1',
        creator: 'ada',
        medium: 'manhwa',
        title: 'Forge Tales',
        status: 'pending',
        revisions: [],
        fingerprint: 'crfp_' + fp('ada:manhwa:Forge Tales'),
        createdAt: NOW,
        duplicate: false,
      },
    });
    assert.equal(works.length, 0);
    const first = unwrap(registerCreativeWork(creativeInput(), works));
    pushWork(first, works);
    const dup = unwrap(registerCreativeWork(creativeInput(), works));
    assert.ok(dup.duplicate);
    assert.equal(dup.workId, 'cr_1');
    assert.equal(works.length, 1);
  });

  it('refuses every bad registration with the named reason, in the engine order', () => {
    const works: CreativeWork[] = [];
    const cases: Array<[RegisterCreativeInput, string]> = [
      [creativeInput({ creator: '' }), 'creative-no-creator'],
      [creativeInput({ medium: 'film' }), 'creative-invalid-medium:film'],
      // the engine order: the medium is validated before the title, the consent before the clock
      [creativeInput({ medium: 'film', title: '' }), 'creative-invalid-medium:film'],
      [creativeInput({ title: '' }), 'creative-no-title'],
      [creativeInput({ consent: undefined as unknown as { granted: boolean } }), 'creative-no-consent'],
      [creativeInput({ consent: { granted: false } }), 'creative-consent-required'],
      [creativeInput({ consent: { granted: false }, now: NaN }), 'creative-consent-required'],
      [creativeInput({ now: NaN }), 'creative-no-now'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(refusal(registerCreativeWork(input, works)), expected);
    }
    assert.equal(refusal(registerCreativeWork(undefined as unknown as RegisterCreativeInput, works)), 'creative-no-input');
    assert.equal(works.length, 0);
  });

  it('keys identity on creator, medium and title: same triple idempotent, any variation a new work', () => {
    const works: CreativeWork[] = [];
    pushWork(unwrap(registerCreativeWork(creativeInput(), works)), works);
    const dup = unwrap(registerCreativeWork(creativeInput(), works));
    assert.ok(dup.duplicate);
    assert.equal(dup.workId, 'cr_1');
    const otherMedium = unwrap(registerCreativeWork(creativeInput({ medium: 'music' }), works));
    assert.ok(!otherMedium.duplicate);
    assert.equal(otherMedium.workId, 'cr_2');
    assert.equal(otherMedium.fingerprint, 'crfp_' + fp('ada:music:Forge Tales'));
    pushWork(otherMedium, works);
    const otherCreator = unwrap(registerCreativeWork(creativeInput({ creator: 'bob' }), works));
    assert.ok(!otherCreator.duplicate);
    assert.equal(otherCreator.workId, 'cr_3');
    pushWork(otherCreator, works);
    const otherTitle = unwrap(registerCreativeWork(creativeInput({ title: 'Second Tales' }), works));
    assert.ok(!otherTitle.duplicate);
    assert.equal(otherTitle.workId, 'cr_4');
    pushWork(otherTitle, works);
    assert.equal(works.length, 4);
    // every variation is now idempotent against the works it joined
    assert.ok(unwrap(registerCreativeWork(creativeInput({ medium: 'music' }), works)).duplicate);
    assert.ok(unwrap(registerCreativeWork(creativeInput({ creator: 'bob' }), works)).duplicate);
    assert.ok(unwrap(registerCreativeWork(creativeInput({ title: 'Second Tales' }), works)).duplicate);
    assert.equal(works.length, 4);
  });

  it('walks the lifecycle: pending to approved to published, then locked forever', () => {
    const works: CreativeWork[] = [];
    pushWork(unwrap(registerCreativeWork(creativeInput(), works)), works);
    assert.deepEqual(unwrap(approveWork('cr_1', works)), { workId: 'cr_1', status: 'approved' });
    assert.equal(works[0]?.status, 'approved');
    assert.deepEqual(unwrap(publishWork('cr_1', works)), { workId: 'cr_1', status: 'published' });
    assert.equal(works[0]?.status, 'published');
    // published is terminal: nothing moves the work again
    assert.equal(refusal(approveWork('cr_1', works)), 'creative-terminal-state:published');
    assert.equal(refusal(rejectWork('cr_1', works)), 'creative-terminal-state:published');
    assert.equal(refusal(publishWork('cr_1', works)), 'creative-terminal-state:published');
    assert.equal(refusal(submitRevision({ workId: 'cr_1', content: 'x', now: NOW }, works)), 'creative-terminal-state:published');
    assert.equal(works[0]?.status, 'published');
  });

  it('rejects terminally: a rejected work can never be decided again', () => {
    const works: CreativeWork[] = [];
    pushWork(unwrap(registerCreativeWork(creativeInput(), works)), works);
    assert.deepEqual(unwrap(rejectWork('cr_1', works)), { workId: 'cr_1', status: 'rejected' });
    assert.equal(works[0]?.status, 'rejected');
    assert.equal(refusal(approveWork('cr_1', works)), 'creative-terminal-state:rejected');
    assert.equal(refusal(publishWork('cr_1', works)), 'creative-terminal-state:rejected');
    assert.equal(refusal(submitRevision({ workId: 'cr_1', content: 'x', now: NOW }, works)), 'creative-terminal-state:rejected');
    assert.equal(works[0]?.status, 'rejected');
  });

  it('publishes approved works only, without exception', () => {
    const works: CreativeWork[] = [];
    pushWork(unwrap(registerCreativeWork(creativeInput(), works)), works);
    // a pending work can be neither published nor revised
    assert.equal(refusal(publishWork('cr_1', works)), 'creative-unapproved');
    assert.equal(refusal(submitRevision({ workId: 'cr_1', content: 'x', now: NOW }, works)), 'creative-unapproved');
    // approval is a decision, not a terminal state: deciding again is legal
    unwrap(approveWork('cr_1', works));
    assert.deepEqual(unwrap(approveWork('cr_1', works)), { workId: 'cr_1', status: 'approved' });
    assert.deepEqual(unwrap(publishWork('cr_1', works)), { workId: 'cr_1', status: 'published' });
  });

  it('numbers revisions per work and pins their fingerprints', () => {
    const works: CreativeWork[] = [];
    pushWork(unwrap(registerCreativeWork(creativeInput(), works)), works);
    unwrap(approveWork('cr_1', works));
    const first = unwrap(submitRevision({ workId: 'cr_1', content: 'panel-one', now: NOW + 1 }, works));
    assert.deepEqual(first, {
      revisionId: 'crev_cr_1_1',
      content: 'panel-one',
      fingerprint: 'crfp_' + fp('cr_1:1:panel-one'),
      createdAt: NOW + 1,
    });
    const second = unwrap(submitRevision({ workId: 'cr_1', content: 'panel-two', now: NOW + 2 }, works));
    assert.equal(second.revisionId, 'crev_cr_1_2');
    assert.equal(second.fingerprint, 'crfp_' + fp('cr_1:2:panel-two'));
    assert.equal(works[0]?.revisions.length, 2);
    // the engine order: the clock before the work, the work before the content
    assert.equal(refusal(submitRevision({ workId: 'cr_99', content: 'x', now: NaN }, works)), 'creative-no-now');
    assert.equal(refusal(submitRevision({ workId: 'cr_99', content: 'x', now: NOW }, works)), 'creative-unknown-work:cr_99');
    assert.equal(refusal(submitRevision({ workId: '', content: 'x', now: NOW }, works)), 'creative-no-work-id');
    assert.equal(refusal(submitRevision({ workId: 'cr_1', content: '', now: NOW }, works)), 'revision-no-content');
    assert.equal(refusal(submitRevision(undefined as unknown as { workId: string; content: string; now: number }, works)), 'creative-no-input');
    assert.equal(works[0]?.revisions.length, 2);
  });

  it('names unknown works for every operation and never invents one', () => {
    const works: CreativeWork[] = [];
    assert.equal(refusal(approveWork('', works)), 'creative-no-work-id');
    assert.equal(refusal(approveWork('cr_99', works)), 'creative-unknown-work:cr_99');
    assert.equal(refusal(rejectWork('cr_99', works)), 'creative-unknown-work:cr_99');
    assert.equal(refusal(publishWork('cr_99', works)), 'creative-unknown-work:cr_99');
    assert.equal(refusal(submitRevision({ workId: 'cr_99', content: 'x', now: NOW }, works)), 'creative-unknown-work:cr_99');
    assert.equal(works.length, 0);
  });

  it('sweeps random registrations against the fingerprint and id oracles', () => {
    const rnd = mulberry32(42);
    const works: CreativeWork[] = [];
    const creators = ['ada', 'bob', 'eve'];
    const titles = ['T-1', 'T-2', 'T-3', 'T-4', 'T-5'];
    let stored = 0;
    for (let i = 0; i < 200; i++) {
      const creator = creators[Math.floor(rnd() * creators.length)] ?? 'ada';
      const medium = CREATIVE_MEDIA[Math.floor(rnd() * CREATIVE_MEDIA.length)] ?? 'manhwa';
      const title = titles[Math.floor(rnd() * titles.length)] ?? 'T-1';
      const rec = unwrap(registerCreativeWork({ creator, medium, title, consent: { granted: true }, now: NOW }, works));
      const fingerprint = 'crfp_' + fp(creator + ':' + medium + ':' + title);
      const existing = works.find((w) => w.fingerprint === fingerprint);
      if (existing) {
        assert.ok(rec.duplicate);
        assert.equal(rec.workId, existing.workId);
        assert.equal(works.length, stored);
      } else {
        assert.ok(!rec.duplicate);
        assert.equal(rec.workId, 'cr_' + (stored + 1));
        assert.equal(rec.fingerprint, fingerprint);
        pushWork(rec, works);
        stored++;
      }
    }
    // the sweep exercised fresh works and duplicates across a bounded identity space
    assert.ok(stored >= 10);
    assert.ok(stored <= creators.length * CREATIVE_MEDIA.length * titles.length);
    assert.equal(works.length, stored);
  });
});

describe('tokenizer engine (FORGE AI-012)', () => {
  it('pins the vocabulary ceiling exactly', () => {
    assert.equal(TOKENIZER_VOCAB_MAX, 1024);
  });

  it('trains a pinned tokenizer with exact vocab, merges and fingerprints', () => {
    const verdict = trainTokenizer({ corpus: 'aab aab', vocabSize: 5 });
    const contentHash = 'tok_' + fp('aab aab');
    assert.deepEqual(verdict, {
      ok: true,
      value: {
        vocab: [' ', 'a', 'b', 'aa', 'aab'],
        merges: ['aa', 'aab'],
        contentHash,
        fingerprint: 'tfp_' + fp(contentHash + ':5:5'),
      },
    });
    // encode and decode round-trip through the pinned tokenizer
    const tok = unwrap(verdict);
    assert.deepEqual(unwrap(encodeText('aab aab', tok)), [4, 0, 4]);
    assert.deepEqual(unwrap(encodeText('a a', tok)), [1, 0, 1]);
    assert.equal(unwrap(decodeIndices([4, 0, 4], tok)), 'aab aab');
  });

  it('starts the vocabulary at the sorted alphabet and stops early when no pairs remain', () => {
    // a vocab size equal to the alphabet trains zero merges
    const flat = unwrap(trainTokenizer({ corpus: 'ab', vocabSize: 2 }));
    assert.deepEqual(flat, {
      vocab: ['a', 'b'],
      merges: [],
      contentHash: 'tok_' + fp('ab'),
      fingerprint: 'tfp_' + fp('tok_' + fp('ab') + ':2:2'),
    });
    // a huge requested size cannot invent pairs: training stops when the corpus is one token
    const early = unwrap(trainTokenizer({ corpus: 'ab', vocabSize: TOKENIZER_VOCAB_MAX }));
    assert.deepEqual(early.merges, ['ab']);
    assert.equal(early.vocab.length, 3);
    assert.ok(early.vocab.length < TOKENIZER_VOCAB_MAX);
    // the fingerprint records the real vocab length, not the request
    assert.equal(early.fingerprint, 'tfp_' + fp('tok_' + fp('ab') + ':' + TOKENIZER_VOCAB_MAX + ':3'));
  });

  it('refuses bad training input with the named reasons, at both boundaries', () => {
    assert.equal(refusal(trainTokenizer(undefined as unknown as TrainTokenizerInput)), 'tokenizer-no-input');
    assert.equal(refusal(trainTokenizer({ corpus: '', vocabSize: 5 })), 'tokenizer-no-corpus');
    assert.equal(refusal(trainTokenizer({ corpus: 'abc', vocabSize: NaN })), 'tokenizer-bad-vocab-size');
    assert.equal(refusal(trainTokenizer({ corpus: 'abc', vocabSize: 2.5 })), 'tokenizer-bad-vocab-size');
    assert.equal(refusal(trainTokenizer({ corpus: 'abc', vocabSize: 2 })), 'tokenizer-vocab-below-alphabet:2:3');
    assert.equal(refusal(trainTokenizer({ corpus: 'abc', vocabSize: TOKENIZER_VOCAB_MAX + 1 })), 'tokenizer-vocab-above-max:1025:1024');
    // the boundaries themselves are legal
    assert.ok(trainTokenizer({ corpus: 'abc', vocabSize: 3 }).ok);
    assert.ok(trainTokenizer({ corpus: 'abc', vocabSize: TOKENIZER_VOCAB_MAX }).ok);
  });

  it('refuses unknown characters and indices by name', () => {
    const tok = unwrap(trainTokenizer({ corpus: 'aab aab', vocabSize: 5 }));
    assert.equal(refusal(encodeText('', tok)), 'tokenizer-no-text');
    assert.equal(refusal(encodeText('aabz', tok)), 'tokenizer-unknown-char:z');
    assert.equal(refusal(decodeIndices('x' as unknown as number[], tok)), 'tokenizer-no-indices');
    assert.equal(refusal(decodeIndices([99], tok)), 'tokenizer-unknown-token:99');
    assert.equal(refusal(decodeIndices([-1], tok)), 'tokenizer-unknown-token:-1');
  });

  it('registers tokenizers with deterministic ids, duplicate manifests and copy-only reads', () => {
    const registry: TokenizerRecord[] = [];
    const first = unwrap(registerTokenizer({ corpus: 'abab', vocabSize: 3, now: NOW }, registry));
    assert.equal(first.tokId, 'tok_1');
    assert.equal(first.contentHash, 'tok_' + fp('abab'));
    assert.deepEqual(first.merges, ['ab']);
    assert.equal(first.duplicate, false);
    assert.equal(registry.length, 0); // the caller owns the registry, the engine never appends
    registry.push({ ...first, vocab: [...first.vocab], merges: [...first.merges] });
    const dup = unwrap(registerTokenizer({ corpus: 'abab', vocabSize: 3, now: NOW + 5 }, registry));
    assert.ok(dup.duplicate);
    assert.equal(dup.tokId, 'tok_1');
    // the same corpus with a different vocab size is a different tokenizer
    const second = unwrap(registerTokenizer({ corpus: 'abab', vocabSize: 2, now: NOW }, registry));
    assert.ok(!second.duplicate);
    assert.equal(second.tokId, 'tok_2');
    assert.deepEqual(second.merges, []);
    registry.push({ ...second, vocab: [...second.vocab], merges: [...second.merges] });
    assert.equal(registry.length, 2);
    // training refusals pass through registration by name, and nothing is stored
    assert.equal(refusal(registerTokenizer({ corpus: 'abc', vocabSize: 2, now: NOW }, registry)), 'tokenizer-vocab-below-alphabet:2:3');
    assert.equal(refusal(registerTokenizer({ corpus: 'abc', vocabSize: 3, now: NaN }, registry)), 'tokenizer-no-now');
    assert.equal(refusal(registerTokenizer({ corpus: 'abc', vocabSize: 3, now: NOW }, undefined as unknown as TokenizerRecord[])), 'tokenizer-no-registry');
    assert.equal(registry.length, 2);
    // reads are by id, named when unknown, and always copies
    assert.equal(refusal(tokenizerById('', registry)), 'tokenizer-no-input');
    assert.equal(refusal(tokenizerById('tok_99', registry)), 'tokenizer-unknown-tokenizer:tok_99');
    const found = unwrap(tokenizerById('tok_1', registry));
    found.vocab.push('mutant');
    assert.equal(registry[0]?.vocab.length, 3);
  });

  it('sweeps random corpora against the alphabet, fingerprint, round-trip and determinism oracles', () => {
    const rnd = mulberry32(42);
    const pool = ['a', 'b', 'c', 'd'];
    for (let iter = 0; iter < 100; iter++) {
      const len = 1 + Math.floor(rnd() * 10);
      let corpus = '';
      for (let i = 0; i < len; i++) corpus += pool[Math.floor(rnd() * pool.length)] ?? 'a';
      const alphabet = Array.from(new Set(Array.from(corpus))).sort();
      const vocabSize = alphabet.length + Math.floor(rnd() * 4);
      const trained = unwrap(trainTokenizer({ corpus, vocabSize }));
      // the vocabulary begins at the sorted alphabet and never exceeds the request
      assert.deepEqual(trained.vocab.slice(0, alphabet.length), alphabet);
      assert.ok(trained.vocab.length <= vocabSize);
      // every merge is a vocabulary token, in training order
      for (const m of trained.merges) assert.ok(trained.vocab.includes(m));
      // the hash and fingerprint are derived from the corpus, never supplied
      assert.equal(trained.contentHash, 'tok_' + fp(corpus));
      assert.equal(trained.fingerprint, 'tfp_' + fp(trained.contentHash + ':' + vocabSize + ':' + trained.vocab.length));
      // determinism: the same corpus and size always yield the same tokenizer
      assert.deepEqual(trainTokenizer({ corpus, vocabSize }), { ok: true, value: trained });
      // encode then decode round-trips the corpus exactly
      assert.equal(unwrap(decodeIndices(unwrap(encodeText(corpus, trained)), trained)), corpus);
      // a vocab size below the alphabet is refused with the exact counts
      assert.equal(
        refusal(trainTokenizer({ corpus, vocabSize: alphabet.length - 1 })),
        'tokenizer-vocab-below-alphabet:' + (alphabet.length - 1) + ':' + alphabet.length,
      );
    }
  });
});
