import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHostedApp } from '../src/hosted.mjs';
import { parseShows } from '../src/shows.mjs';
import { LocationError } from '../src/locations.mjs';

const headers = ['Artist', 'Location', 'City', 'Address', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)'];
const row = (artist, city, date) => [artist, 'Sample Venue', city, '', 'https://tickets.example/sample', date, 'https://youtu.be/sample'];
const records = parseShows([headers,
  row('Miami DJs', 'Miami, FL', '2026-10-22'),
  row('Sample December DJ', 'Miami, FL', '2026-12-04'),
  row('Miami DJs', 'Tokyo, Japan', '2026-11-02'),
  row('Berlin Beats', 'Berlin, Germany', '2026-11-01'),
  row('Sample Berlin DJ', 'Berlin, Germany', '2026-12-12'),
  row('Global Pulse', 'Tokyo, Japan', '2026-12-05'),
  row('Global Pulse', 'Paris, France', '2026-12-06'),
  row('Global Pulse', '', '2026-12-07'),
  row('Global Pulse', 'Miami, FL', '2027-01-20'),
  row('Paris', 'Tokyo, Japan', '2026-12-08'),
]);
const points = {
  'Miami, FL': { lat: 25.77, lng: -80.19, label: 'Miami, FL', timeZone: 'America/New_York' },
  'Berlin, Germany': { lat: 52.52, lng: 13.40, label: 'Berlin, Germany', timeZone: 'Europe/Berlin' },
  'Tokyo, Japan': { lat: 35.68, lng: 139.69, label: 'Tokyo, Japan', timeZone: 'Asia/Tokyo' },
  'Paris, France': { lat: 48.86, lng: 2.35, label: 'Paris, France', timeZone: 'Europe/Paris' },
};

async function setup(t) {
  const cityQueries = [], destinations = [], writes = [], verifications = [];
  const artists = [...new Set(records.map(show => show.artist)), 'Spring Echo', 'Offline Echo'];
  const app = createHostedApp({ env: { PORT: '0' }, browser: {
    clock: () => '2026-10-20', source: { load: async () => ({ shows: records }) },
    catalog: { load: async () => ({ artists, promoters: [], canAdd: true }),
      ensureArtist: async name => { writes.push(name); return { name, added: true }; } },
    verifier: { verify: async name => { verifications.push(name); return { status: 'verified', name }; } },
    geocoder: {
      resolveCity: async query => {
        cityQueries.push(query);
        if (query === 'Miami') return points['Miami, FL'];
        if (query === 'Berlin') return points['Berlin, Germany'];
        if (query === 'Paris') return points['Paris, France'];
        if (query === 'Spring') throw new LocationError('AMBIGUOUS', 'Include a state or country.');
        if (query === 'Offline') throw new LocationError('UNAVAILABLE', 'Location lookup unavailable.');
        throw new LocationError('NOT_FOUND', 'No such city.');
      },
      resolve: async query => {
        destinations.push(query);
        if (!points[query]) throw new LocationError('NOT_FOUND', 'No such destination.');
        return points[query];
      },
    },
  } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const post = async input => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/browser/shows`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view: 'three-months', timeZone: 'America/Chicago', ...input }),
    });
    return { status: response.status, data: await response.json() };
  };
  return { post, cityQueries, destinations, writes, verifications };
}

test('recognized cities beat partial artist matches and retain December shows in the three-month window', async t => {
  for (const [query, expected] of [
    ['Miami', [['Miami DJs', '2026-10-22'], ['Sample December DJ', '2026-12-04']]],
    ['Berlin', [['Berlin Beats', '2026-11-01'], ['Sample Berlin DJ', '2026-12-12']]],
  ]) {
    const fixture = await setup(t);
    const { status, data } = await fixture.post({ query });
    assert.equal(status, 200, query);
    assert.equal(data.searchKind, 'location', query);
    assert.equal(data.artistQuery, null);
    assert.equal(data.windowStart, '2026-10-20');
    assert.equal(data.windowEnd, '2027-01-19');
    assert.deepEqual(data.shows.map(show => [show.artist, show.date]), expected);
    assert.ok(data.shows.every(show => show.ticketUrl && show.youtubeUrl));
    assert.deepEqual(fixture.cityQueries, [query]);
    assert.deepEqual(fixture.writes, []);
    assert.deepEqual(fixture.verifications, []);
  }
});

test('a non-city partial artist query falls back only on NOT_FOUND and stays global despite retained GPS', async t => {
  const fixture = await setup(t);
  const { status, data } = await fixture.post({ query: 'Pulse', latitude: 25.77, longitude: -80.19 });
  assert.equal(status, 200);
  assert.equal(data.searchKind, 'artist');
  assert.equal(data.locationLabel, null);
  assert.deepEqual(data.shows.map(show => [show.date, show.city]), [
    ['2026-12-05', 'Tokyo, Japan'], ['2026-12-06', 'Paris, France'], ['2026-12-07', ''],
  ]);
  assert.ok(data.shows.every(show => show.distanceMiles === undefined));
  assert.deepEqual(fixture.cityQueries, ['Pulse']);
  assert.deepEqual(fixture.destinations, []);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.verifications, []);
});

test('explicit artist entry keeps a city-name partial query global without any geocoding', async t => {
  const fixture = await setup(t);
  const { status, data } = await fixture.post({ query: 'artist: Miami', location: 'Unresolvable retained location' });
  assert.equal(status, 200);
  assert.equal(data.searchKind, 'artist');
  assert.equal(data.artistQuery, 'Miami');
  assert.equal(data.locationLabel, null);
  assert.deepEqual(data.shows.map(show => [show.date, show.city]), [
    ['2026-10-22', 'Miami, FL'], ['2026-11-02', 'Tokyo, Japan'],
  ]);
  assert.deepEqual(fixture.cityQueries, []);
  assert.deepEqual(fixture.destinations, []);
  assert.deepEqual(fixture.writes, []);
});

test('exact artist matches retain priority and explicit location entry resolves the same name as a city', async t => {
  const fixture = await setup(t);
  const artist = await fixture.post({ query: 'Paris' });
  assert.equal(artist.status, 200);
  assert.equal(artist.data.searchKind, 'artist');
  assert.deepEqual(artist.data.shows.map(show => show.city), ['Tokyo, Japan']);
  assert.deepEqual(fixture.cityQueries, []);
  assert.deepEqual(fixture.destinations, []);
  const city = await fixture.post({ query: 'location: Paris' });
  assert.equal(city.status, 200);
  assert.equal(city.data.searchKind, 'location');
  assert.deepEqual(city.data.shows.map(show => show.artist), ['Global Pulse']);
  assert.deepEqual(fixture.cityQueries, ['Paris']);
  assert.deepEqual(fixture.writes, []);
});

test('city ambiguity and lookup outages are not hidden by a partial artist match', async t => {
  const fixture = await setup(t);
  for (const [query, expectedStatus] of [['Spring', 400], ['Offline', 503]]) {
    const result = await fixture.post({ query });
    assert.equal(result.status, expectedStatus, query);
    assert.equal(result.data.shows, undefined);
  }
  assert.deepEqual(fixture.cityQueries, ['Spring', 'Offline']);
  assert.deepEqual(fixture.destinations, []);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.verifications, []);
});
