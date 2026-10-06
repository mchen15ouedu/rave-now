import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleLocationProvider, DemoLocationProvider } from '../src/locations.mjs';
import { createShowSource, parseTsv } from '../src/providers.mjs';

const headers = ['Artist', 'Location', 'Address', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)'];
const data = [headers, ['Artist', 'Club', 'Dallas TX', '', 'Fri, Oct 9, 2026', '']];
const googleResult = (overrides = {}) => ({
  status: 'OK', results: [{ formatted_address: 'Dallas, TX, USA', types: ['locality'], geometry: { location: { lat: 32.78, lng: -96.8 } }, ...overrides }],
});
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('Apps Script events use the approved bridge, cache briefly and never fall back after an outage',async()=>{
 let time=0,calls=0,fail=false;
 const source=createShowSource({mode:'apps-script',clock:()=>time,cacheTtlMs:60000,bridge:{readShows:async()=>{calls++;if(fail)throw new Error('SECRET connection detail');return{rows:data};}},authFactory:()=>{throw new Error('Must not request another identity');}});
 const first=await source.load();assert.equal(first.source,'apps-script');assert.equal(first.shows.length,1);
 time=59000;await source.load();assert.equal(calls,1);
 time=60000;fail=true;await assert.rejects(source.load(),error=>error.name==='ShowSourceError'&&!error.message.includes('SECRET'));assert.equal(calls,2);
 await assert.rejects(source.load());assert.equal(calls,3);
 const controller=new AbortController();controller.abort();await assert.rejects(source.load({signal:controller.signal}),error=>error.name==='AbortError');assert.equal(calls,3);
});

test('snapshot capture metadata takes priority over an old environment date',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'rave-feed-metadata-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const file=join(folder,'events.tsv');await writeFile(file,data.map(row=>row.join('\t')).join('\n'));
 await writeFile(file+'.meta.json',JSON.stringify({updatedAt:'2026-10-06'}));
 const source=createShowSource({mode:'demo',snapshotFile:file,snapshotUpdatedAt:'2026-10-05'});
 assert.equal((await source.load()).snapshotUpdatedAt,'2026-10-06');
});

test('Google geocoding uses encoded queries and ephemeral cache with expiry', async () => {
  let time = 0;
  let calls = 0;
  const provider = new GoogleLocationProvider({
    apiKey: 'test-key', clock: () => time, ttlMs: 100,
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url.searchParams.get('address'), 'Dallas, TX');
      assert.equal(url.searchParams.get('key'), 'test-key');
      return response(googleResult());
    },
  });
  const first = await provider.resolve('Dallas, TX');
  assert.deepEqual(first, { lat: 32.78, lng: -96.8, label: 'Dallas, TX, USA', approximate: true });
  first.lat = 0;
  assert.equal((await provider.resolve('dallas, tx')).lat, 32.78);
  assert.equal(calls, 1);
  time = 101;
  await provider.resolve('Dallas, TX');
  assert.equal(calls, 2);
});

test('multiple matches, partial matches, and no results require a more specific location', async () => {
  for (const body of [
    googleResult({ partial_match: true }),
    { status: 'OK', results: [...googleResult().results, ...googleResult().results] },
  ]) {
    const provider = new GoogleLocationProvider({ apiKey: 'test-key', fetchImpl: async () => response(body) });
    await assert.rejects(provider.resolve('Springfield'), { code: 'AMBIGUOUS' });
  }
  const provider = new GoogleLocationProvider({ apiKey: 'test-key', fetchImpl: async () => response({ status: 'ZERO_RESULTS', results: [] }) });
  await assert.rejects(provider.resolve('Unknown'), { code: 'NOT_FOUND' });
});

test('origin lookups bypass the in-memory cache, while destination lookups can still be cached', async () => {
  let calls = 0;
  const provider = new GoogleLocationProvider({ apiKey: 'test-key', fetchImpl: async () => {
    calls += 1;
    return response(googleResult());
  } });
  await provider.resolve('Dallas TX', { cache: false });
  await provider.resolve('Dallas TX', { cache: false });
  assert.equal(calls, 2);
  assert.equal(provider.cache.size, 0);
  await provider.resolve('Dallas TX');
  await provider.resolve('Dallas TX');
  assert.equal(calls, 3);
  await provider.resolve('Dallas TX', { cache: false });
  assert.equal(calls, 4, 'Private origin lookup also bypasses a previously cached venue or city');
});

test('broad country and state geocodes require a city; postal and neighborhood results are accepted', async () => {
  for (const types of [['country', 'political'], ['administrative_area_level_1', 'political'], ['administrative_area_level_2']]) {
    const provider = new GoogleLocationProvider({ apiKey: 'test-key', fetchImpl: async () => response(googleResult({ types })) });
    await assert.rejects(provider.resolve('Texas'), { code: 'AMBIGUOUS' });
  }
  for (const types of [['postal_code'], ['neighborhood', 'political'], ['locality', 'political'], ['street_address']]) {
    const provider = new GoogleLocationProvider({ apiKey: 'test-key', fetchImpl: async () => response(googleResult({ types })) });
    assert.equal((await provider.resolve('Specific place')).lat, 32.78);
  }
});

test('Google quota, HTTP, invalid-body, and network failures are visible outages', async () => {
  const fetches = [
    async () => response({ status: 'OVER_QUERY_LIMIT' }),
    async () => response({}, 503),
    async () => response(googleResult({ geometry: { location: { lat: 100, lng: 0 } } })),
    async () => { throw new Error('Network offline'); },
  ];
  for (const fetchImpl of fetches) {
    await assert.rejects(new GoogleLocationProvider({ apiKey: 'test-key', fetchImpl }).resolve('Dallas TX'), { code: 'UNAVAILABLE' });
  }
  await assert.rejects(new GoogleLocationProvider().resolve('Dallas TX'), { code: 'UNAVAILABLE' });
});

test('geocoding preserves cancellation and passes the request signal', async () => {
  const controller = new AbortController();
  const provider = new GoogleLocationProvider({ apiKey: 'test-key', fetchImpl: async (_, { signal }) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    signal.throwIfAborted();
  } });
  await assert.rejects(provider.resolve('Dallas TX', { signal: controller.signal }), { name: 'AbortError' });
});

test('demo geocoding accepts only known exact aliases rather than guessing a city substring', async () => {
  const provider = new DemoLocationProvider();
  assert.equal((await provider.resolve('Dallas, TX')).approximate, true);
  assert.equal((await provider.resolve('100 Example Street, Dallas, TX 75201')).approximate, true);
  assert.equal((await provider.resolve('3000 S Las Vegas Blvd, Las Vegas, NV')).approximate, true);
  for (const input of ['Dallas', 'Paris TX', 'Unlisted Dallas Venue', 'Not Dallas TX']) {
    await assert.rejects(provider.resolve(input), { code: 'NOT_FOUND' });
  }
});

test('TSV snapshots support quoted tabs, multiline values, escaped quotes, and CRLF', () => {
  assert.deepEqual(parseTsv('\uFEFFA\tB\r\n"a\tb"\t"line 1\nline ""2"""\r\n'), [['A', 'B'], ['a\tb', 'line 1\nline "2"']]);
  assert.throws(() => parseTsv('A\t"broken'), /unterminated/);
});

test('demo source identifies snapshot data and reports skipped invalid dates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'show-finder-test-'));
  try {
    const file = join(directory, 'snapshot.tsv');
    await writeFile(file, [...data, ['Undated', 'Club', '', '', 'TBA', '']].map((row) => row.join('\t')).join('\n'));
    const result = await createShowSource({ mode: 'demo', snapshotFile: file, clock: () => 0 }).load();
    assert.equal(result.source, 'snapshot');
    assert.equal(result.loadedAt, '1970-01-01T00:00:00.000Z');
    assert.equal(result.shows.length, 1);
    assert.match(result.warnings[0], /Skipped 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function liveConfig(fetchImpl, extra = {}) {
  return {
    mode: 'live', spreadsheetId: 'example-workbook', sheetId: 30,
    auth: { getAccessToken: async () => ({ token: 'test-token' }) }, fetchImpl,
    ...extra,
  };
}

test('live source locates the real tab by ID, bounds its range, and requests formatted dates', async () => {
  const requests = [];
  const source = createShowSource(liveConfig(async (url, options) => {
    requests.push(url);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    if (requests.length === 1) return response({ sheets: [
      { properties: { sheetId: 1, title: 'Other' } },
      { properties: { sheetId: 30, title: "Upcoming Shows' Copy", gridProperties: { rowCount: 20000, columnCount: 6 } } },
    ] });
    assert.equal(decodeURIComponent(url.pathname.split('/values/')[1]), "'Upcoming Shows'' Copy'!A1:F10000");
    assert.equal(url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
    assert.equal(url.searchParams.get('dateTimeRenderOption'), 'FORMATTED_STRING');
    return response({ values: data });
  }));
  const first = await source.load();
  assert.equal(first.source, 'google-sheets');
  assert.equal(first.shows[0].date, '2026-10-09');
  await source.load();
  assert.equal(requests.length, 2, 'One metadata and one values request; second load is cached');
});

test('expired sheet cache never hides a live HTTP error or falls back to snapshot', async () => {
  let time = 0;
  let calls = 0;
  const source = createShowSource(liveConfig(async () => {
    calls += 1;
    if (calls > 2) return response({}, 403);
    return calls === 1 ? response({ sheets: [{ properties: { sheetId: 30, title: 'Upcoming Shows' } }] }) : response({ values: data });
  }, { clock: () => time, cacheTtlMs: 999999 }));
  assert.equal((await source.load()).shows.length, 1);
  time = 60001;
  await assert.rejects(source.load(), { name: 'ShowSourceError', code: 'UNAVAILABLE' });
  assert.equal(calls, 3);
});

test('a populated final bounded row fails instead of silently truncating a larger tracker', async () => {
  let calls = 0;
  const source = createShowSource(liveConfig(async () => ++calls === 1
    ? response({ sheets: [{ properties: { sheetId: 30, title: 'Upcoming Shows', gridProperties: { rowCount: 10001, columnCount: 6 } } }] })
    : response({ values: data }), { maxRows: 2 }));
  await assert.rejects(source.load(), /may exceed the 2-row read limit/);
});

test('live source reports inaccessible sheets, missing tabs, credentials, and required columns', async () => {
  await assert.rejects(createShowSource(liveConfig(async () => response({}, 404))).load(), /HTTP 404/);
  await assert.rejects(createShowSource(liveConfig(async () => response({ sheets: [] }))).load(), /tab was not found/);
  await assert.rejects(createShowSource(liveConfig(async () => { throw new Error('Offline'); })).load(), { code: 'UNAVAILABLE' });
  await assert.rejects(createShowSource(liveConfig(async () => response({}), { auth: { getAccessToken: async () => ({}) } })).load(), /access token/);
  let calls = 0;
  await assert.rejects(createShowSource(liveConfig(async () => ++calls === 1
    ? response({ sheets: [{ properties: { sheetId: 30, title: 'Upcoming Shows' } }] })
    : response({ values: [['Artist', 'Date']] }))).load(), /required columns/);
});

test('an aborted source request propagates cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createShowSource(liveConfig(async () => assert.fail('Must not fetch'))).load({ signal: controller.signal }), { name: 'AbortError' });
});
