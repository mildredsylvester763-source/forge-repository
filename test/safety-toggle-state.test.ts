import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DefaultToggleStateReader,
  FailSafeToggleStateReader,
  IMMUTABLE_FLOOR,
  ResilientToggleStateReader,
  SAFETY_CATEGORIES,
  SAFETY_DEFAULTS,
  isSafetyCategory,
  type SafetyCategory,
  type ToggleScope,
} from '../src/modules/safety/engine/toggle-state-engine.ts';

const scope: ToggleScope = { lane: 'user', subjectId: 'user-1' };

test('Part 36 TS-785: every safety category has a single default-on state', () => {
  const reader = new DefaultToggleStateReader();
  const snapshot = reader.snapshot(scope);
  assert.equal(snapshot.degraded, false);
  assert.deepEqual(snapshot.states.map((state) => state.category), [...SAFETY_CATEGORIES]);
  assert.ok(snapshot.states.every((state) => state.enabled));
  assert.ok(snapshot.states.every((state) => state.version === 1));
  assert.deepEqual(SAFETY_DEFAULTS, Object.fromEntries(SAFETY_CATEGORIES.map((category) => [category, true])));
  for (const category of SAFETY_CATEGORIES) assert.equal(reader.read(scope, category).enabled, true);
});

test('Part 36 TS-788: unavailable state returns the fail-safe snapshot', () => {
  const reader = new FailSafeToggleStateReader();
  const snapshot = reader.snapshot(scope);
  assert.equal(snapshot.degraded, true);
  assert.ok(snapshot.states.every((state) => state.enabled && state.source === 'fail_safe' && state.version === 0));
  assert.deepEqual(reader.read(scope, 'financial'), {
    category: 'financial',
    enabled: true,
    source: 'fail_safe',
    version: 0,
  });
});

test('Part 36 TS-761/763: floor is a separate immutable constant and never appears as a mutable category', () => {
  assert.deepEqual(IMMUTABLE_FLOOR, {
    id: 'floor.csam',
    enabled: true,
    mutable: false,
    reason: 'immutable_child_safety_floor',
  });
  assert.equal(Object.isFrozen(IMMUTABLE_FLOOR), true);
  assert.equal(SAFETY_CATEGORIES.includes('floor.csam' as SafetyCategory), false);
});

test('Part 36 TS-789: jurisdictional compliance is pinned ON and marked as law-sourced', () => {
  const state = new DefaultToggleStateReader().read(scope, 'jurisdictional_compliance');
  assert.equal(state.enabled, true);
  assert.equal(state.source, 'jurisdiction');
});

test('Part 36 interim open decisions default ON; category validation is exact', () => {
  const reader = new DefaultToggleStateReader();
  assert.equal(reader.read(scope, 'dual_use_review').enabled, true);
  assert.equal(reader.read(scope, 'authorization_review').enabled, true);
  assert.equal(isSafetyCategory('dual_use_review'), true);
  assert.equal(isSafetyCategory('floor.csam'), false);
  assert.equal(isSafetyCategory('unknown'), false);
});

test('scope identifiers are represented only in the request and are not retained by the reader', () => {
  const reader = new DefaultToggleStateReader();
  const first = reader.snapshot({ lane: 'owner_admin', subjectId: 'owner' });
  const second = reader.snapshot({ lane: 'workspace_admin', subjectId: 'admin', workspaceId: 'w-1' });
  assert.deepEqual(first.states, second.states);
});

test('Part 36 TS-788: a backing-reader outage falls back to a degraded all-ON state', () => {
  const unavailable = {
    read: () => { throw new Error('storage unavailable'); },
    snapshot: () => { throw new Error('storage unavailable'); },
  };
  const reader = new ResilientToggleStateReader(unavailable);
  assert.equal(reader.read(scope, 'content').enabled, true);
  const snapshot = reader.snapshot(scope);
  assert.equal(snapshot.degraded, true);
  assert.ok(snapshot.states.every((state) => state.enabled && state.source === 'fail_safe'));
});

test('Part 36 TS-788: an incomplete or malformed backing snapshot is not trusted', () => {
  const malformed = {
    read: () => ({ category: 'content', enabled: false, source: 'default', version: 1 }),
    snapshot: () => ({ states: [], floor: IMMUTABLE_FLOOR, degraded: false }),
  };
  const reader = new ResilientToggleStateReader(malformed as unknown as DefaultToggleStateReader);
  assert.deepEqual(reader.read(scope, 'content'), {
    category: 'content', enabled: true, source: 'fail_safe', version: 0,
  });
  const snapshot = reader.snapshot(scope);
  assert.equal(snapshot.degraded, true);
  assert.equal(snapshot.states.length, SAFETY_CATEGORIES.length);
  assert.ok(snapshot.states.every((state) => state.enabled && state.source === 'fail_safe'));
});

test('Part 36 TS-788: a valid serialized snapshot preserves the immutable floor and pinned legal source', () => {
  const base = new DefaultToggleStateReader().snapshot(scope);
  const serializedSnapshot = JSON.parse(JSON.stringify(base)) as ReturnType<DefaultToggleStateReader['snapshot']>;
  const source = {
    read: (requestScope: ToggleScope, category: SafetyCategory) => new DefaultToggleStateReader().read(requestScope, category),
    snapshot: () => serializedSnapshot,
  };
  const result = new ResilientToggleStateReader(source).snapshot(scope);
  assert.equal(result.degraded, false);
  assert.deepEqual(result.floor, IMMUTABLE_FLOOR);
  assert.equal(result.states.find((state) => state.category === 'jurisdictional_compliance')?.source, 'jurisdiction');
});
