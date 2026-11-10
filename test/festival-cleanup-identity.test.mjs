import test from 'node:test';
import assert from 'node:assert/strict';
import { planExpiredShows } from '../src/show-expiration.mjs';

const festival = (row, start, fields = {}) => ({
  row, fingerprint: `fixture-${row}`, artist: `Sample DJ ${row}`,
  event: 'Copper Moon Festival 2026', venue: 'Sample Park', city: 'Dallas, TX',
  address: '', category: 'Festival', start, startInstant: null, endInstant: null,
  ...fields,
});
const plan = (rows, now = '2026-11-10T20:00:00Z') => planExpiredShows({ timeZone: 'America/Chicago', rows }, { now });
const ids = result => result.candidates.map(row => row.row);

test('a named festival in a known city includes venue-less rows through its last full day', () => {
  const rows = [
    festival(2, '2026-10-30', { venue: 'North Stage' }),
    festival(3, '2026-10-31', { venue: '' }),
    festival(4, '2026-11-01', { venue: 'TBA', category: 'Nighttime' }),
  ];
  assert.deepEqual(ids(plan(rows, '2026-11-03T05:59:59.999Z')), []);
  const expired = plan(rows, '2026-11-03T06:00:00Z');
  assert.deepEqual(ids(expired), [2, 3, 4]);
  assert.deepEqual(expired.candidates.map(row => row.expiresAt), Array(3).fill('2026-11-03T06:00:00.000Z'));
  assert.equal(expired.blockedFestivalCount, 0);
});

test('a venue-less last day with an unknown date still protects its entire named festival', () => {
  const rows = [festival(2, '2026-10-30'), festival(3, 'TBA', { venue: '' })];
  const result = plan(rows);
  assert.deepEqual(ids(result), []);
  assert.equal(result.blockedFestivalCount, 2);
});

test('a bounded pending-lineup annotation does not erase an otherwise certain festival identity', () => {
  for (const annotation of ['(lineup TBA)', '(lineupTBA)', '(line-up: TBD)', '(lineup to be announced)', '(line up to be determined)']) {
    const rows = [
      festival(2, '2026-10-30'),
      festival(3, '2026-10-31', { event: `Copper Moon Festival 2026 ${annotation}`, venue: '' }),
    ];
    assert.deepEqual(ids(plan(rows, '2026-11-02T04:59:59.999Z')), [], annotation);
    assert.deepEqual(ids(plan(rows, '2026-11-02T05:00:00Z')), [2, 3], annotation);
    assert.equal(rows[1].event, `Copper Moon Festival 2026 ${annotation}`, 'source text stays unchanged');
  }
});

test('unknown show dates and date uncertainty inside annotations are retained', () => {
  for (const event of [
    'Copper Moon Festival 2026 (date TBD)',
    'Copper Moon Festival 2026 (lineup TBA, date TBD)',
    'Copper Moon Festival 2026 (dates to be announced)',
  ]) {
    const rows = [festival(2, '2026-10-30'), festival(3, '2026-10-31', { event })];
    assert.deepEqual(ids(plan(rows)), [], event);
  }
  const rows = [festival(2, '2026-10-30'), festival(3, 'TBA', { event: 'Copper Moon Festival 2026 (lineup TBA)' })];
  assert.deepEqual(ids(plan(rows)), []);
});

test('another named festival with an unsupported future range cannot block completed festivals in that city', () => {
  const rows = [
    festival(2, '2026-10-30'),
    festival(3, '2026-10-31', { venue: '' }),
    festival(4, '2027-06-11 - 2027-06-12', { event: 'Silver Lake Festival 2027', venue: '' }),
  ];
  const result = plan(rows);
  assert.deepEqual(ids(result), [2, 3]);
  assert.equal(result.invalidCount, 1);
  assert.equal(result.blockedFestivalCount, 1);
});

test('different named festivals sharing a venue do not block one another when one lacks a city and date', () => {
  const rows = [
    festival(2, '2026-10-30'),
    festival(3, 'TBA', { event: 'Silver Lake Festival 2027', city: '' }),
  ];
  assert.deepEqual(ids(plan(rows)), [2]);
});

test('an unknown city still protects the same festival when its possible final day shares the venue', () => {
  for (const start of ['2026-10-31', 'TBA']) {
    const rows = [festival(2, '2026-10-30'), festival(3, start, { city: '' })];
    assert.deepEqual(ids(plan(rows)), [], start);
  }
});

test('a missing festival name nearby in the same city still protects its possible occurrence', () => {
  for (const start of ['2026-10-31', 'TBA']) {
    const rows = [festival(2, '2026-10-30', { venue: '' }), festival(3, start, { event: '', venue: '' })];
    assert.deepEqual(ids(plan(rows)), [], start);
  }
});

test('unknown venues never match across different cities merely because both are empty', () => {
  const rows = [
    festival(2, '2026-10-30', { venue: '' }),
    festival(3, 'TBA', { event: '', venue: '', city: 'Austin, TX' }),
  ];
  assert.deepEqual(ids(plan(rows)), [2]);
});

test('multiple explicitly listed same-day clocks expire 24 hours after the latest time', () => {
  const rows = [festival(2, '2026-10-23 18:00 & 20:00', { category: 'Nighttime' })];
  assert.deepEqual(ids(plan(rows, '2026-10-25T00:59:59.999Z')), []);
  assert.equal(plan(rows, '2026-10-25T01:00:00Z').candidates[0]?.expiresAt,
    '2026-10-25T01:00:00.000Z');
  const seconds = [festival(2, '2026-10-23 9:05:00 & 18:00:15 & 20:30:25', { category: 'Nighttime' })];
  assert.deepEqual(ids(plan(seconds, '2026-10-25T01:30:24.999Z')), []);
  assert.equal(plan(seconds, '2026-10-25T01:30:25Z').candidates[0]?.expiresAt,
    '2026-10-25T01:30:25.000Z');
  assert.equal(rows[0].start, '2026-10-23 18:00 & 20:00');
});

test('descending, invalid, incomplete or ambiguously dated clock lists stay for review', () => {
  for (const start of [
    '2026-10-23 20:00 & 18:00', '2026-10-23 23:00 & 01:00',
    '2026-10-23 18:00 & 18:00', '2026-10-23 18:00 & 24:00',
    '2026-10-23 18:00 & 20:60', '2026-10-23 18:00 & 20',
    '2026-10-23 18:00 &', '2026-10-23 & 20:00',
    '2026-10-23 18:00 & TBA', '2026-02-30 18:00 & 20:00',
    '10/11/2026 18:00 & 20:00', '2026-10-23 6 PM & 8 PM',
  ]) {
    assert.deepEqual(ids(plan([festival(2, start, { category: 'Nighttime' })])), [], start);
  }
});

test('future explicitly listed clocks stay intact and festival clocks retain the final full day', () => {
  const future = [festival(2, '2026-12-23 18:00 & 20:00', { category: 'Nighttime' })];
  assert.deepEqual(ids(plan(future)), []);
  const rows = [festival(2, '2026-10-23 18:00 & 20:00'), festival(3, '2026-10-24 18:00 & 20:00')];
  assert.deepEqual(ids(plan(rows, '2026-10-26T04:59:59.999Z')), []);
  assert.deepEqual(ids(plan(rows, '2026-10-26T05:00:00Z')), [2, 3]);
});

test('a native value cannot resolve an invalid or cross-midnight ambiguous displayed clock list', () => {
  for (const start of ['2026-10-23 23:00 & 01:00', '2026-10-23 18:00 &', '2026-10-23 & 20:00']) {
    const rows = [festival(2, start, { category: 'Nighttime', startInstant: '2026-10-24T04:00:00.000Z', startDateOnly: false })];
    assert.deepEqual(ids(plan(rows)), [], start);
  }
});

test('a corroborated conflicting edition year retains only that festival occurrence', () => {
  const rows = [
    festival(2, '2026-10-31', { event: 'Copper Moon Festival 2027' }),
    festival(3, '2027-05-13', { event: 'Copper Moon Festival 2027' }),
    festival(4, '2026-10-31', { event: 'Silver Lake Festival 2026' }),
  ];
  const result = plan(rows);
  assert.deepEqual(ids(result), [4]);
  assert.equal(result.blockedFestivalCount, 1);
  // The separate, correctly dated occurrence can expire normally later.
  assert.deepEqual(ids(plan(rows, '2027-05-15T05:00:00Z')), [3, 4]);
});

test('an uncorroborated title-year mismatch does not override an explicit show date', () => {
  const rows = [festival(2, '2026-10-31', { event: 'Copper Moon Festival 2027' })];
  assert.deepEqual(ids(plan(rows)), [2]);
  // Another city's named-year occurrence does not establish this city's date.
  rows.push(festival(3, '2027-05-13', { event: 'Copper Moon Festival 2027', city: 'Austin, TX' }));
  assert.deepEqual(ids(plan(rows)), [2]);
});

test('a New Year edition spanning December and January retains its final day without a year-conflict hold', () => {
  const rows = [
    festival(2, '2026-12-31', { event: 'Copper Moon Festival 2027' }),
    festival(3, '2027-01-01', { event: 'Copper Moon Festival 2027' }),
  ];
  assert.deepEqual(ids(plan(rows, '2027-01-03T05:59:59.999Z')), []);
  const result = plan(rows, '2027-01-03T06:00:00Z');
  assert.deepEqual(ids(result), [2, 3]);
  assert.equal(result.blockedFestivalCount, 0);
});
