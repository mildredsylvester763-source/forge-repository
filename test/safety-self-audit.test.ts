import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildEnvelope, type EventDraft, type EventEnvelope } from '../src/kernel/events.ts';
import { buildSafetySelfAudit, SafetySelfAuditService, type SafetySelfAuditRepository } from '../src/modules/safety/index.ts';

const BASE = 1_800_000_000_000;
const OWNER = 'owner-1';

function makeVault(): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  const append = (draft: EventDraft, at: number) => {
    const prior = events.at(-1);
    events.push(buildEnvelope(draft, prior ? { seq: prior.seq, hash: prior.hash } : null, at));
  };
  const ownerActor = { kind: 'user' as const, id: OWNER };
  append({ type: 'workspace.created', version: 1, actor: { kind: 'system', id: 'system' }, subject: { type: 'workspace', id: 'w-1' }, payload: {} }, BASE - 5000);
  append({
    type: 'safety.toggle.changed', version: 1, actor: ownerActor,
    subject: { type: 'safety_toggle', id: 'content' },
    payload: { target: { lane: 'owner_admin', subjectId: OWNER }, category: 'content', enabled: false, reason: 'Authorized owner test', previousEnabled: true, version: 2 },
  }, BASE);
  append({
    type: 'safety.execution.completed', version: 1, actor: ownerActor,
    subject: { type: 'safety_execution', id: 'run-1' },
    payload: {
      lane: 'owner_admin', actorId: OWNER, runId: 'run-1', operation: 'run research task',
      startedAt: BASE + 900, endedAt: BASE + 3000,
      safetyOffIntervals: [
        { category: 'content', startedAt: BASE + 1100, endedAt: BASE + 1800 },
        { category: 'rate_limits', startedAt: BASE + 1400, endedAt: BASE + 2900 },
      ],
    },
  }, BASE + 3000);
  append({
    type: 'safety.toggle.changed', version: 1, actor: ownerActor,
    subject: { type: 'safety_toggle', id: 'dual_use_review' },
    payload: { target: { lane: 'owner_admin', subjectId: OWNER }, category: 'dual_use_review', enabled: false, reason: 'Owner decision pending', previousEnabled: true, version: 2 },
  }, BASE + 3200);
  append({
    type: 'safety.toggle.changed', version: 1, actor: ownerActor,
    subject: { type: 'safety_toggle', id: 'content' },
    payload: { target: { lane: 'owner_admin', subjectId: OWNER }, category: 'content', enabled: true, reason: 'Restore content guard', previousEnabled: false, version: 3 },
  }, BASE + 4000);
  return events;
}

describe('Part 36 TS-776 self-audit reports', () => {
  it('verifies the entire hash chain and reports owner changes, executions and interval-clipped safety-off time', () => {
    const events = makeVault();
    const result = buildSafetySelfAudit({ ownerId: OWNER, from: BASE + 1500, to: BASE + 3000, vaultEventCount: events.length, events });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const report = result.report;
    assert.equal(report.countMatchesVault, true);
    assert.equal(report.verifiedVaultEventCount, events.length);
    assert.equal(report.reportEventCount, 1);
    assert.equal(report.unrestrictedToggleChanges.length, 0);
    assert.equal(report.unrestrictedExecutions.length, 1);
    assert.equal(report.totalSafetyOffDurationMs, 1700);
    assert.equal(report.safetyOffDurationByCategoryMs.content, 300);
    assert.equal(report.safetyOffDurationByCategoryMs.rate_limits, 1400);
    assert.equal(report.unrestrictedExecutions[0]?.safetyOffIntervals[1]?.endedAt, BASE + 2900);
  });

  it('includes owner actions in the requested period while retaining owner-controlled dual-use decisions', () => {
    const events = makeVault();
    const result = buildSafetySelfAudit({ ownerId: OWNER, from: BASE, to: BASE + 5000, vaultEventCount: events.length, events });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.report.reportEventCount, 4);
    assert.equal(result.report.unrestrictedToggleChanges.length, 3);
    assert.equal(result.report.unrestrictedExecutions.length, 1);
    assert.equal(result.report.safetyOffDurationByCategoryMs.content, 700);
    assert.equal(result.report.safetyOffDurationByCategoryMs.rate_limits, 1500);
    assert.equal(result.report.totalSafetyOffDurationMs, 2200);
    assert.equal(result.report.unrestrictedToggleChanges[1]?.category, 'dual_use_review');
  });

  it('refuses a filtered or stale snapshot whose record count does not match the vault', () => {
    const events = makeVault();
    assert.deepEqual(buildSafetySelfAudit({ ownerId: OWNER, from: BASE, to: BASE + 5000, vaultEventCount: events.length + 1, events }), { ok: false, reason: 'vault_count_mismatch' });
    assert.deepEqual(buildSafetySelfAudit({ ownerId: OWNER, from: BASE, to: BASE + 5000, vaultEventCount: events.length - 1, events: events.slice(1) }), { ok: false, reason: 'vault_chain_invalid' });
  });

  it('fails closed if a chained event is edited after it was sealed', () => {
    const events = makeVault();
    const altered = [...events];
    const original = altered[1]!;
    altered[1] = { ...original, payload: { ...original.payload, reason: 'tampered' } };
    assert.deepEqual(buildSafetySelfAudit({ ownerId: OWNER, from: BASE, to: BASE + 5000, vaultEventCount: altered.length, events: altered }), { ok: false, reason: 'vault_chain_invalid' });
  });

  it('flags any recorded attempt to disable minor or jurisdiction protections instead of producing a clean report', () => {
    const original = makeVault();
    const events: EventEnvelope[] = [];
    for (const [index, event] of original.entries()) {
      if (index < 2) events.push(event);
      else break;
    }
    const prior = events.at(-1)!;
    const protectedOff = buildEnvelope({
      type: 'safety.toggle.changed', version: 1, actor: { kind: 'user', id: OWNER },
      subject: { type: 'safety_toggle', id: 'minor_ceiling' },
      payload: { target: { lane: 'owner_admin', subjectId: OWNER }, category: 'minor_ceiling', enabled: false, reason: 'Invalid change' },
    }, { seq: prior.seq, hash: prior.hash }, BASE + 1500);
    events.push(protectedOff);
    assert.deepEqual(buildSafetySelfAudit({ ownerId: OWNER, from: BASE, to: BASE + 3000, vaultEventCount: events.length, events }), { ok: false, reason: 'protected_safety_off_recorded' });
  });

  it('authorizes before reading the vault and fails closed on authorization or storage errors', async () => {
    const events = makeVault();
    let reads = 0;
    const repository: SafetySelfAuditRepository = {
      async readCompleteVaultSnapshot() { reads += 1; return { events, vaultEventCount: events.length }; },
    };
    const denied = new SafetySelfAuditService(repository, { async isOwner() { return false; } });
    assert.deepEqual(await denied.report({ ownerId: OWNER, from: BASE, to: BASE + 5000 }), { ok: false, reason: 'owner_forbidden' });
    assert.equal(reads, 0);
    const outage = new SafetySelfAuditService({ async readCompleteVaultSnapshot() { throw new Error('vault down'); } }, { async isOwner() { return true; } });
    assert.deepEqual(await outage.report({ ownerId: OWNER, from: BASE, to: BASE + 5000 }), { ok: false, reason: 'vault_unavailable' });
    const allowed = new SafetySelfAuditService(repository, { async isOwner(ownerId) { return ownerId === OWNER; } });
    const report = await allowed.report({ ownerId: OWNER, from: BASE, to: BASE + 5000 });
    assert.equal(report.ok, true);
  });
});
