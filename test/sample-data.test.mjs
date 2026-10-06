import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSampleData, writeSampleData } from '../scripts/generate-sample-data.mjs';
import { parseShows } from '../src/shows.mjs';
import { createShowSource } from '../src/providers.mjs';
import { createArtistCatalog } from '../src/artist-catalog.mjs';
import { createBrowserHandler } from '../src/browser.mjs';
import { CityLocationProvider } from '../src/city-locations.mjs';

test('sample generation is deterministic, contains only fictional names and sample links, and rejects invalid anchors', () => {
  const sample = buildSampleData('2026-10-05');
  assert.deepEqual(sample, buildSampleData('2026-10-05'));
  assert.equal(sample.metadata.sample, true);
  assert.equal(sample.metadata.anchorDate, '2026-10-05');
  const shows = parseShows(sample.rows);
  assert.equal(shows.length, sample.metadata.rows);
  assert.deepEqual(shows.warnings, []);
  assert.ok(shows.every(show => show.artist.startsWith('Sample ')));
  assert.ok(shows.filter(show => show.ticketUrl).every(show => new URL(show.ticketUrl).hostname === 'example.com'));
  assert.ok(shows.filter(show => show.youtubeUrl).every(show => {
    const url = new URL(show.youtubeUrl);
    return url.hostname === 'www.youtube.com' && url.pathname === '/results' && url.searchParams.get('search_query').startsWith('Sample ');
  }));
  assert.ok(sample.catalog.artists.every(name => name.startsWith('Sample ')));
  assert.ok(sample.catalog.promoters.every(name => name.startsWith('Sample ')));
  assert.equal(sample.catalog.artists.includes('Sample City Lights Announcement'), false);
  assert.ok(shows.some(show => show.type === 'event' && show.entryCount === 0));
  assert.equal(shows.filter(show => show.event === 'Sample Daybreak Festival').length, 4);
  for (const anchor of ['2026-02-29', '2026-10-05T12:00:00Z', '10/05/2026', '', null]) {
    assert.throws(() => buildSampleData(anchor), /YYYY-MM-DD/);
  }
});

test('sample files preserve tracker and catalog shapes and their explicit fictional metadata', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rave-now-sample-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metadata = await writeSampleData('2030-12-30', directory);
  const file = path.join(directory, 'tracker-snapshot.tsv');
  const savedMetadata = JSON.parse(await readFile(`${file}.meta.json`, 'utf8'));
  assert.deepEqual(savedMetadata, metadata);
  assert.equal(savedMetadata.sample, true);
  assert.equal(savedMetadata.updatedAt, '2030-12-30');
  assert.match(savedMetadata.description, /not real shows/i);
  const source = await createShowSource({ mode: 'demo', snapshotFile: file }).load();
  assert.equal(source.shows.length, metadata.rows);
  assert.equal(source.snapshotUpdatedAt, '2030-12-30');
  assert.equal(source.sample, true);
  assert.deepEqual(source.warnings, []);
  const catalog = await createArtistCatalog({ env: {}, snapshotFile: path.join(directory, 'name-catalog.json') }).load();
  assert.equal(catalog.canAdd, false);
  assert.ok(catalog.artists.includes('Sample Pulse'));
  assert.deepEqual(catalog.promoters, ['Sample Lantern Promotions', 'Sample Paper Moon Events']);
});

test('new sample anchors keep Today, weekend, longer ranges, festival grouping and FULL meaningful', async () => {
  const geocoder = new CityLocationProvider();
  for (const anchor of ['2026-10-05', '2026-10-11', '2030-12-30']) {
    const sample = buildSampleData(anchor);
    const browser = createBrowserHandler({
      env: {}, geocoder, clock: () => anchor,
      source: { load: async () => ({ shows: parseShows(sample.rows), snapshotUpdatedAt: anchor, sample: true }) },
    });
    const ranges = {};
    for (const view of ['today', 'nearby', 'weekend', 'month', 'three-months', 'full']) {
      const result = await browser.search({ query: 'location: New York, NY', view });
      ranges[view] = result;
      assert.ok(result.total > 0, `${anchor}: ${view} has a sample result`);
      assert.equal(result.source.sample, true);
      assert.equal(result.source.label, 'Fictional sample events');
      assert.ok(result.shows.every(show => show.date >= result.windowStart && (!result.windowEnd || show.date <= result.windowEnd)));
      assert.ok(result.shows.every(show => show.artist.startsWith('Sample ')));
    }
    assert.ok(ranges.nearby.shows.some(show => show.artist === 'Sample Skyline'));
    assert.ok(ranges['three-months'].shows.some(show => show.artist === 'Sample Pulse' && show.date > ranges.nearby.windowEnd));
    assert.equal(ranges['three-months'].shows.some(show => show.artist === 'Sample Horizon'), false);
    assert.ok(ranges.full.shows.some(show => show.artist === 'Sample Horizon'));
    assert.ok(ranges.full.shows.some(show => show.artist === 'Sample Compass'));
    assert.equal(ranges.full.shows.some(show => show.artist === 'Sample Archive'), false);
    assert.ok(ranges.full.shows.some(show => show.type === 'event' && show.entryCount === 4 && show.event === 'Sample Daybreak Festival'));
    assert.ok(ranges.full.shows.some(show => show.type === 'event' && show.entryCount === 0 && show.event === 'Sample City Lights Announcement'));
  }
});
