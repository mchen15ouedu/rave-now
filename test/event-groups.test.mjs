import test from 'node:test';
import assert from 'node:assert/strict';
import { groupEventResults } from '../src/event-groups.mjs';

const row = (index, overrides = {}) => ({
  id: `row-${index}`, artist: `DJ ${index}`, event: 'Electric Weekend',
  date: '2026-10-09', dateLabel: 'Fri, Oct 9, 2026',
  city: 'Dallas, TX', venue: 'Festival Grounds', address: '100 Festival Road, Dallas, TX',
  locationQuery: '100 Festival Road, Dallas, TX', locationSource: 'address', locationApproximate: false,
  distanceMiles: 20, ticketUrl: 'https://example.com/festival',
  youtubeUrl: `https://www.youtube.com/watch?v=dj${index}`, ...overrides,
});
const rows = (count, overrides) => Array.from({ length: count }, (_, index) => row(index, overrides));

test('three entries remain separate and four become one named event', () => {
  const three = rows(3);
  assert.deepEqual(groupEventResults(three), three);
  assert.equal(groupEventResults(three)[0], three[0]);
  const [event] = groupEventResults(rows(4));
  assert.equal(event.artist, 'Electric Weekend');
  assert.equal(event.event, 'Electric Weekend');
  assert.equal(event.type, 'event');
  assert.equal(event.entryCount, 4);
  assert.equal(event.date, '2026-10-09');
  assert.equal(event.dateEnd, '2026-10-09');
  assert.equal(event.dateLabel, 'Oct 9, 2026');
});

test('hundreds of DJs produce one event without adding an artist roster', () => {
  const result = groupEventResults(rows(500));
  assert.equal(result.length, 1);
  assert.equal(result[0].entryCount, 500);
  assert.equal(result[0].artist, 'Electric Weekend');
  assert.equal(Object.hasOwn(result[0], 'artists'), false);
});

test('the threshold only counts entries in the filtered result', () => {
  const source = rows(20);
  const selected = source.filter((_, index) => index < 3);
  assert.equal(groupEventResults(selected).length, 3);
  assert.equal(groupEventResults(source).length, 1);
});

test('a standalone event announcement does not become a fourth performer or duplicate a small lineup', () => {
  const announcement = row('announcement', { artist: 'Electric Weekend', type: 'event', entryCount: 0 });
  for (let count = 1; count <= 3; count++) {
    const lineup = rows(count);
    const result = groupEventResults([announcement, ...lineup]);
    assert.deepEqual(result, lineup);
    assert.ok(result.every((show, index) => show === lineup[index]));
  }
  assert.deepEqual(groupEventResults([announcement]), [announcement]);
});

test('an event announcement merges into a large lineup without inflating its DJ count', () => {
  const announcement = row('announcement', {
    artist: 'Electric Weekend', type: 'event', entryCount: 0, date: '2026-10-11',
    ticketUrl: 'https://example.com/weekend-pass',
  });
  const lineup = rows(4);
  const before = structuredClone([announcement, ...lineup]);
  Object.freeze(announcement);
  lineup.forEach(Object.freeze);
  const result = groupEventResults([announcement, ...lineup]);
  assert.equal(result.length, 1);
  assert.equal(result[0].entryCount, 4);
  assert.equal(result[0].artist, 'Electric Weekend');
  assert.equal(result[0].date, '2026-10-09');
  assert.equal(result[0].dateEnd, '2026-10-11');
  assert.deepEqual(result[0].ticketLinks.map(ticket => ticket.url), ['https://example.com/festival', 'https://example.com/weekend-pass']);
  assert.deepEqual([announcement, ...lineup], before);
});

test('multiple event-only rows consolidate dates and tickets without inventing a performer count', () => {
  const input = [
    row('friday', { artist: 'Electric Weekend', type: 'event', entryCount: 0 }),
    row('saturday', { artist: 'Electric Weekend', type: 'event', entryCount: 0, date: '2026-10-10', ticketUrl: 'https://example.com/saturday' }),
  ];
  const [event] = groupEventResults(input);
  assert.equal(groupEventResults(input).length, 1);
  assert.equal(event.entryCount, 0);
  assert.equal(event.type, 'event');
  assert.equal(event.dateLabel, 'Oct 9, 2026 – Oct 10, 2026');
  assert.equal(event.ticketLinks.length, 2);
  const nextWeek = row('next-week', { artist: 'Electric Weekend', type: 'event', entryCount: 0, date: '2026-10-16' });
  assert.equal(groupEventResults([...input, nextWeek]).length, 2);
});

test('standalone announcements at another named event or known site remain separate from a lineup', () => {
  const elsewhere = row('announcement', {
    artist: 'Electric Weekend', type: 'event', entryCount: 0,
    address: '200 Other Road, Dallas, TX', locationQuery: '200 Other Road, Dallas, TX',
  });
  const otherEvent = row('other', { artist: 'Other Festival', event: 'Other Festival', type: 'event', entryCount: 0 });
  const result = groupEventResults([...rows(4), elsewhere, otherEvent]);
  assert.equal(result.length, 3);
  assert.equal(result[0].entryCount, 4);
  assert.equal(result[1], elsewhere);
  assert.equal(result[2], otherEvent);
});

test('contiguous festival days combine into a single date range', () => {
  const input = [row(0), row(1), row(2, { date: '2026-10-10' }), row(3, { date: '2026-10-11' })];
  const [event] = groupEventResults(input);
  assert.equal(event.date, '2026-10-09');
  assert.equal(event.dateEnd, '2026-10-11');
  assert.equal(event.dateLabel, 'Oct 9, 2026 – Oct 11, 2026');
  assert.equal(event.entryCount, 4);
});

test('Friday and Sunday combine despite missing Saturday while next Friday stays separate', () => {
  const festival = [row(0), row(1), row(2, { date: '2026-10-11' }), row(3, { date: '2026-10-11' })];
  const nextFriday = rows(4, { date: '2026-10-16' });
  const result = groupEventResults([...festival, ...nextFriday]);
  assert.equal(result.length, 2);
  assert.equal(result[0].entryCount, 4);
  assert.equal(result[0].date, '2026-10-16');
  assert.equal(result[1].entryCount, 4);
  assert.equal(result[1].date, '2026-10-09');
  assert.equal(result[1].dateEnd, '2026-10-11');
});

test('separate weekends and occurrences a week apart never combine', () => {
  const first = rows(4);
  const second = rows(4, { date: '2026-10-16' });
  const result = groupEventResults([...first, ...second]);
  assert.equal(result.length, 2);
  assert.equal(result[0].date, '2026-10-16');
  assert.equal(result[1].date, '2026-10-09');
  assert.equal(groupEventResults([row(0), row(1), row(2, { date: '2026-10-16' }), row(3, { date: '2026-10-16' })]).length, 4);
});

test('a long daily series uses fixed seven-day windows instead of chaining forever', () => {
  const input = Array.from({ length: 21 }, (_, index) => row(index, { date: `2026-10-${String(index + 1).padStart(2, '0')}` }));
  const result = groupEventResults(input);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(show => show.entryCount), [7, 7, 7]);
  assert.deepEqual(result.map(show => [show.date, show.dateEnd]), [
    ['2026-10-15', '2026-10-21'], ['2026-10-08', '2026-10-14'], ['2026-10-01', '2026-10-07'],
  ]);
});

test('completed multi-day festival cards sort by latest start date while ordinary date ties stay stable', () => {
  const sameDayFirst = row('ordinary-first', { event: '', date: '2026-10-10' });
  const sameDaySecond = row('ordinary-second', { event: '', date: '2026-10-10' });
  const input = [
    row('sunday-first', { date: '2026-10-11' }),
    row('sunday-second', { date: '2026-10-11' }),
    sameDayFirst,
    sameDaySecond,
    row('friday-first'),
    row('friday-second'),
  ];
  const before = structuredClone(input);
  const result = groupEventResults(input);
  assert.deepEqual(result.map(show => show.date), ['2026-10-10', '2026-10-10', '2026-10-09']);
  assert.equal(result[0], sameDayFirst);
  assert.equal(result[1], sameDaySecond);
  assert.equal(result[2].artist, 'Electric Weekend');
  assert.equal(result[2].dateEnd, '2026-10-11');
  assert.equal(result[2].entryCount, 4);
  assert.deepEqual(input, before);
});

test('event names and cities discriminate distinct events at the same venue', () => {
  const result = groupEventResults([
    ...rows(4), ...rows(4, { event: 'Other Festival' }), ...rows(4, { city: 'Austin, TX' }),
  ]);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(show => show.artist), ['Electric Weekend', 'Other Festival', 'Electric Weekend']);
  assert.deepEqual(result.map(show => show.city), ['Dallas, TX', 'Dallas, TX', 'Austin, TX']);
});

test('distinct known sites in one city stay separate while stage names at one site combine', () => {
  const result = groupEventResults([
    ...rows(4), ...rows(4, { address: '200 Other Road, Dallas, TX', locationQuery: '200 Other Road, Dallas, TX', venue: 'Other Grounds' }),
    row('ambiguous', { address: '', locationQuery: 'Dallas, TX', locationSource: 'city' }),
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0].address, '100 Festival Road, Dallas, TX');
  assert.equal(result[1].address, '200 Other Road, Dallas, TX');
  assert.equal(result[2].artist, 'DJ ambiguous');
  const stages = rows(4).map((show, index) => ({ ...show, venue: `Stage ${index}` }));
  assert.equal(groupEventResults(stages).length, 1);
});

test('event name whitespace and case normalize without losing readable spelling', () => {
  const input = [row(0, { event: '  Electric   Weekend ' }), row(1, { event: 'ELECTRIC WEEKEND' }), row(2, { event: 'Electric\nWeekend' }), row(3, { event: 'electric weekend', city: 'dallas tx' })];
  assert.equal(groupEventResults(input).length, 1);
  assert.equal(groupEventResults(input)[0].artist, 'Electric Weekend');
});

test('missing or generic event names and unknown locations stay separate', () => {
  for (const event of ['', null, undefined, 'TBA', 'To be announced', 'unknown', 'Event', 'Music Festival', 'Festival']) {
    assert.equal(groupEventResults(rows(4, { event })).length, 4, String(event));
  }
  assert.equal(groupEventResults(rows(4, { city: '', address: '', locationQuery: null, venue: 'TBA' })).length, 4);
  assert.equal(groupEventResults(rows(4, { date: '2026-02-30' })).length, 4);
});

test('a named event falls back to a known address or venue when city is absent', () => {
  assert.equal(groupEventResults(rows(4, { city: '' })).length, 1);
  assert.equal(groupEventResults(rows(4, { city: '', address: '', locationQuery: null })).length, 1);
  assert.equal(groupEventResults([
    ...rows(2, { city: '', address: 'Other Road', locationQuery: 'Other Road' }),
    ...rows(2, { city: '', address: '100 Festival Road', locationQuery: '100 Festival Road' }),
  ]).length, 4);
});

test('event location metadata all comes from the nearest matching entry', () => {
  const input = [row(0), row(1, { distanceMiles: 8, address: '', locationQuery: 'Dallas, TX', locationSource: 'city', locationApproximate: true }), row(2), row(3)];
  const [event] = groupEventResults(input);
  assert.equal(event.distanceMiles, 8);
  assert.equal(event.address, '');
  assert.equal(event.locationQuery, 'Dallas, TX');
  assert.equal(event.locationSource, 'city');
  assert.equal(event.locationApproximate, true);
});

test('distinct day tickets survive while tracking variants deduplicate and unsafe links are rejected', () => {
  const input = [
    row(0, { ticketUrl: 'javascript:alert(1)' }),
    row(1, { ticketUrl: 'https://user:secret@example.com/tickets' }),
    row(2, { ticketUrl: 'https://tickets.example/event?day=friday&utm_source=ig' }),
    row(3, { ticketUrl: 'https://tickets.example/event?utm_source=email&day=friday' }),
    row(4, { date: '2026-10-10', ticketUrl: 'https://tickets.example/event?day=saturday' }),
  ];
  const [event] = groupEventResults(input);
  assert.equal(event.ticketUrl, 'https://tickets.example/event?day=friday&utm_source=ig');
  assert.equal(event.ticketLinks.length, 2);
  assert.match(event.ticketLinks[0].label, /Oct 9, 2026/);
  assert.match(event.ticketLinks[1].label, /Oct 10, 2026/);
  assert.equal(event.ticketLinks[1].url, 'https://tickets.example/event?day=saturday');
  assert.equal(event.youtubeUrl, 'https://www.youtube.com/results?search_query=Electric%20Weekend');
  assert.equal(groupEventResults(rows(4, { ticketUrl: 'data:text/html,bad' }))[0].ticketUrl, null);
});

test('output is stable at the first occurrence and source records are not mutated', () => {
  const unchanged = row('solo', { event: '' });
  const source = [row(0, { distanceMiles: 30 }), unchanged, row(1, { distanceMiles: 10 }), row(2), row(3), row('later', { event: 'Other Event' })];
  const before = structuredClone(source);
  source.forEach(Object.freeze);
  Object.freeze(source);
  const result = groupEventResults(source);
  assert.deepEqual(source, before);
  assert.equal(result.length, 3);
  assert.equal(result[0].artist, 'Electric Weekend');
  assert.equal(result[1], unchanged);
  assert.equal(result[2], source.at(-1));
  assert.notEqual(result[0], source[0]);
});

test('empty results and invalid arguments have predictable behavior', () => {
  assert.deepEqual(groupEventResults([]), []);
  assert.throws(() => groupEventResults(null), /matches must be an array/);
});
