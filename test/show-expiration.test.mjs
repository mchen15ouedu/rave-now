import test from 'node:test';
import assert from 'node:assert/strict';
import { planExpiredShows } from '../src/show-expiration.mjs';

const row = (number = 2, fields = {}) => ({ row: number, fingerprint: `row-${number}`, artist: `DJ ${number}`, event: 'Club night', venue: 'Example Club', city: 'Dallas, TX', address: '', category: 'Nighttime', start: '2026-10-08T21:00:00', startInstant: null, endInstant: null, ...fields });
const snapshot = rows => ({ timeZone: 'America/Chicago', capturedAt: '2026-10-09T00:00:00Z', rows });
const plan = (rows, now, options = {}) => planExpiredShows(snapshot(rows), { now, ...options });
const festival = (number, start, fields = {}) => row(number, { category: 'Festival', event: 'Example Festival', venue: 'Example Park', start, ...fields });

test('a listed show is eligible exactly 24 hours after its local start time', () => {
  assert.deepEqual(plan([row()], '2026-10-10T01:59:59.999Z').candidates, []);
  assert.deepEqual(plan([row()], '2026-10-10T02:00:00Z').candidates, [{ row: 2, fingerprint: 'row-2', expiresAt: '2026-10-10T02:00:00.000Z' }]);
});

test('ISO dates with AM/PM clocks keep show and festival expiration boundaries', () => {
  const show = row(2, { start: '2026-10-18 8:00 PM' });
  assert.equal(plan([show], '2026-10-20T00:59:59.999Z').candidates.length, 0);
  assert.equal(plan([show], '2026-10-20T01:00:00Z').candidates[0].expiresAt, '2026-10-20T01:00:00.000Z');
  const event = festival(3, '2026-10-18 8:00 PM');
  assert.equal(plan([event], '2026-10-20T04:59:59.999Z').candidates.length, 0);
  assert.equal(plan([event], '2026-10-20T05:00:00Z').candidates[0].expiresAt, '2026-10-20T05:00:00.000Z');
});

test('supported unambiguous numeric and named dates retain their complete local 24-hour boundary', () => {
  for (const start of [
    '10/18/2026 8:00 PM', '18/10/2026 20:00', '2026/10/18 20:00',
    '18 Oct 2026 8:00 PM', 'October 18th, 2026 @ 20:00',
  ]) {
    const entry = row(2, { start });
    assert.equal(plan([entry], '2026-10-20T00:59:59.999Z').candidates.length, 0, start);
    assert.equal(plan([entry], '2026-10-20T01:00:00Z').candidates[0]?.expiresAt,
      '2026-10-20T01:00:00.000Z', start);
  }
});

test('ambiguous numeric text is retained even when the venue timezone is known', () => {
  for (const start of ['10/08/2026 9:00 PM', '08-10-2026 21:00', '10.08.26', '10/8/2026']) {
    const result = plan([row(2, { start })], '2027-01-01T00:00:00Z');
    assert.equal(result.candidates.length, 0, start);
    assert.equal(result.invalidCount, 1, start);
  }
  const sameDayAndMonth = row(2, { start: '08/08/2026 9:00 PM' });
  assert.equal(plan([sameDayAndMonth], '2026-08-10T02:00:00Z').candidates.length, 1);
});

test('ambiguous native cells use trusted workbook dates and clocks without guessing text order', () => {
  const entry = row(2, { start: '08/10/2026 9:00 PM', startInstant: '2026-10-09T02:00:00.000Z', startDateOnly: false });
  assert.equal(plan([entry], '2026-10-10T01:59:59.999Z').candidates.length, 0);
  assert.equal(plan([entry], '2026-10-10T02:00:00Z').candidates[0]?.expiresAt,
    '2026-10-10T02:00:00.000Z');
  assert.equal(planExpiredShows({ ...snapshot([entry]), timeZone: '' },
    { now: '2027-01-01T00:00:00Z' }).candidates.length, 0);
});

test('an ambiguous festival final date blocks deletion of the whole festival', () => {
  const rows = [festival(2, '2026-10-08T20:00:00', { end: '10/11/2026' }), festival(3, '2026-10-09T20:00:00')];
  assert.equal(plan(rows, '2027-01-01T00:00:00Z').candidates.length, 0);
});

test('fractional clocks in supported display formats cannot expire early', () => {
  for (const start of [
    '2026-10-18 8:00:00.123 PM', '10/18/2026 8:00:00.123 PM',
    '18/10/2026 20:00:00.123', '18 Oct 2026 8:00:00.123 PM',
    '2026-10-18 8:00:00,123 PM', '20261018T20:00:00,123-0500',
    '２０２６-１０-１８ ８:００:００．１２３ PM', '2026-10-18 8:00:00.\u200b123 PM',
  ]) {
    const entry = row(2, { start });
    assert.equal(plan([entry], '2026-10-20T01:00:00.122Z').candidates.length, 0, start);
    assert.equal(plan([entry], '2026-10-20T01:00:00.123Z').candidates[0]?.expiresAt,
      '2026-10-20T01:00:00.123Z', start);
  }
  for (const [fraction, boundary] of [['1230', '2026-10-20T01:00:00.123Z'],
    ['1234', '2026-10-20T01:00:00.124Z'], ['9999', '2026-10-20T01:00:01.000Z']]) {
    const entry = row(2, { start: `2026-10-18 8:00:00.${fraction} PM` });
    const lastMillisecond = new Date(Date.parse(boundary) - 1).toISOString();
    assert.equal(plan([entry], lastMillisecond).candidates.length, 0, fraction);
    assert.equal(plan([entry], boundary).candidates[0]?.expiresAt, boundary, fraction);
  }
});

test('date-only shows survive the whole local day and following 24 hours', () => {
  const entry = row(2, { start: '2026-10-08' });
  assert.equal(plan([entry], '2026-10-10T04:59:59.999Z').candidates.length, 0);
  assert.equal(plan([entry], '2026-10-10T05:00:00Z').candidates[0].expiresAt, '2026-10-10T05:00:00.000Z');
});

test('midnight is a real clock and does not become a date-only row', () => {
  const entry = row(2, { start: '2026-10-08T00:00:00' });
  assert.equal(plan([entry], '2026-10-09T05:00:00Z').candidates.length, 1);
});

test('an explicit offset in source text outranks city and workbook zones', () => {
  const entry = row(2, { start: '2026-10-08T21:00:00+09:00' });
  assert.equal(plan([entry], '2026-10-09T12:00:00Z').candidates[0].expiresAt, '2026-10-09T12:00:00.000Z');
});

test('subsecond source and native timestamp boundaries cannot delete early', () => {
  const entry = row(2, { start: '2026-10-08T21:00:00.123+09:00' });
  assert.equal(plan([entry], '2026-10-09T12:00:00.122Z').candidates.length, 0);
  assert.equal(plan([entry], '2026-10-09T12:00:00.123Z').candidates.length, 1);
  const native = row(2, { city: '', start: '10/8/2026 9:00 PM', startInstant: '2026-10-09T02:00:00.123Z', startDateOnly: false });
  assert.equal(plan([native], '2026-10-10T02:00:00.122Z').candidates.length, 0);
  assert.equal(plan([native], '2026-10-10T02:00:00.123Z').candidates.length, 1);
});

test('a mismatched timezone abbreviation cannot be silently treated as venue time', () => {
  assert.equal(plan([row(2, { start: 'Oct 8, 2026 - 9:00 PM PDT' })], '2027-01-01T00:00:00Z').candidates.length, 0);
  assert.equal(plan([row(2, { start: 'Oct 8, 2026 - 9:00 PM CDT' })], '2026-10-10T02:00:00Z').candidates.length, 1);
});

test('explicit row zones and displayed IANA suffixes outrank city lookup', () => {
  assert.equal(plan([row(2, { timeZone: 'Asia/Tokyo' })], '2026-10-09T12:00:00Z').candidates.length, 1);
  assert.equal(plan([row(2, { start: 'Oct 8, 2026 - 9:00 PM Asia/Tokyo' })], '2026-10-09T12:00:00Z').candidates.length, 1);
  assert.equal(plan([row(2, { timeZone: 'Bad/Unknown' })], '2027-01-01T00:00:00Z').candidates.length, 0);
});

test('normalized fullwidth IANA suffixes retain explicit venue timing', () => {
  for (const city of ['Dallas, TX', '']) {
    const entry = row(2, { city, start: '２０２６-１０-１８ ２０:００ Ａｓｉａ／Ｔｏｋｙｏ' });
    assert.equal(plan([entry], '2026-10-19T10:59:59.999Z').candidates.length, 0);
    assert.equal(plan([entry], '2026-10-19T11:00:00Z').candidates[0]?.expiresAt,
      '2026-10-19T11:00:00.000Z');
  }
});

test('reliable address qualifiers resolve a bare city without dominant-city guessing', () => {
  const entry = row(2, { city: 'Dallas', address: '2200 Main St, Dallas, TX 75201' });
  assert.equal(plan([entry], '2026-10-10T02:00:00Z').candidates[0].expiresAt, '2026-10-10T02:00:00.000Z');
});

test('unknown or ambiguous city zones use the global latest-zone bound', () => {
  for (const city of ['Unknown Town', 'Springfield', '']) {
    const entry = row(2, { city });
    assert.equal(plan([entry], '2026-10-10T02:00:00Z').candidates.length, 0);
    const result = plan([entry], '2026-10-10T09:00:00Z');
    assert.equal(result.candidates[0].expiresAt, '2026-10-10T09:00:00.000Z');
    assert.equal(result.uncertainLocaleCount, 1);
  }
});

test('an explicitly formatted native Date retains its actual clock if locale is unknown', () => {
  const entry = row(2, { city: '', start: '10/8/2026 9:00 PM', startInstant: '2026-10-09T02:00:00.000Z', startDateOnly: false });
  assert.equal(plan([entry], '2026-10-10T02:00:00Z').candidates[0].expiresAt, '2026-10-10T02:00:00.000Z');
});

test('native Date flags prevent midnight date-only or ambiguous-format deletion', () => {
  const entry = row(2, { start: '2026-10-08', startInstant: '2026-10-08T05:00:00.000Z', startDateOnly: true });
  assert.equal(plan([entry], '2026-10-10T04:59:59.999Z').candidates.length, 0);
  assert.equal(plan([entry], '2026-10-10T05:00:00Z').candidates.length, 1);
  for (const flag of [null, undefined]) assert.equal(plan([{ ...entry, startDateOnly: flag }], '2027-01-01T00:00:00Z').candidates.length, 0);
});

test('native timestamp is interpreted using a known venue zone when its display clock is local', () => {
  const entry = row(2, { city: 'Los Angeles, CA', startInstant: '2026-10-09T02:00:00.000Z', startDateOnly: false });
  assert.equal(plan([entry], '2026-10-10T03:59:59Z').candidates.length, 0);
  assert.equal(plan([entry], '2026-10-10T04:00:00Z').candidates[0].expiresAt, '2026-10-10T04:00:00.000Z');
});

test('multi-day festival rows share the final local day plus 24-hour deadline', () => {
  const rows = [festival(2, '2026-10-09T21:00:00'), festival(3, '2026-10-10T21:00:00'), festival(4, '2026-10-11T18:00:00')];
  assert.equal(plan(rows, '2026-10-12T23:00:00Z').candidates.length, 0);
  assert.deepEqual(plan(rows, '2026-10-13T05:00:00Z').candidates.map(entry => entry.expiresAt), Array(3).fill('2026-10-13T05:00:00.000Z'));
});

test('a festival explicit end clock still retains the complete final day', () => {
  const rows = [festival(2, '2026-10-09T12:00:00', { end: '2026-10-11T23:00:00' }), festival(3, '2026-10-10T21:00:00')];
  assert.equal(plan(rows, '2026-10-13T04:59:59Z').candidates.length, 0);
  assert.equal(plan(rows, '2026-10-13T05:00:00Z').candidates.length, 2);
});

test('a date-only festival start with a timed end on that day is valid', () => {
  const rows = [festival(2, '2026-10-09', { end: '2026-10-09T23:00:00' })];
  assert.equal(plan(rows, '2026-10-11T05:00:00Z').candidates.length, 1);
});

test('an explicit date-only final date survives that whole date and 24 more hours', () => {
  const rows = [festival(2, '2026-10-09T12:00:00', { end: '2026-10-11' })];
  assert.equal(plan(rows, '2026-10-13T04:59:59Z').candidates.length, 0);
  assert.equal(plan(rows, '2026-10-13T05:00:00Z').candidates.length, 1);
});

test('festival aliases and later full-source dates prevent earlier-row cleanup', () => {
  const rows = [festival(2, '2026-10-09T12:00:00', { event: 'Niteharts Festival 2026' }), festival(3, '2026-10-10T12:00:00', { event: 'NitehartsFestival' }), festival(4, '2026-10-11T12:00:00', { event: 'Niteharts2026' }), festival(5, '2026-10-11T19:00:00', { event: 'Niteharts' })];
  assert.equal(plan(rows, '2026-10-11T00:00:00Z').candidates.length, 0);
  assert.equal(plan(rows, '2026-10-13T05:00:00Z').candidates.length, 4);
});

test('unmarked per-artist rows and unknown dates still protect an identified festival', () => {
  const rows = [festival(2, '2026-10-09'), festival(3, '2026-10-11', { category: '' })];
  assert.equal(plan(rows, '2026-10-12T05:00:00Z').candidates.length, 0);
  assert.equal(plan(rows, '2026-10-13T05:00:00Z').candidates.length, 2);
  const unknown = [...rows, festival(4, 'TBA', { category: 'Nighttime' })];
  assert.equal(plan(unknown, '2027-01-01T00:00:00Z').candidates.length, 0);
});

test('unknown dates in a festival family block premature cleanup', () => {
  const rows = [festival(2, '2026-10-09'), festival(3, 'TBA')];
  const result = plan(rows, '2027-01-01T00:00:00Z');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.blockedFestivalCount, 2);
  assert.equal(result.invalidCount, 1);
});

test('incomplete festival rows retain nearby complete festival data', () => {
  for (const start of ['2026-10-10', 'TBA']) {
    const rows = [festival(2, '2026-10-09'), festival(3, '2026-10-11'), festival(4, start, { event: '' })];
    assert.equal(plan(rows, '2027-01-01T00:00:00Z').candidates.length, 0);
  }
  assert.equal(plan([festival(2, '2026-10-09', { venue: '', address: '' })], '2027-01-01T00:00:00Z').candidates.length, 0);
});

test('a missing festival name on the possible final day cannot delete earlier lineup rows', () => {
  const rows = [festival(2, '2026-10-09'), festival(3, '2026-10-11'), festival(4, '2026-10-12', { event: '' })];
  assert.equal(plan(rows, '2027-01-01T00:00:00Z').candidates.length, 0);
  assert.equal(plan([{ ...rows[0], city: '' }, rows[1]], '2027-01-01T00:00:00Z').candidates.length, 0);
});

test('weekly occurrences stay separate without permanently retaining previous weeks', () => {
  const rows = [festival(2, '2026-10-02'), festival(3, '2026-10-04'), festival(4, '2026-10-09'), festival(5, '2026-10-11')];
  assert.deepEqual(plan(rows, '2026-10-07T00:00:00Z').candidates.map(entry => entry.row), [2, 3]);
});

test('a supplied final date extends a festival beyond the ordinary occurrence span', () => {
  const rows = [festival(2, '2026-10-02', { end: '2026-10-12' }), festival(3, '2026-10-11')];
  assert.equal(plan(rows, '2026-10-10T00:00:00Z').candidates.length, 0);
  assert.equal(plan(rows, '2026-10-14T05:00:00Z').candidates.length, 2);
});

test('a continuous festival longer than a week is never split and expired early', () => {
  const rows = Array.from({ length: 10 }, (_, index) => festival(index + 2, `2026-10-${String(index + 2).padStart(2, '0')}`));
  assert.equal(plan(rows, '2026-10-10T00:00:00Z').candidates.length, 0);
  assert.equal(plan(rows, '2026-10-13T05:00:00Z').candidates.length, 10);
});

test('several venues within the same city cannot delete part of one named festival early', () => {
  const rows = [festival(2, '2026-10-09', { venue: 'Stage A' }), festival(3, '2026-10-11', { venue: 'Stage B' })];
  assert.equal(plan(rows, '2026-10-12T05:00:00Z').candidates.length, 0);
});

test('matching festival names in different cities do not extend each other', () => {
  const rows = [festival(2, '2026-10-09'), festival(3, '2026-10-11', { city: 'Los Angeles, CA' })];
  assert.deepEqual(plan(rows, '2026-10-11T05:00:00Z').candidates.map(entry => entry.row), [2]);
});

test('only an exact normalized Festival category receives festival retention', () => {
  for (const category of ['Festival afterparty', 'Festivals', 'Nighttime', '']) assert.equal(plan([row(2, { category })], '2026-10-10T02:00:00Z').candidates.length, 1);
  assert.equal(plan([festival(2, '2026-10-08T21:00:00', { category: '  fEsTiVaL  ' })], '2026-10-10T02:00:00Z').candidates.length, 0);
});

test('future rows and invalid explicit clocks or end dates remain intact', () => {
  const rows = [row(2, { start: '2030-10-08T21:00:00' }), row(3, { start: '2026-10-08T99:00:00' }), festival(4, '2026-10-08', { end: 'TBA' }), festival(5, '2026-10-08T20:00:00', { end: '2026-10-07' }), row(6, { end: 'TBA' }), row(7, { end: '2026-10-07' })];
  assert.equal(plan(rows, '2027-01-01T00:00:00Z').candidates.length, 0);
});

test('DST fall-back clocks use the later fold occurrence plus 24 elapsed hours', () => {
  const entry = row(2, { city: 'New York City', start: '2026-11-01T01:30:00' });
  assert.equal(plan([entry], '2026-11-02T06:29:59Z').candidates.length, 0);
  assert.equal(plan([entry], '2026-11-02T06:30:00Z').candidates[0].expiresAt, '2026-11-02T06:30:00.000Z');
});

test('nonexistent DST gap clocks are retained for correction', () => {
  const entry = row(2, { city: 'New York City', start: '2026-03-08T02:30:00' });
  const result = plan([entry], '2027-01-01T00:00:00Z');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.invalidCount, 1);
});

test('date-only DST transition day uses next midnight in the new offset', () => {
  const entry = row(2, { city: 'New York City', start: '2026-11-01' });
  assert.equal(plan([entry], '2026-11-03T04:59:59Z').candidates.length, 0);
  assert.equal(plan([entry], '2026-11-03T05:00:00Z').candidates.length, 1);
});

test('duplicates and missing row fingerprints are excluded from destructive plans', () => {
  const rows = [row(2), row(2, { fingerprint: 'changed' }), row(3, { fingerprint: '' }), row(1), row(4)];
  const result = plan(rows, '2027-01-01T00:00:00Z');
  assert.deepEqual(result.candidates.map(entry => entry.row), [4]);
  assert.equal(result.invalidCount, 4);
});

test('bounded plans and aggregate counts reveal no artist or source information', () => {
  const rows = [row(4), row(2), row(3)];
  const result = plan(rows, '2027-01-01T00:00:00Z', { limit: 2 });
  assert.deepEqual(result.candidates.map(entry => entry.row), [2, 3]);
  assert.equal(result.expiredCount, 3);
  assert.equal(result.keptCount, 1);
  assert.equal(result.limitedCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /DJ|Example Club/);
  assert.equal(rows[0].start, '2026-10-08T21:00:00');
});

test('invalid planner arguments fail before any deletion plan is produced', () => {
  assert.throws(() => planExpiredShows(null), /snapshot/);
  assert.throws(() => plan([row()], 'invalid'), /reference instant/);
  assert.throws(() => plan([row()], '2027-01-01', { limit: 0 }), /limit/);
});
