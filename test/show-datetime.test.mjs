import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { parseShowDate, parseShowClock, parseShows, findFutureShows, findNearbyShows } from '../src/shows.mjs';
import { createHostedApp } from '../src/hosted.mjs';

const absentClock = { startTime: null, timeZoneOffset: null, timeSpecified: false };
const headers = ['Artist', 'Location', 'City', 'Address', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)'];
const row = (date, city = 'Dallas, TX', artist = 'Sample Format DJ') =>
  [artist, 'Sample Venue', city, '', 'https://tickets.example/show', date, 'https://youtu.be/sample'];

test('common calendar notations normalize to a local date without needing a clock', () => {
  const cases = [
    ['2026-10-18', '2026-10-18'],
    ['2026/10/18', '2026-10-18'],
    ['2026.10.18', '2026-10-18'],
    ['2026-1-8', '2026-01-08'],
    ['2026/1/8', '2026-01-08'],
    ['20261018', '2026-10-18'],
    ['10/18/2026', '2026-10-18'],
    ['18/10/2026', '2026-10-18'],
    ['10-18-2026', '2026-10-18'],
    ['18-10-2026', '2026-10-18'],
    ['10.18.2026', '2026-10-18'],
    ['18.10.2026', '2026-10-18'],
    ['Oct 18, 2026', '2026-10-18'],
    ['October 18th 2026', '2026-10-18'],
    ['Oct. 18, 2026', '2026-10-18'],
    ['18 October 2026', '2026-10-18'],
    ['18th Oct 2026', '2026-10-18'],
    ['18thOct2026', '2026-10-18'],
    ['18-Oct-2026', '2026-10-18'],
    ['2026 October 18', '2026-10-18'],
    ['2026October18', '2026-10-18'],
    ['Sun, Oct 18, 2026', '2026-10-18'],
    ['Sunday 18 October 2026', '2026-10-18'],
    ['2026年10月18日', '2026-10-18'],
    ['2024/2/29', '2024-02-29'],
    ['29.2.2000', '2000-02-29'],
    ['  October\u00a018,\u00a02026  ', '2026-10-18'],
  ];
  for (const [input, date] of cases) {
    assert.equal(parseShowDate(input), date, input);
    assert.deepEqual(parseShowClock(input), absentClock, input);
  }
});

test('numeric order is explicit, with a conservative option for ambiguous cleanup dates', () => {
  for (const input of ['10/11/2026', '10-11-2026', '10.11.2026']) {
    assert.equal(parseShowDate(input), '2026-10-11', input);
    assert.equal(parseShowDate(input, { dateOrder: 'DMY' }), '2026-11-10', input);
    assert.equal(parseShowDate(input, { rejectAmbiguous: true }), null, input);
    assert.equal(parseShowDate(input, { dateOrder: 'DMY', rejectAmbiguous: true }), null, input);
  }
  for (const input of ['11/11/2026', '11-11-2026', '11.11.2026']) {
    assert.equal(parseShowDate(input, { rejectAmbiguous: true }), '2026-11-11', input);
  }
  for (const input of ['18/10/2026', '10/18/2026']) {
    assert.equal(parseShowDate(input), '2026-10-18', input);
    assert.equal(parseShowDate(input, { dateOrder: 'DMY' }), '2026-10-18', input);
    assert.equal(parseShowDate(input, { rejectAmbiguous: true }), '2026-10-18', input);
  }
  assert.equal(parseShowDate('2026-10-11', { rejectAmbiguous: true }), '2026-10-11');
  assert.equal(parseShowDate('2026/10/11', { rejectAmbiguous: true }), '2026-10-11');
  assert.equal(parseShowDate('October 11, 2026', { rejectAmbiguous: true }), '2026-10-11');
  assert.equal(parseShowDate('10/11/2026 8 PM', { rejectAmbiguous: true }), null);
});

test('two-digit years use a stable century rule instead of the current year', () => {
  for (const [input, date] of [
    ['10/18/00', '2000-10-18'],
    ['18/10/26', '2026-10-18'],
    ['10/18/69', '2069-10-18'],
    ['10/18/70', '1970-10-18'],
    ['18.10.99', '1999-10-18'],
    ['October 18, 26', '2026-10-18'],
    ['18 Oct 70', '1970-10-18'],
  ]) assert.equal(parseShowDate(input), date, input);
});

test('clock notation and separators work independently of the calendar notation', () => {
  for (const [input, startTime, timeZoneOffset = null] of [
    ['2026/10/18 8:00 PM', '20:00:00'],
    ['18.10.2026 8 PM', '20:00:00'],
    ['October 18, 2026 at 8 p.m.', '20:00:00'],
    ['18thOct2026 @ 8 a.m.', '08:00:00'],
    ['2026 October 18 - 20:15', '20:15:00'],
    ['20261018T20:15:30.123', '20:15:30'],
    ['2026年10月18日 20:15:30', '20:15:30'],
    ['10/18/2026, 8:15:30 PM', '20:15:30'],
    ['Sunday 18 October 2026 — 20:15:30', '20:15:30'],
    ['2026-10-18T20:15:30.999Z', '20:15:30', '+00:00'],
    ['2026-10-18 12 AM', '00:00:00'],
    ['2026-10-18 12 PM', '12:00:00'],
    ['2026-10-18 00:00', '00:00:00'],
    ['Oct 18, 2026 23:59:59', '23:59:59'],
    ['18-Oct-2026 8:15 PM CDT', '20:15:00', 'CDT'],
    ['2026-10-18 8 PM UTC', '20:00:00', '+00:00'],
    ['2026-10-18 8 PM GMT', '20:00:00', '+00:00'],
    ['2026-10-18 8 PM -0500', '20:00:00', '-05:00'],
    ['2026-10-18T20:00+05:30', '20:00:00', '+05:30'],
    ['2026-10-18 20:00-00:00', '20:00:00', '+00:00'],
    ['2026-10-18 20:00+14:00', '20:00:00', '+14:00'],
    ['2026-10-18 8 PM America/Chicago', '20:00:00', 'America/Chicago'],
    ['18 October 2026 8 PM Asia/Tokyo', '20:00:00', 'Asia/Tokyo'],
  ]) {
    assert.equal(parseShowDate(input), '2026-10-18', input);
    assert.deepEqual(parseShowClock(input), { startTime, timeZoneOffset, timeSpecified: true }, input);
  }
});

test('timezone offsets never move a listed show into the previous or following date', () => {
  for (const [input, startTime, timeZoneOffset] of [
    ['2026/10/18 00:30 +14:00', '00:30:00', '+14:00'],
    ['18 Oct 2026 23:30 -12:00', '23:30:00', '-12:00'],
    ['10/18/2026 12:30 AM Asia/Tokyo', '00:30:00', 'Asia/Tokyo'],
  ]) {
    assert.equal(parseShowDate(input), '2026-10-18', input);
    assert.deepEqual(parseShowClock(input), { startTime, timeZoneOffset, timeSpecified: true }, input);
  }
});

test('invalid calendars, incomplete dates and non-date text stay out of the feed', () => {
  for (const input of [
    '2026/2/29', '29.2.1900', '31 April 2026', '2026年13月18日',
    '2026-0-18', '2026-10-0', '10/32/2026', '32/10/2026',
    '20260230', '20261301', '0000-10-18', '2026-10-180', '2026/10/188PM',
    'October 18', '18 October', '10/18', 'October 2026',
    'today', 'tomorrow at 8 PM', 'next Friday', 'TBA', 'not a date',
    '2026-10-18 garbage', 'October 18, 2026 doors open 8 PM',
    '2026-10-18; DROP TABLE shows',
  ]) assert.equal(parseShowDate(input), null, input);
});

test('invalid clocks cannot make a dated row appear as a valid date-only show', () => {
  for (const input of [
    '2026/10/18 24:00', '18-Oct-2026 25:00',
    'Oct 18, 2026 0 AM', 'Oct 18, 2026 13 PM',
    '10/18/2026 8:60 PM', '2026年10月18日 20:00:60',
    '2026-10-18T20:00+15:00', '2026-10-18 8 PM +14:01',
    '2026-10-18 8 PM -04:60', '2026-10-18 8 PM Bad/Unknown',
    '2026-10-18 8 XM', '2026-10-18 8 PM garbage',
  ]) {
    assert.equal(parseShowDate(input), null, input);
    assert.deepEqual(parseShowClock(input), { startTime: null, timeZoneOffset: null, timeSpecified: true }, input);
  }
});

test('mixed spreadsheet date formats keep labels, links and chronological search order', async () => {
  const entries = [
    row('2026年10月19日 1 AM', 'Dallas, TX', 'Following day'),
    row('18 October 2026', 'Dallas, TX', 'Date only'),
    row('10/18/2026 10 p.m.', 'Dallas, TX', 'Late'),
    row('20261018T00:00Z', 'Dallas, TX', 'Midnight'),
    row('2026/10/18 @ 8 PM', 'Dallas, TX', 'Early'),
    row('18.10.2026 at 12 PM', 'Dallas, TX', 'Noon'),
    row('10/17/2026 8 PM', 'Dallas, TX', 'Past'),
    row('2026/10/25 8 PM', 'Dallas, TX', 'After window'),
    row('31 April 2026 8 PM', 'Dallas, TX', 'Invalid date'),
  ];
  const shows = parseShows([headers, ...entries]);
  assert.equal(shows.length, 8);
  assert.match(shows.warnings[0], /Skipped 1 .*invalid show dates/);
  assert.deepEqual(shows.map(show => show.dateLabel), entries.slice(0, 8).map(entry => entry[5]));
  assert.ok(shows.every(show => show.ticketUrl === 'https://tickets.example/show' && show.youtubeUrl === 'https://youtu.be/sample'));
  const expected = ['Midnight', 'Noon', 'Early', 'Late', 'Date only', 'Following day'];
  const future = findFutureShows({ shows, now: '2026-10-18' });
  assert.deepEqual(future.matches.map(show => show.artist), [...expected, 'After window']);
  const nearby = await findNearbyShows({ shows, now: '2026-10-18', origin: { lat: 32.78, lng: -96.8 },
    geocoder: { resolve: async () => ({ lat: 32.78, lng: -96.8 }) } });
  assert.deepEqual(nearby.matches.map(show => show.artist), expected);
  assert.equal(nearby.windowEnd, '2026-10-24');
});

test('artist API returns mixed-format shows globally within the selected time window', async t => {
  const shows = parseShows([headers,
    row('2026年10月20日 20:00', 'Tokyo, Japan'),
    row('18.10.2026 10 PM', 'New York, NY'),
    row('20261018T20:00', 'Los Angeles, CA'),
    row('10/18/2026 12 a.m.', ''),
    row('17 October 2026 20:00', 'Paris, France'),
    row('2026/10/25 20:00', 'Berlin, Germany'),
  ]);
  const geocoder = { resolve: async () => { throw new Error('Artist results must not geocode a destination'); },
    resolveCity: async () => { throw new Error('Artist results must not geocode a carried location'); } };
  const catalog = { load: async () => ({ artists: ['Sample Format DJ'], promoters: [], canAdd: false }) };
  const app = createHostedApp({ env: { PORT: '0' }, browser: { clock: () => '2026-10-18',
    source: { load: async () => ({ shows }) }, catalog, geocoder } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/browser/shows`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'sample format dj', view: 'nearby', location: 'Unresolvable previous city', timeZone: 'America/Chicago' }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.searchKind, 'artist');
  assert.equal(result.locationLabel, null);
  assert.equal(result.windowStart, '2026-10-18');
  assert.equal(result.windowEnd, '2026-10-24');
  assert.deepEqual(result.shows.map(show => [show.date, show.startTime, show.city]), [
    ['2026-10-18', '00:00:00', ''],
    ['2026-10-18', '20:00:00', 'Los Angeles, CA'],
    ['2026-10-18', '22:00:00', 'New York, NY'],
    ['2026-10-20', '20:00:00', 'Tokyo, Japan'],
  ]);
  assert.ok(result.shows.every(show => show.ticketUrl && show.youtubeUrl));
});
