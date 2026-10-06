import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createArtistCatalog, CatalogError, cleanArtistName, normalizeArtistName } from '../src/artist-catalog.mjs';

const env = { ARTIST_CATALOG_URL: 'https://script.google.com/macros/s/test-deployment/exec', ARTIST_CATALOG_SECRET: 'test-key-never-a-real-secret-00000000' };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const unavailable = error => error instanceof CatalogError && error.code === 'UNAVAILABLE' && !/private|test-key/.test(error.message);
const showHeaders = ['Artist', 'Event', 'Location', 'City', 'Address', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)'];
const showRow = ['Steve Angello', 'Test Festival', 'Venue', 'Dallas, TX', '', 'https://tickets.example/event', 'Fri, Oct 9, 2026', 'https://youtu.be/artist'];

test('artist normalization matches accents, case and spacing while preserving readable spelling', () => {
  assert.equal(cleanArtistName('  Tiësto   &   Friends  '), 'Tiësto & Friends');
  assert.equal(normalizeArtistName('Tiësto'), normalizeArtistName('TIESTO'));
  assert.equal(normalizeArtistName('Beyonce\u0301'), normalizeArtistName('Beyoncé'));
  for (const name of ['', ' '.repeat(3), null, 123, 'a'.repeat(121), 'Artist\nName', 'Artist\u202eName']) {
    assert.throws(() => cleanArtistName(name), error => error.code === 'INVALID_NAME');
  }
});

test('snapshot catalog returns names only, deduplicated, with additions explicitly disconnected', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rave-catalog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const snapshotFile = path.join(dir, 'catalog.json');
  await writeFile(snapshotFile, JSON.stringify({ artists: ['Tiësto', 'TIESTO', '  Carl Cox '], promoters: ['Insomniac'], instagram: ['private'] }));
  const catalog = createArtistCatalog({ env: {}, snapshotFile, fetchImpl() { throw new Error('Must not contact Google'); } });
  assert.deepEqual(await catalog.load(), { artists: ['Tiësto', 'Carl Cox'], promoters: ['Insomniac'], canAdd: false });
  await assert.rejects(catalog.ensureArtist('New DJ'), error => error.code === 'NOT_CONFIGURED');
  assert.equal(JSON.parse(await readFile(snapshotFile, 'utf8')).artists.length, 3);
});

test('catalog reads authenticate in a POST body and expose only usable names', async () => {
  const requests = [];
  const catalog = createArtistCatalog({ env, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return json({ ok: true, artists: ['Tiësto', 'Tiesto'], promoters: ['Insomniac'], notes: 'private notes' });
  } });
  assert.deepEqual(await catalog.load(), { artists: ['Tiësto'], promoters: ['Insomniac'], canAdd: true });
  assert.equal(requests[0].url, env.ARTIST_CATALOG_URL);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.deepEqual(JSON.parse(requests[0].options.body), { secret: env.ARTIST_CATALOG_SECRET, action: 'readCatalog' });
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.ok(!requests[0].url.includes(env.ARTIST_CATALOG_SECRET));
});

test('ContentService redirect is fetched by GET without forwarding the secret', async () => {
  const requests = [];
  const outputUrl = 'https://script.googleusercontent.com/macros/echo?user_content_key=output';
  const catalog = createArtistCatalog({ env, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? new Response(null, { status: 302, headers: { Location: outputUrl } }) : json({ ok: true, artists: [], promoters: [] });
  } });
  assert.equal((await catalog.load()).canAdd, true);
  assert.equal(requests[1].url, outputUrl);
  assert.equal(requests[1].options.method, 'GET');
  assert.equal(requests[1].options.body, undefined);
  assert.equal(requests[1].options.headers, undefined);
  assert.equal(requests[1].options.redirect, 'error');
});

test('an unexpected redirect is rejected without contacting its destination', async () => {
  let calls = 0;
  const catalog = createArtistCatalog({ env, fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 307, headers: { Location: 'https://example.com/steal' } });
  } });
  await assert.rejects(catalog.load(), unavailable);
  assert.equal(calls, 1);
  const login = createArtistCatalog({ env, fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://accounts.google.com/login' } }) });
  await assert.rejects(login.load(), unavailable);
});

test('configured failures never pretend to use the snapshot or add an artist', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('private token error test-key'); },
    async () => new Response('private error test-key', { status: 403 }),
    async () => json({ ok: false, code: 'UNAUTHORIZED', error: 'private error' }),
    async () => new Response('<html>Google sign-in required</html>'),
    async () => json({ ok: true, artists: ['Artist'], promoters: null }),
  ]) {
    const catalog = createArtistCatalog({ env, fetchImpl, snapshotFile: 'not-used.json' });
    await assert.rejects(catalog.load(), unavailable);
  }
  const failedWrite = createArtistCatalog({ env, fetchImpl: async () => json({ ok: false, code: 'UNAVAILABLE', added: true }) });
  await assert.rejects(failedWrite.ensureArtist('New DJ'), unavailable);
});

test('missing or invalid bridge configuration never sends credentials to arbitrary endpoints', async () => {
  for (const invalid of [
    { ARTIST_CATALOG_URL: env.ARTIST_CATALOG_URL },
    { ARTIST_CATALOG_SECRET: env.ARTIST_CATALOG_SECRET },
    { ...env, ARTIST_CATALOG_SECRET: 'too-short' },
    { ...env, ARTIST_CATALOG_URL: 'http://script.google.com/macros/s/test/exec' },
    { ...env, ARTIST_CATALOG_URL: 'https://script.google.com.evil.test/macros/s/test/exec' },
    { ...env, ARTIST_CATALOG_URL: env.ARTIST_CATALOG_URL + '?key=value' },
    { ...env, ARTIST_CATALOG_URL: env.ARTIST_CATALOG_URL.replace('/exec', '/dev') },
  ]) {
    let calls = 0;
    const catalog = createArtistCatalog({ env: invalid, fetchImpl: async () => { calls++; return json({ ok: true, artists: [], promoters: [] }); } });
    await assert.rejects(catalog.load(), error => error.code === 'INVALID_CONFIGURATION');
    assert.equal(calls, 0);
  }
});

test('ensureArtist preserves entered spelling and verifies the returned name and added flag', async () => {
  let payload;
  const catalog = createArtistCatalog({ env, fetchImpl: async (url, options) => {
    payload = JSON.parse(options.body);
    return json({ ok: true, name: 'Tiësto', added: false });
  } });
  assert.deepEqual(await catalog.ensureArtist('  TIESTO  '), { name: 'Tiësto', added: false });
  assert.deepEqual(payload, { secret: env.ARTIST_CATALOG_SECRET, action: 'ensureArtist', name: 'TIESTO' });
  for (const result of [{ ok: true, name: 'Different DJ', added: true }, { ok: true, name: 'Tiësto', added: 'true' }]) {
    await assert.rejects(createArtistCatalog({ env, fetchImpl: async () => json(result) }).ensureArtist('Tiesto'), unavailable);
  }
});

test('invalid names are rejected before a provider call and caller cancellation is explicit', async () => {
  let calls = 0;
  const catalog = createArtistCatalog({ env, fetchImpl: async () => { calls++; return json({ ok: true, artists: [], promoters: [] }); } });
  await assert.rejects(catalog.ensureArtist('Artist\u0000Name'), error => error.code === 'INVALID_NAME');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(catalog.load({ signal: controller.signal }), error => error.code === 'CANCELLED');
  assert.equal(calls, 0);
});

test('oversized catalog responses are rejected', async () => {
  const catalog = createArtistCatalog({ env, fetchImpl: async () => new Response('x', { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }) });
  await assert.rejects(catalog.load(), unavailable);
});

test('readShows authenticates the fixed operation and returns canonical public columns only', async () => {
  let payload;
  const catalog = createArtistCatalog({ env, fetchImpl: async (url, options) => {
    assert.equal(url, env.ARTIST_CATALOG_URL);
    payload = JSON.parse(options.body);
    return json({ ok: true, rows: [['Internal Notes', ...showHeaders.toReversed()], ['private notes', ...showRow.toReversed()]], lastEditedAt: 'unverified' });
  } });
  assert.deepEqual(await catalog.readShows(), { rows: [showHeaders, showRow] });
  assert.deepEqual(payload, { secret: env.ARTIST_CATALOG_SECRET, action: 'readShows' });
});

test('readShows rejects invalid schemas, non-string cells, inconsistent columns and oversized tables', async () => {
  const invalidRows = [
    null, [], [showHeaders.slice(1)],
    [[...showHeaders, 'Artist']],
    [showHeaders, showRow.slice(1)],
    [showHeaders, [...showRow.slice(0, -1), 123]],
    [[...showHeaders, ...Array(93).fill('Extra')]],
    [showHeaders, ...Array.from({ length: 10001 }, () => showRow)],
  ];
  for (const rows of invalidRows) {
    await assert.rejects(createArtistCatalog({ env, fetchImpl: async () => json({ ok: true, rows }) }).readShows(), unavailable);
  }
  const accepted = createArtistCatalog({ env, fetchImpl: async () => json({ ok: true, rows: [showHeaders, ...Array.from({ length: 10000 }, () => ['', '', '', '', '', '', '', ''])] }) });
  assert.equal((await accepted.readShows()).rows.length, 10001);
});

test('readShows supports a header-only empty sheet and normalized header spelling', async () => {
  const normalized = [' Artist ', 'EVENT', 'location', 'city', 'Address', 'Ticket-Link', 'SHOW TIME', 'YouTube (Most Popular Song)'];
  assert.deepEqual(await createArtistCatalog({ env, fetchImpl: async () => json({ ok: true, rows: [normalized] }) }).readShows(), { rows: [showHeaders] });
});

test('readShows is explicitly disconnected without the bridge and never uses the catalog snapshot as events', async () => {
  let calls = 0;
  const catalog = createArtistCatalog({ env: {}, fetchImpl: async () => { calls++; return json({ ok: true, rows: [showHeaders] }); } });
  await assert.rejects(catalog.readShows(), error => error.code === 'NOT_CONFIGURED');
  assert.equal(calls, 0);
  await assert.rejects(createArtistCatalog({ env, fetchImpl: async () => json({ ok: false, code: 'LIMIT_EXCEEDED' }) }).readShows(), unavailable);
});

test('readShows respects cancellation before and during the provider request', async () => {
  let calls = 0;
  const cancelled = new AbortController(); cancelled.abort();
  const catalog = createArtistCatalog({ env, fetchImpl: async () => { calls++; return json({ ok: true, rows: [showHeaders] }); } });
  await assert.rejects(catalog.readShows({ signal: cancelled.signal }), error => error.code === 'CANCELLED');
  assert.equal(calls, 0);
  const active = new AbortController(), started = deferredCatalog(), response = deferredCatalog();
  const pending = createArtistCatalog({ env, fetchImpl: async () => { started.resolve(); return response.promise; } });
  const waiting = pending.readShows({ signal: active.signal });
  const rejected = assert.rejects(waiting, error => error.code === 'CANCELLED');
  await started.promise; active.abort(); await rejected;
  response.resolve(json({ ok: true, rows: [showHeaders] }));
  await pending.readShows();
});

test('readShows retains the 2 MiB response cap for event data', async () => {
  const catalog = createArtistCatalog({ env, fetchImpl: async () => json({ ok: true, rows: [showHeaders, ['x'.repeat(2 * 1024 * 1024), ...showRow.slice(1)]] }) });
  await assert.rejects(catalog.readShows(), unavailable);
});

async function bridgeFixture({ artistNames = ['Tiësto'], promoterNames = ['Insomniac'], header = 'Name', busy = false, showRows = [showHeaders, showRow], showName = 'Upcoming Shows', showLastRow, showLastColumn, catalogsPresent = true, scriptProperties = {} } = {}) {
  const script = await readFile(new URL('../deploy/google/artist-catalog-bridge.gs', import.meta.url), 'utf8');
  const writes = [], formats = [], opens = [], sheetIds = [], showRanges = [], log = [];
  function sheet(id, name, names) {
    return {
      names: [...names], maxRows: 100,
      getSheetId() { return id; }, getName() { return name; },
      getLastRow() { return this.names.length + 1; }, getMaxRows() { return this.maxRows; },
      insertRowsAfter(after, count) { this.maxRows += count; },
      getRange(row, column, count = 1, width = 1) {
        const owner = this;
        return {
          getDisplayValue() { return row === 1 && column === 2 ? header : owner.names[row - 2] || ''; },
          getDisplayValues() { return owner.names.slice(row - 2, row - 2 + count).map(value => [value]); },
          copyFormatToRange(target, c1, c2, r1, r2) { formats.push({ target: target.getSheetId(), c1, c2, r1, r2 }); },
          getTextStyle() { return { retained: true }; },
          setRichTextValue(value) {
            assert.equal(column, 2); assert.equal(width, 1);
            log.push('write'); writes.push({ id, row, column, text: value.text, style: value.style });
            owner.names[row - 2] = value.text;
          },
        };
      },
    };
  }
  const artist = sheet(10, 'Artist List', artistNames), promoter = sheet(20, 'Promoter List', promoterNames);
  const upcoming = {
    getName() { return showName; },
    getLastRow() { return showLastRow ?? showRows.length; },
    getLastColumn() { return showLastColumn ?? showRows[0]?.length ?? 0; },
    getRange(row, column, count, width) {
      showRanges.push({ row, column, count, width });
      return { getDisplayValues: () => showRows.slice(row - 1, row - 1 + count).map(values => values.slice(column - 1, column - 1 + width)) };
    },
  };
  const properties = { ARTIST_CATALOG_SECRET: env.ARTIST_CATALOG_SECRET, CATALOG_WORKBOOK_ID: 'example-workbook', CATALOG_ARTIST_SHEET_ID: '10', CATALOG_PROMOTER_SHEET_ID: '20', CATALOG_SHOW_SHEET_ID: '30', ...scriptProperties };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] ?? null }) },
    LockService: { getScriptLock: () => ({ tryLock() { log.push('lock'); return !busy; }, releaseLock() { log.push('release'); } }) },
    SpreadsheetApp: {
      openById(id) { opens.push(id); log.push('open'); return { getSheetById: id => {
        sheetIds.push(id);
        return id === 30 ? upcoming : catalogsPresent && id === 10 ? artist : catalogsPresent && id === 20 ? promoter : null;
      } }; },
      flush() { log.push('flush'); },
      newRichTextValue() { return { setText(text) { this.text = text; return this; }, setTextStyle(style) { this.style = style; return this; }, build() { return { text: this.text, style: this.style }; } }; },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
  });
  vm.runInContext(script, context);
  return { artist, promoter, writes, formats, opens, sheetIds, showRanges, log,
    post(input) { return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(input) } }).text); },
    get() { return JSON.parse(context.doGet().text); },
  };
}

test('bridge requires authentication and only accepts the three fixed operations', async () => {
  const fixture = await bridgeFixture();
  assert.equal(fixture.post({ action: 'readCatalog', secret: 'wrong' }).code, 'UNAUTHORIZED');
  assert.equal(fixture.post({ action: 'deleteSheet', secret: env.ARTIST_CATALOG_SECRET }).code, 'INVALID_ACTION');
  assert.equal(fixture.get().code, 'POST_REQUIRED');
  assert.equal(fixture.opens.length, 0);
});

test('bridge rejects missing, malformed or duplicate configured identities before accessing a workbook', async () => {
  const request = { action: 'readShows', secret: env.ARTIST_CATALOG_SECRET };
  for (const scriptProperties of [
    { CATALOG_WORKBOOK_ID: '' }, { CATALOG_WORKBOOK_ID: 'https://example.com/workbook' },
    { CATALOG_ARTIST_SHEET_ID: '' }, { CATALOG_PROMOTER_SHEET_ID: '-1' },
    { CATALOG_SHOW_SHEET_ID: '30.5' }, { CATALOG_SHOW_SHEET_ID: '2147483648' },
    { CATALOG_SHOW_SHEET_ID: '10' },
  ]) {
    const fixture = await bridgeFixture({ scriptProperties });
    assert.deepEqual(fixture.post(request), { ok: false, code: 'INVALID_CONFIGURATION' });
    assert.deepEqual(fixture.opens, []);
    assert.deepEqual(fixture.writes, []);
  }
});

test('bridge readShows uses only the fixed workbook and Upcoming Shows tab, returning public event columns', async () => {
  const fixture = await bridgeFixture({ showRows: [[...showHeaders.toReversed(), 'Internal Notes'], [...showRow.toReversed(), 'private notes']], catalogsPresent: false });
  const result = fixture.post({ action: 'readShows', secret: env.ARTIST_CATALOG_SECRET, spreadsheetId: 'other', sheetId: 20, range: 'A:Z' });
  assert.deepEqual(result, { ok: true, rows: [showHeaders, showRow] });
  assert.deepEqual(fixture.opens, ['example-workbook']);
  assert.deepEqual(fixture.sheetIds, [30]);
  assert.deepEqual(fixture.showRanges, [{ row: 1, column: 1, count: 2, width: 9 }]);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.formats, []);
  assert.deepEqual(fixture.log, ['open']);
});

test('bridge readShows rejects changed schemas and sheet names without returning partial data', async () => {
  const request = { action: 'readShows', secret: env.ARTIST_CATALOG_SECRET };
  for (const options of [{ showName: 'Other Tab' }, { showRows: [showHeaders.slice(1)] }, { showRows: [[...showHeaders, 'Artist']] }, { showRows: [] }]) {
    const fixture = await bridgeFixture(options);
    assert.deepEqual(fixture.post(request), { ok: false, code: 'INVALID_STRUCTURE' });
    assert.equal(fixture.writes.length, 0);
    assert.deepEqual(fixture.log, ['open']);
  }
});

test('bridge readShows checks row and column limits before reading instead of truncating', async () => {
  const request = { action: 'readShows', secret: env.ARTIST_CATALOG_SECRET };
  for (const options of [{ showLastRow: 10002 }, { showLastColumn: 101 }]) {
    const fixture = await bridgeFixture(options);
    assert.deepEqual(fixture.post(request), { ok: false, code: 'LIMIT_EXCEEDED' });
    assert.deepEqual(fixture.showRanges, []);
    assert.deepEqual(fixture.log, ['open']);
  }
  const empty = await bridgeFixture({ showRows: [showHeaders] });
  assert.deepEqual(empty.post(request), { ok: true, rows: [showHeaders] });
});

test('bridge reads fixed name columns only and ignores requested workbook/range overrides', async () => {
  const fixture = await bridgeFixture();
  assert.deepEqual(fixture.post({ action: 'readCatalog', secret: env.ARTIST_CATALOG_SECRET, spreadsheetId: 'other', range: 'A:Z' }), { ok: true, artists: ['Tiësto'], promoters: ['Insomniac'] });
  assert.deepEqual(fixture.opens, ['example-workbook']);
  assert.equal(fixture.writes.length, 0);
});

test('bridge readers remain available while an artist writer holds the script lock', async () => {
  const fixture = await bridgeFixture({ busy: true });
  const request = { secret: env.ARTIST_CATALOG_SECRET };
  assert.equal(fixture.post({ ...request, action: 'readCatalog' }).ok, true);
  assert.equal(fixture.post({ ...request, action: 'readShows' }).ok, true);
  assert.deepEqual(fixture.log, ['open', 'open']);
  assert.equal(fixture.post({ ...request, action: 'ensureArtist', name: 'Sample New DJ' }).code, 'BUSY');
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.log, ['open', 'open', 'open', 'lock']);
});

test('bridge normalizes duplicate additions under the lock and writes only artist Name B', async () => {
  const fixture = await bridgeFixture();
  const body = { action: 'ensureArtist', secret: env.ARTIST_CATALOG_SECRET };
  assert.deepEqual(fixture.post({ ...body, name: '  TIESTO  ' }), { ok: true, name: 'Tiësto', added: false });
  assert.deepEqual(fixture.post({ ...body, name: '  New   DJ  ' }), { ok: true, name: 'New DJ', added: true });
  assert.deepEqual(fixture.post({ ...body, name: 'new dj' }), { ok: true, name: 'New DJ', added: false });
  assert.deepEqual(fixture.writes, [{ id: 10, row: 3, column: 2, text: 'New DJ', style: { retained: true } }]);
  assert.deepEqual(fixture.promoter.names, ['Insomniac']);
  assert.deepEqual(fixture.formats, [{ target: 10, c1: 1, c2: 3, r1: 3, r2: 3 }]);
  const writeIndex = fixture.log.indexOf('write');
  assert.ok(fixture.log.lastIndexOf('lock', writeIndex) < writeIndex);
  assert.equal(fixture.log[writeIndex + 1], 'flush');
  assert.equal(fixture.log[writeIndex + 2], 'release');
});

test('bridge uses literal rich text for formula-looking input, and stops safely on schema changes or lock contention', async () => {
  const fixture = await bridgeFixture();
  const body = { action: 'ensureArtist', secret: env.ARTIST_CATALOG_SECRET, name: '=IMPORTXML("https://example.com", "//p")' };
  assert.equal(fixture.post(body).added, true);
  assert.equal(fixture.writes[0].text, body.name);
  const changed = await bridgeFixture({ header: 'Unexpected' });
  assert.equal(changed.post(body).code, 'INVALID_STRUCTURE');
  assert.equal(changed.writes.length, 0);
  assert.equal(changed.log.at(-1), 'release');
  const busy = await bridgeFixture({ busy: true });
  assert.equal(busy.post(body).code, 'BUSY');
  assert.equal(busy.opens.length, 1);
  assert.deepEqual(busy.writes, []);
  assert.deepEqual(busy.log, ['open', 'lock']);
});


function deferredCatalog() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('catalog refreshes share a cold read, and a cancelled visitor does not poison its replacement', async () => {
  const pending = deferredCatalog(), started = deferredCatalog();
  let calls = 0, upstreamSignal;
  const catalog = createArtistCatalog({ env, fetchImpl: async (url, options) => {
    calls++; upstreamSignal = options.signal; started.resolve(); return pending.promise;
  } });
  const visitor = new AbortController();
  const previous = catalog.load({ signal: visitor.signal });
  const cancelled = assert.rejects(previous, error => error.code === 'CANCELLED');
  await started.promise; visitor.abort(); await cancelled;
  const refresh = catalog.load();
  assert.equal(upstreamSignal.aborted, false);
  pending.resolve(json({ ok: true, artists: ['Sample DJ'], promoters: [] }));
  assert.deepEqual((await refresh).artists, ['Sample DJ']);
  assert.equal(calls, 1);
});

test('catalog cache expires at sixty seconds, exposes fresh outages, and reflects a successful addition immediately', async () => {
  let time = 0, reads = 0, writes = 0, fail = false;
  const catalog = createArtistCatalog({ env, clock: () => time, fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.action === 'ensureArtist') { writes++; return json({ ok: true, name: payload.name, added: true }); }
    reads++;
    if (fail) return json({ ok: false, code: 'UNAVAILABLE' });
    return json({ ok: true, artists: ['Sample Original'], promoters: [] });
  } });
  await catalog.load(); time = 59_000;
  await catalog.ensureArtist('Sample New');
  assert.deepEqual((await catalog.load()).artists, ['Sample Original', 'Sample New']);
  assert.equal(reads, 1); assert.equal(writes, 1);
  time = 60_000; fail = true;
  await assert.rejects(catalog.load(), unavailable);
  assert.equal(reads, 2, 'Adding a name must not extend the age of the old catalog');
});

test('an older catalog response cannot overwrite the catalog refreshed after an artist addition', async () => {
  const old = deferredCatalog(), started = deferredCatalog();
  let reads = 0;
  const catalog = createArtistCatalog({ env, fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.action === 'ensureArtist') return json({ ok: true, name: payload.name, added: true });
    reads++;
    if (reads === 1) { started.resolve(); return old.promise; }
    return json({ ok: true, artists: ['Sample Added'], promoters: [] });
  } });
  const previous = catalog.load(); await started.promise;
  await catalog.ensureArtist('Sample Added');
  assert.deepEqual((await catalog.load()).artists, ['Sample Added']);
  old.resolve(json({ ok: true, artists: [], promoters: [] })); await previous;
  assert.deepEqual((await catalog.load()).artists, ['Sample Added']);
  assert.equal(reads, 2);
});

test('concurrent show reads share only read work and failed artist mutations are never retried', async () => {
  const pending = deferredCatalog(), started = deferredCatalog();
  let reads = 0, writes = 0;
  const catalog = createArtistCatalog({ env, fetchImpl: async (url, options) => {
    const action = JSON.parse(options.body).action;
    if (action === 'ensureArtist') { writes++; throw new Error('private mutation failure'); }
    reads++; started.resolve(); return pending.promise;
  } });
  const a = catalog.readShows(), b = catalog.readShows(); await started.promise;
  pending.resolve(json({ ok: true, rows: [showHeaders, showRow] }));
  const [first, second] = await Promise.all([a, b]);
  assert.equal(reads, 1); first.rows[1][0] = 'Changed locally';
  assert.notEqual(first.rows[1][0], second.rows[1][0]);
  await assert.rejects(catalog.ensureArtist('Sample New'), unavailable);
  assert.equal(writes, 1);
});
