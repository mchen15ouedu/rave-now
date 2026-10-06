import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShowDate, parseShows, calendarDate, haversineMiles, findNearbyShows, findFutureShows } from '../src/shows.mjs';
import { DemoLocationProvider, LocationError } from '../src/locations.mjs';

const headers = ['Artist', 'Location', 'Address', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)'];
const row = (artist, date, address = 'Dallas TX', venue = 'Example Venue') => [artist, venue, address, 'https://example.com/ticket', date, 'https://www.youtube.com/watch?v=example'];

test('calendar date parser accepts source date formats and validates leap days', () => {
  for (const [input, expected] of [
    ['Fri, Oct 9, 2026', '2026-10-09'],
    ['Thu, December 31, 2026', '2026-12-31'],
    ['Sun, Dec 6, 2026 - 5:00 PM', '2026-12-06'],
    ['February 29, 2024', '2024-02-29'],
    ['February 29, 2000', '2000-02-29'],
    ['2026-10-05', '2026-10-05'],
    ['2026-10-05T23:30:00-06:00', '2026-10-05'],
    [25569, '1970-01-01'],
    [25569.75, '1970-01-01'],
  ]) assert.equal(parseShowDate(input), expected, String(input));
  for (const input of ['2026-02-29', 'February 29, 1900', 'Apr 31, 2026', 'Jan 0, 2026', '13/10/2026', 'TBA', '', 'Oct 9, 2026 garbage', NaN, Infinity, -1]) {
    assert.equal(parseShowDate(input), null, String(input));
  }
});

test('tracker parsing preserves original dates, maps actual columns, and diagnoses invalid rows', () => {
  const shows = parseShows([
    headers,
    row('Artist A', 'Fri, Oct 9, 2026', '100 Example Street Dallas TX 75201', 'Club'),
    row('Artist B', 'TBA'),
    row('Artist C', '2026-02-29'),
    row('Artist D', '2026-10-06', '', 'Secret location TBA'),
    row('Artist E', '2026-10-07', 'Dallas TX', 'Secret Location'),
    row('Artist F', '2026-10-08', '', 'Dallas TX'),
    ['', '', '', '', '', ''],
  ]);
  assert.equal(shows.length, 4);
  assert.equal(shows[0].date, '2026-10-09');
  assert.equal(shows[0].dateLabel, 'Fri, Oct 9, 2026');
  assert.equal(shows[0].locationQuery, '100 Example Street Dallas TX 75201');
  assert.equal(shows[0].locationApproximate, false);
  assert.equal(shows[1].locationQuery, null);
  assert.equal(shows[2].locationQuery, 'Dallas TX');
  assert.equal(shows[3].locationQuery, null);
  assert.equal(shows[3].locationSource, null);
  assert.match(shows.warnings[0], /Skipped 2/);
  assert.equal(shows[0].ticketUrl, 'https://example.com/ticket');
  assert.throws(() => parseShows([['Artist', 'Show Time']]), /missing required columns/);
});

test('the optional Event column preserves event names independently of artists and venues', () => {
  const [show] = parseShows([
    ['Event', ...headers],
    ['  Example Festival  ', ...row('DJ One', '2026-10-09', 'Dallas TX', 'Festival grounds')],
  ]);
  assert.equal(show.event, 'Example Festival');
  assert.equal(show.artist, 'DJ One');
  assert.equal(show.venue, 'Festival grounds');
  assert.equal(parseShows([headers, row('DJ One', '2026-10-09')])[0].event, undefined);
});

test('dated event announcements without an artist stay searchable with event-level links', async () => {
  const currentHeaders = ['Artist', 'Style', 'Event', 'Location', 'City', 'Address', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)'];
  const shows = parseShows([
    currentHeaders,
    ['', 'House', '  MOONDANCE PNK Party  ', 'Festival Grounds', 'Dallas, TX', '', 'https://example.com/festival', 'Sat, Oct 10, 2026', 'https://www.youtube.com/watch?v=unrelated-dj'],
    ['', '', 'Ultra Music Festival 2027', 'Festival Grounds', 'Miami, FL', '', 'https://ultramusicfestival.com', 'Fri, Mar 26, 2027', ''],
  ]);
  assert.equal(shows.length, 2);
  assert.deepEqual(shows.warnings, []);
  const [event] = shows;
  assert.equal(event.type, 'event');
  assert.equal(event.artist, 'MOONDANCE PNK Party');
  assert.equal(event.event, 'MOONDANCE PNK Party');
  assert.equal(event.entryCount, 0, 'An announcement does not name any performer');
  assert.equal(event.date, '2026-10-10');
  assert.equal(event.dateEnd, '2026-10-10');
  assert.equal(event.dateLabel, 'Sat, Oct 10, 2026');
  assert.equal(event.locationQuery, 'Dallas, TX');
  assert.equal(event.locationSource, 'city');
  assert.equal(event.locationApproximate, true);
  assert.deepEqual(event.ticketLinks, [{ url: 'https://example.com/festival', label: 'Tickets' }]);
  assert.equal(event.youtubeUrl, 'https://www.youtube.com/results?search_query=MOONDANCE%20PNK%20Party');
  const nearby = await findNearbyShows({ shows, origin: 'Dallas TX', geocoder: new DemoLocationProvider(), now: '2026-10-06' });
  assert.deepEqual(nearby.matches.map(show => show.artist), ['MOONDANCE PNK Party']);
  assert.deepEqual(findFutureShows({ shows, now: '2026-10-06' }).matches.map(show => show.artist), ['Ultra Music Festival 2027', 'MOONDANCE PNK Party']);
});

test('blank artists still require a specific event name and a valid date', () => {
  const withEvent = ['Event', ...headers];
  const generic = ['', ' ', 'TBA', 'TBD', 'To be announced', 'unknown', 'Event', 'Festival', 'Music Festival', 'Concert', 'Show', 'n/a'];
  const shows = parseShows([
    withEvent,
    ...generic.map(event => [event, ...row('', '2026-10-09')]),
    ['Named Festival', ...row('', 'TBA')],
    ['Named Festival', ...row('', '2026-02-30')],
    ['', ...row('Original DJ', '2026-10-09')],
  ]);
  assert.equal(shows.length, 1);
  assert.equal(shows[0].artist, 'Original DJ');
  assert.equal(shows[0].type, undefined);
  assert.match(shows.warnings[0], /Skipped 2 .*invalid show dates/);
  assert.match(shows.warnings[1], new RegExp(`Skipped ${generic.length} .*without an artist`));
  assert.equal(parseShows([headers, row('', '2026-10-09')]).length, 0, 'Missing Event column preserves legacy behavior');
});

test('event-only announcements reject unsafe or credentialed tickets and retain their YouTube search fallback', () => {
  const withEvent = ['Event', ...headers];
  for (const value of ['javascript:alert(1)', 'not a URL', 'https://user:secret@example.com/ticket']) {
    const item = ['A Named Festival', ...row('', '2026-10-09')];
    item[4] = value;
    const [event] = parseShows([withEvent, item]);
    assert.equal(event.ticketUrl, null);
    assert.deepEqual(event.ticketLinks, []);
    assert.equal(event.youtubeUrl, 'https://www.youtube.com/results?search_query=A%20Named%20Festival');
  }
});

test('City and other columns can be reordered, and an available Address takes priority', () => {
  const reordered = [' City ', 'Show Time', 'Ticket Link', 'Location', 'Artist', 'YouTube (Most Popular Song)', 'Address'];
  const [show] = parseShows([
    reordered,
    [' Austin, TX ', 'Fri, Oct 9, 2026', 'https://example.com/ticket', 'TBA', 'Address priority', '', ' 100 Example Street, Dallas, TX 75201 '],
  ]);
  assert.equal(show.artist, 'Address priority');
  assert.equal(show.venue, 'TBA');
  assert.equal(show.city, 'Austin, TX');
  assert.equal(show.locationQuery, '100 Example Street, Dallas, TX 75201');
  assert.equal(show.locationSource, 'address');
  assert.equal(show.locationApproximate, false);
});

test('City supplies the approximation for missing or placeholder Addresses even when the venue is unknown', () => {
  const withCity = [...headers, 'City'];
  for (const address of ['', '   ', 'TBA', 'tbd', 'n/a', 'To be announced']) {
    const [show] = parseShows([withCity, [...row('City fallback', '2026-10-06', address, 'Secret location TBA'), ' Dallas, TX ']]);
    assert.equal(show.city, 'Dallas, TX');
    assert.equal(show.venue, 'Secret location TBA');
    assert.equal(show.locationQuery, 'Dallas, TX', `Address: ${JSON.stringify(address)}`);
    assert.equal(show.locationSource, 'city');
    assert.equal(show.locationApproximate, true);
  }
});

test('search uses City when needed and excludes rows without Address or City instead of geocoding the venue', async () => {
  const withCity = [...headers, 'City'];
  const shows = parseShows([
    withCity,
    [...row('Located by city', '2026-10-06', '', 'TBA'), 'Dallas, TX'],
    [...row('Venue name only', '2026-10-06', '', 'Dallas TX'), ''],
    [...row('Both missing', '2026-10-06', 'TBA', 'Example Venue'), 'n/a'],
  ]);
  assert.deepEqual(shows.map(show => show.locationQuery), ['Dallas, TX', null, null]);
  const queries = [];
  const geocoder = { resolve: async query => {
    queries.push(query);
    assert.equal(query, 'Dallas, TX');
    return { lat: 32.78, lng: -96.8, label: 'Dallas, TX', approximate: false };
  } };
  const result = await findNearbyShows({ shows, origin: { lat: 32.78, lng: -96.8 }, geocoder, now: '2026-10-05' });
  assert.deepEqual(queries, ['Dallas, TX']);
  assert.deepEqual(result.matches.map(show => show.artist), ['Located by city']);
  assert.equal(result.matches[0].locationApproximate, true);
  assert.equal(result.excludedCount, 2);
});

test('malformed and non-HTTP links do not become user links', () => {
  const item = row('Artist', '2026-10-06');
  item[3] = 'javascript:alert(1)';
  item[5] = 'not a URL';
  const [show] = parseShows([headers, item]);
  assert.equal(show.ticketUrl, null);
  assert.equal(show.youtubeUrl, null);
});

test('reference date is interpreted in Chicago and calendar additions cross DST', async () => {
  assert.equal(calendarDate(new Date('2026-10-06T02:00:00Z'), 'America/Chicago'), '2026-10-05');
  assert.equal(calendarDate('2026-10-05'), '2026-10-05');
  const result = await findNearbyShows({
    shows: [], origin: 'Dallas TX', geocoder: new DemoLocationProvider(), now: '2026-03-07',
  });
  assert.equal(result.windowStart, '2026-03-07');
  assert.equal(result.windowEnd, '2026-03-13');
});

test('seven-day window includes today and day six, excludes next week, and orders by latest date then distance', async () => {
  const shows = parseShows([
    headers,
    row('Farther', '2026-10-06', 'Fort Worth TX'),
    row('Closer', '2026-10-06'),
    row('Today', '2026-10-05'),
    row('Last day', '2026-10-11'),
    row('Next week', '2026-10-12'),
    row('Yesterday', '2026-10-04'),
    row('Outside radius', '2026-10-08', 'Austin TX'),
    row('Secret', '2026-10-07', '', 'TBA'),
    row('Unknown', '2026-10-07', 'Unmapped town'),
  ]);
  const result = await findNearbyShows({ shows, origin: 'Dallas TX', geocoder: new DemoLocationProvider(), now: '2026-10-05' });
  assert.deepEqual(result.matches.map((show) => show.artist), ['Last day', 'Closer', 'Farther', 'Today']);
  assert.equal(result.excludedCount, 2);
  assert.equal(result.windowEnd, '2026-10-11');
  assert.equal(result.locationLabel, 'Dallas, TX');
  assert.ok(result.matches.every((show) => show.distanceMiles <= 80 && show.locationApproximate));
});

test('radius comparison is inclusive and uses straight-line great-circle distance', async () => {
  const a = { lat: 32.78, lng: -96.8, label: 'A' };
  const b = { lat: 32.75, lng: -97.33, label: 'B' };
  const radius = haversineMiles(a, b);
  assert.ok(radius > 30 && radius < 32);
  const shows = parseShows([headers, row('Boundary show', '2026-10-05')]);
  const geocoder = { resolve: async () => b };
  const included = await findNearbyShows({ shows, origin: a, geocoder, now: '2026-10-05', radiusMiles: radius });
  assert.equal(included.matches.length, 1);
  const excluded = await findNearbyShows({ shows, origin: a, geocoder, now: '2026-10-05', radiusMiles: radius - 0.01 });
  assert.equal(excluded.matches.length, 0);
  assert.equal(haversineMiles(a, a), 0);
});

test('shared coordinates avoid origin geocoding; outages never become a misleading partial response', async () => {
  const shows = parseShows([headers, row('Show', '2026-10-05')]);
  let calls = 0;
  const geocoder = { resolve: async () => { calls += 1; throw new LocationError('UNAVAILABLE', 'Offline'); } };
  await assert.rejects(findNearbyShows({ shows, origin: { lat: 32, lng: -96 }, geocoder, now: '2026-10-05' }), { code: 'UNAVAILABLE' });
  assert.equal(calls, 1);
  await assert.rejects(findNearbyShows({ shows, origin: { lat: 1000, lng: 0 }, geocoder, now: '2026-10-05' }), { code: 'NOT_FOUND' });
});

test('aborted searches propagate cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(findNearbyShows({ shows: [], origin: 'Dallas TX', geocoder: new DemoLocationProvider(), signal: controller.signal }), { name: 'AbortError' });
});
