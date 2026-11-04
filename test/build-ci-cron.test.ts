import test from 'node:test';
import assert from 'node:assert/strict';
import { cronMatchesInstant, findCronOccurrences, parseCronExpression } from '../src/modules/build-ci/cron.ts';

test('cron parser applies standard day-of-month/day-of-week OR semantics when both are restricted', () => {
  const cron = parseCronExpression('0 9 1 * 1');
  // 2026-06-01 is Monday, and 2026-07-01 is Wednesday.
  assert.equal(cronMatchesInstant(cron, Date.parse('2026-06-01T09:00:00.000Z'), 'UTC'), true);
  assert.equal(cronMatchesInstant(cron, Date.parse('2026-07-01T09:00:00.000Z'), 'UTC'), true);
  assert.equal(cronMatchesInstant(cron, Date.parse('2026-07-02T09:00:00.000Z'), 'UTC'), false);
});

test('cron matching uses the configured IANA timezone rather than server timezone', () => {
  const cron = parseCronExpression('0 9 * * *');
  assert.equal(cronMatchesInstant(cron, Date.parse('2026-11-04T08:00:00.000Z'), 'Africa/Lagos'), true);
  assert.equal(cronMatchesInstant(cron, Date.parse('2026-11-04T09:00:00.000Z'), 'Africa/Lagos'), false);
});

test('spring-forward nonexistent local wall time is not invented', () => {
  const times = findCronOccurrences(
    '30 2 * * *', 'America/New_York',
    Date.parse('2026-03-08T06:00:00.000Z'),
    Date.parse('2026-03-08T08:00:00.000Z'),
  );
  assert.deepEqual(times, []);
});

test('fall-back repeated local wall time produces two distinct UTC occurrences', () => {
  const times = findCronOccurrences(
    '30 1 * * *', 'America/New_York',
    Date.parse('2026-11-01T05:00:00.000Z'),
    Date.parse('2026-11-01T07:00:00.000Z'),
  );
  assert.deepEqual(times, [
    Date.parse('2026-11-01T05:30:00.000Z'),
    Date.parse('2026-11-01T06:30:00.000Z'),
  ]);
});

test('cron scan enforces a bounded, minute-aligned range', () => {
  assert.throws(() => findCronOccurrences('* * * * *', 'UTC', 1, 60_001));
  assert.throws(() => findCronOccurrences('* * * * *', 'UTC', 0, 10_081 * 60_000));
});

test('numeric cron steps are expanded at their declared interval', () => {
  const times = findCronOccurrences(
    '*/15 * * * *', 'UTC',
    Date.parse('2026-11-04T12:00:00.000Z'),
    Date.parse('2026-11-04T12:45:00.000Z'),
  );
  assert.deepEqual(times, [
    Date.parse('2026-11-04T12:00:00.000Z'),
    Date.parse('2026-11-04T12:15:00.000Z'),
    Date.parse('2026-11-04T12:30:00.000Z'),
    Date.parse('2026-11-04T12:45:00.000Z'),
  ]);
});
