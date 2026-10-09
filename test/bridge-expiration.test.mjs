import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash, createHmac } from 'node:crypto';
import { planExpiredShows } from '../src/show-expiration.mjs';

const secret = 'expiration-fixture-secret-'.repeat(2);
const headers = ['Artist', 'Event', 'Location', 'City', 'Address', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)', 'Category'];
const show = (artist, start, overrides = {}) => [
  artist, overrides.event ?? 'Example Weekend', 'Example Hall', 'Dallas, TX', '100 Example Road, Dallas, TX',
  'https://tickets.example/event', start, 'https://www.youtube.com/watch?v=sample', overrides.category ?? 'Nighttime',
];
const clockValue = '2026-10-09T12:00:00.000Z';
const expiredAt = '2026-10-07T00:00:00.000Z';
const copyRows = rows => rows.map(row => [...row]);

async function fixture({ rows = [headers, show('Example Artist', '2026-10-01')], raw = [], formulas = [], formats = [], busy = false,
  timeZone = 'America/Chicago', protectedRows = [], protectedSheet = false, mergedRows = [], uneditableRows = [],
  showName = 'Upcoming Shows', lastRow, lastColumn, now = clockValue, deleteFailure = false, formatFailure = false } = {}) {
  const code = await readFile(new URL('../deploy/google/artist-catalog-bridge.gs', import.meta.url), 'utf8');
  const state = { rows: copyRows(rows), raw: copyRows(raw), formulas: copyRows(formulas), formats: copyRows(formats), now: Date.parse(now) };
  const deletions = [], opens = [], ids = [], log = [];
  let context;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  }
  const interval = (first, last = first) => ({ getRow: () => first, getNumRows: () => last - first + 1 });
  const sheet = {
    getSheetId: () => context.CATALOG_SHOW_SHEET_ID ?? 30,
    getName: () => showName,
    getLastRow: () => lastRow ?? state.rows.length,
    getLastColumn: () => lastColumn ?? state.rows[0]?.length ?? 0,
    getMaxColumns: () => Math.max(20, state.rows[0]?.length ?? 0),
    getProtections: kind => kind === 'SHEET' ? protectedSheet ? [{}] : [] : protectedRows.map(row => ({
      getRange: () => interval(typeof row === 'number' ? row : row.first, typeof row === 'number' ? row : row.last),
    })),
    getRange(row, column, count = 1, width = 1) {
      const at = (array, r, c, fallback) => array[r - 1]?.[c - 1] ?? fallback;
      const matrix = get => Array.from({ length: count }, (_, offset) => Array.from({ length: width }, (_, across) => get(row + offset, column + across)));
      return {
        getDisplayValues: () => { log.push('display'); return matrix((r, c) => String(at(state.rows, r, c, ''))); },
        getValues: () => matrix((r, c) => at(state.raw, r, c, at(state.rows, r, c, ''))),
        getFormulas: () => matrix((r, c) => at(state.formulas, r, c, '')),
        getNumberFormats: () => matrix((r, c) => at(state.formats, r, c, 'General')),
        getMergedRanges: () => mergedRows.map(value => interval(typeof value === 'number' ? value : value.first, typeof value === 'number' ? value : value.last))
          .filter(value => value.getRow() <= row + count - 1 && value.getRow() + value.getNumRows() - 1 >= row),
        canEdit: () => !uneditableRows.some(value => value >= row && value < row + count),
      };
    },
    deleteRows(first, count) {
      if (deleteFailure) throw new Error('provider detail must stay private');
      assert.ok(first >= 2, 'header cannot be deleted');
      assert.ok(first + count <= state.rows.length + 1, 'out-of-range rows cannot be deleted');
      log.push('delete');
      deletions.push({ first, count });
      for (const data of [state.rows, state.raw, state.formulas, state.formats]) data.splice(first - 1, count);
    },
  };
  const properties = {
    ARTIST_CATALOG_SECRET: secret, CATALOG_WORKBOOK_ID: 'example-workbook',
    CATALOG_ARTIST_SHEET_ID: '10', CATALOG_PROMOTER_SHEET_ID: '20', CATALOG_SHOW_SHEET_ID: '30',
  };
  const formatDate = (date, zone) => {
    if (formatFailure) throw new Error('private provider formatting detail');
    const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: zone }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return values.year + '-' + values.month + '-' + values.day;
  };
  context = vm.createContext({
    Date: FixedDate,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] ?? null }) },
    LockService: { getScriptLock: () => ({ tryLock() { log.push('lock'); return !busy; }, releaseLock() { log.push('release'); } }) },
    SpreadsheetApp: {
      ProtectionType: { RANGE: 'RANGE', SHEET: 'SHEET' },
      openById(id) {
        const expected = context.CATALOG_WORKBOOK_ID ?? 'example-workbook';
        assert.equal(id, expected);
        opens.push(id); log.push('open');
        return {
          getId: () => expected, getSpreadsheetTimeZone: () => timeZone,
          getSheetById(id) { ids.push(id); return id === sheet.getSheetId() ? sheet : null; },
        };
      },
      flush: () => log.push('flush'),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, value) => [...createHash(algorithm).update(value).digest()],
      computeHmacSha256Signature: (value, key) => [...createHmac('sha256', key).update(value).digest()],
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url'),
      formatDate,
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
  });
  vm.runInContext(code, context);
  return {
    state, deletions, opens, ids, log,
    post(input) { return JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ secret, ...input }) } }).text); },
    snapshot() { return this.post({ action: 'readExpirationSnapshot' }); },
  };
}

function plan(snapshot, rows = snapshot.rows.map(record => record.row), expiresAt = expiredAt) {
  return {
    snapshotToken: snapshot.snapshotToken,
    candidates: rows.map(row => ({ row, fingerprint: snapshot.rows.find(record => record.row === row).fingerprint, expiresAt })),
  };
}

test('expiration snapshots authenticate, target only the configured show sheet and hold the writer lock', async () => {
  const data = await fixture();
  assert.equal(data.post({ action: 'readExpirationSnapshot', secret: 'wrong' }).code, 'UNAUTHORIZED');
  assert.equal(data.opens.length, 0);
  const result = data.post({ action: 'readExpirationSnapshot', workbookId: 'other', sheetId: -1, range: 'A:Z' });
  assert.equal(result.ok, true);
  assert.equal(result.timeZone, 'America/Chicago');
  assert.equal(result.capturedAt, clockValue);
  assert.match(result.snapshotToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(result.rows[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(data.ids.length, 1);
  assert.ok(data.log.indexOf('lock') < data.log.indexOf('display'));
  assert.equal(data.log.at(-1), 'release');
  assert.equal(data.deletions.length, 0);
  const busy = await fixture({ busy: true });
  assert.equal(busy.snapshot().code, 'BUSY');
  assert.equal(busy.log.includes('display'), false);
});

test('expiration snapshots retain all source rows and end/zone metadata, including continuing festivals and ambiguous dates', async () => {
  const fields = [...headers, 'Festival End', 'Time Zone', 'Internal Notes'];
  const rows = [
    fields,
    [...show('First DJ', '2026-10-01', { category: 'Festival' }), '2026-10-11', 'America/New_York', 'private'],
    [...show('Last DJ', '2026-10-11', { category: 'Festival' }), '', '', 'private'],
    [...show('Unknown DJ', 'TBA', { category: 'Festival' }), 'TBA', '', 'private'],
    [...show('', '', { event: '', category: '' }), '', '', 'private'],
  ];
  const data = await fixture({ rows });
  const snapshot = data.snapshot();
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.rows.map(record => record.row), [2, 3, 4, 5]);
  assert.deepEqual(snapshot.rows.map(record => record.start), ['2026-10-01', '2026-10-11', 'TBA', '']);
  assert.equal(snapshot.rows[0].end, '2026-10-11');
  assert.equal(snapshot.rows[0].timeZone, 'America/New_York');
  assert.equal(snapshot.rows[1].timeZone, null);
  assert.equal(snapshot.rows[2].end, 'TBA');
  assert.ok(snapshot.rows.every(record => record.startInstant === null && record.startDateOnly === null));
  assert.ok(snapshot.rows.every(record => !Object.hasOwn(record, 'notes')));
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
  assert.equal(data.deletions.length, 0);
});

test('native date-only cells are canonical local dates rather than an invented midnight show clock', async () => {
  const fields = [...headers, 'End Date'];
  const rows = [fields, [...show('Date-only DJ', '10/01/2026'), '10/03/2026'], [...show('Timed DJ', '10/02/2026 20:00'), '10/03/2026 23:00']];
  const raw = copyRows(rows), formats = rows.map(row => row.map(() => 'General'));
  raw[1][6] = new Date('2026-10-01T05:00:00.000Z');
  raw[1][9] = new Date('2026-10-03T05:00:00.000Z');
  raw[2][6] = new Date('2026-10-03T01:00:00.000Z');
  raw[2][9] = new Date('2026-10-04T04:00:00.000Z');
  formats[1][6] = 'm/d/yyyy'; formats[1][9] = 'yyyy-mm-dd';
  formats[2][6] = 'm/d/yyyy "at" h:mm'; formats[2][9] = 'yyyy-mm-dd hh:mm:ss';
  const snapshot = (await fixture({ rows, raw, formats })).snapshot();
  assert.equal(snapshot.rows[0].start, '2026-10-01');
  assert.equal(snapshot.rows[0].end, '2026-10-03');
  assert.equal(snapshot.rows[0].startDateOnly, true);
  assert.equal(snapshot.rows[0].endDateOnly, true);
  assert.equal(snapshot.rows[0].startInstant, '2026-10-01T05:00:00.000Z');
  assert.equal(snapshot.rows[1].startDateOnly, false);
  assert.equal(snapshot.rows[1].endDateOnly, false);
});

test('unknown workbook timezone preserves native date-only values without failing the complete source snapshot', async () => {
  const fields = [...headers, 'End Date'];
  const rows = [fields, [...show('Native DJ', '10/01/2026'), '10/03/2026'], [...show('Text DJ', '2026-10-01'), '2026-10-03']];
  const raw = copyRows(rows), formats = rows.map(row => row.map(() => 'General'));
  raw[1][6] = new Date('2026-10-01T05:00:00.000Z');
  raw[1][9] = new Date('2026-10-03T05:00:00.000Z');
  formats[1][6] = 'm/d/yyyy'; formats[1][9] = 'yyyy-mm-dd';
  for (const timeZone of [null, undefined, 0, '', 'Unknown/Nowhere']) {
    const data = await fixture({ rows, raw, formats, timeZone: timeZone === undefined ? null : timeZone });
    const snapshot = data.snapshot();
    assert.equal(snapshot.ok, true, String(timeZone));
    assert.equal(snapshot.timeZone, typeof timeZone === 'string' ? timeZone : '');
    assert.equal(snapshot.rows[0].start, '10/01/2026');
    assert.equal(snapshot.rows[0].end, '10/03/2026');
    assert.equal(snapshot.rows[0].startInstant, '2026-10-01T05:00:00.000Z');
    assert.equal(snapshot.rows[0].endInstant, '2026-10-03T05:00:00.000Z');
    assert.equal(snapshot.rows[0].startDateOnly, null);
    assert.equal(snapshot.rows[0].endDateOnly, null);
    assert.equal(snapshot.rows[1].start, '2026-10-01');
    assert.equal(snapshot.rows[1].startInstant, null);
    assert.equal(data.deletions.length, 0);
  }
});

test('empty workbook timezone uses only unambiguous displayed native dates and preserves numeric dates from destructive plans', async () => {
  const displays = ['2026-10-01', 'Thu, Oct 1, 2026', 'Thursday, October 1st, 2026', 'Sept. 1, 2026', '10/01/2026', '2026-02-30', 'Octor 1, 2026', 'TBA'];
  const rows = [headers, ...displays.map((display, index) => show('Artist ' + index, display))];
  const raw = copyRows(rows), formats = rows.map(row => row.map(() => 'General'));
  for (let index = 1; index < rows.length; index++) {
    raw[index][6] = new Date('2026-10-01T05:00:00.000Z');
    formats[index][6] = 'm/d/yyyy';
  }
  for (const options of [{ timeZone: '' }, { timeZone: null }, { timeZone: 'America/Chicago', formatFailure: true }]) {
    const data = await fixture({ rows, raw, formats, ...options });
    const snapshot = data.snapshot();
    assert.equal(snapshot.ok, true);
    assert.deepEqual(snapshot.rows.map(record => record.start), displays);
    assert.deepEqual(snapshot.rows.map(record => record.startDateOnly), [true, true, true, true, null, null, null, null]);
    const assessed = planExpiredShows(snapshot, { now: clockValue });
    assert.deepEqual(assessed.candidates.map(candidate => candidate.row), [2, 3, 4, 5]);
    assert.equal(data.deletions.length, 0);
  }
});



test('snapshot signatures exclude capture time but include private values, formulas, formatting and source row order', async () => {
  const rows = [[...headers, 'Private'], [...show('First', '2026-10-01'), 'secret fixture'], [...show('Second', '2026-10-02'), 'different']];
  const data = await fixture({ rows });
  const original = data.snapshot();
  data.state.now += 5000;
  const later = data.snapshot();
  assert.equal(later.snapshotToken, original.snapshotToken);
  assert.deepEqual(later.rows.map(record => record.fingerprint), original.rows.map(record => record.fingerprint));
  assert.notEqual(later.capturedAt, original.capturedAt);
  for (const mutate of [
    state => { state.rows[1][9] = 'changed'; },
    state => { state.formulas[1] = Array(10).fill(''); state.formulas[1][9] = '=1+1'; },
    state => { state.formats[1] = Array(10).fill('General'); state.formats[1][9] = '0.00'; },
    state => { [state.rows[1], state.rows[2]] = [state.rows[2], state.rows[1]]; },
  ]) {
    const changed = await fixture({ rows }); const initial = changed.snapshot(); mutate(changed.state);
    assert.notEqual(changed.snapshot().snapshotToken, initial.snapshotToken);
    assert.equal(changed.post({ action: 'applyExpiredShows', ...plan(initial) }).code, 'STALE_SNAPSHOT');
    assert.equal(changed.deletions.length, 0);
  }
});

test('expiration snapshots reject missing or duplicate headers and exceed limits before reading', async () => {
  for (const rows of [
    [headers.slice(0, -1)], [[...headers, ' CATEGORY ']], [[...headers, 'End Date', 'Show End']],
    [[...headers, 'Time Zone', 'Event Time Zone']], [[...headers, 'Show Time']],
  ]) assert.equal((await fixture({ rows })).snapshot().code, 'INVALID_STRUCTURE');
  assert.equal((await fixture({ showName: 'Other Sheet' })).snapshot().code, 'INVALID_STRUCTURE');
  for (const settings of [{ lastRow: 10002 }, { lastColumn: 101 }]) {
    const data = await fixture(settings);
    assert.equal(data.snapshot().code, 'LIMIT_EXCEEDED');
    assert.equal(data.log.includes('display'), false);
    assert.equal(data.log.at(-1), 'release');
  }
});

test('dry-run reports eligible and skipped rows without deleting or changing the previewed sheet', async () => {
  const rows = [headers, show('First', '2026-10-01'), show('Second', '2026-10-02'), show('Third', '2026-10-03')];
  const data = await fixture({ rows, protectedRows: [3] });
  const snapshot = data.snapshot(), before = structuredClone(data.state);
  const receipt = data.post({ action: 'dryRunExpiredShows', ...plan(snapshot) });
  assert.deepEqual(receipt, { ok: true, deleted: 0, deletedRows: [], skippedRows: [3], eligibleRows: [2, 4] });
  assert.equal(data.deletions.length, 0);
  assert.deepEqual(data.state, before);
  assert.equal(data.log.includes('flush'), false);
});

test('apply deletes only verified physical rows in contiguous blocks from the bottom, preserving the header and remaining formulas', async () => {
  const rows = [headers, ...Array.from({ length: 6 }, (_, index) => show('Artist ' + index, '2026-10-01'))];
  const formulas = rows.map(row => row.map(() => ''));
  formulas[3][5] = '=HYPERLINK("https://tickets.example/kept","Tickets")';
  const data = await fixture({ rows, formulas });
  const snapshot = data.snapshot();
  const receipt = data.post({ action: 'applyExpiredShows', ...plan(snapshot, [7, 2, 6, 3]) });
  assert.deepEqual(receipt, { ok: true, deleted: 4, deletedRows: [2, 3, 6, 7], skippedRows: [] });
  assert.deepEqual(data.deletions, [{ first: 6, count: 2 }, { first: 2, count: 2 }]);
  assert.deepEqual(data.state.rows, [headers, rows[3], rows[4]]);
  assert.equal(data.state.formulas[1][5], formulas[3][5]);
  assert.ok(data.log.indexOf('lock') < data.log.indexOf('delete'));
  assert.deepEqual(data.log.slice(-2), ['flush', 'release']);
});

test('merged, explicitly protected and uneditable rows are skipped even when an owner could edit protections', async () => {
  const rows = [headers, ...Array.from({ length: 5 }, (_, index) => show('Artist ' + index, '2026-10-01'))];
  const data = await fixture({ rows, protectedRows: [2], mergedRows: [{ first: 3, last: 4 }], uneditableRows: [5] });
  const receipt = data.post({ action: 'applyExpiredShows', ...plan(data.snapshot()) });
  assert.deepEqual(receipt, { ok: true, deleted: 1, deletedRows: [6], skippedRows: [2, 3, 4, 5] });
  assert.deepEqual(data.deletions, [{ first: 6, count: 1 }]);
  const sheetProtected = await fixture({ rows, protectedSheet: true });
  assert.deepEqual(sheetProtected.post({ action: 'applyExpiredShows', ...plan(sheetProtected.snapshot()) }), {
    ok: true, deleted: 0, deletedRows: [], skippedRows: [2, 3, 4, 5, 6],
  });
  assert.equal(sheetProtected.deletions.length, 0);
});

test('changed, moved or newly appended festival rows make a cleanup plan stale before any deletion', async () => {
  for (const change of [
    state => { state.rows[1][6] = '2026-10-12'; },
    state => { state.rows.push(show('Future Festival DJ', '2026-10-12', { category: 'Festival' })); },
    state => { state.rows.splice(1, 0, show('Inserted', '2026-10-13')); },
  ]) {
    const data = await fixture({ rows: [headers, show('Past Festival DJ', '2026-10-01', { category: 'Festival' })] });
    const snapshot = data.snapshot(); change(data.state);
    assert.equal(data.post({ action: 'applyExpiredShows', ...plan(snapshot) }).code, 'STALE_SNAPSHOT');
    assert.equal(data.deletions.length, 0);
    assert.equal(data.log.at(-1), 'release');
  }
});

test('malformed candidates, wrong fingerprints, future cutoffs and header rows cannot delete anything', async () => {
  const data = await fixture();
  const initial = data.snapshot(), valid = plan(initial).candidates[0];
  for (const candidate of [
    { ...valid, row: 1 }, { ...valid, row: 1.5 }, { ...valid, row: 10002 },
    { ...valid, expiresAt: '2026-02-30T00:00:00.000Z' }, { ...valid, expiresAt: 'yesterday' },
    { ...valid, expiresAt: '2026-10-07' }, { ...valid, range: 'A1' }, { ...valid, fingerprint: 'bad' },
  ]) assert.equal(data.post({ action: 'applyExpiredShows', snapshotToken: initial.snapshotToken, candidates: [candidate] }).code, 'INVALID_PLAN');
  assert.equal(data.post({ action: 'applyExpiredShows', snapshotToken: initial.snapshotToken, candidates: [valid, valid] }).code, 'INVALID_PLAN');
  assert.equal(data.post({ action: 'applyExpiredShows', snapshotToken: initial.snapshotToken, candidates: [{ ...valid, fingerprint: '0'.repeat(64) }] }).code, 'STALE_SNAPSHOT');
  assert.equal(data.post({ action: 'applyExpiredShows', snapshotToken: initial.snapshotToken, candidates: [{ ...valid, expiresAt: '2026-10-10T00:00:00.000Z' }] }).code, 'NOT_EXPIRED');
  assert.equal(data.post({ action: 'applyExpiredShows', snapshotToken: initial.snapshotToken, candidates: Array(501).fill(valid) }).code, 'LIMIT_EXCEEDED');
  assert.equal(data.post({ action: 'applyExpiredShows', secret: 'wrong', ...plan(initial) }).code, 'UNAUTHORIZED');
  assert.equal(data.deletions.length, 0);
});

test('empty cleanup plans are noops and a repeated uncertain write cannot delete shifted rows', async () => {
  const data = await fixture();
  const snapshot = data.snapshot();
  assert.deepEqual(data.post({ action: 'applyExpiredShows', snapshotToken: snapshot.snapshotToken, candidates: [] }), {
    ok: true, deleted: 0, deletedRows: [], skippedRows: [],
  });
  const request = { action: 'applyExpiredShows', ...plan(snapshot) };
  assert.equal(data.post(request).deleted, 1);
  assert.equal(data.post(request).code, 'STALE_SNAPSHOT');
  assert.equal(data.deletions.length, 1);
  assert.equal(data.state.rows.length, 1);
});

test('cleanup bounds allow 500 reviewed rows and sanitize provider failures while releasing the lock', async () => {
  const rows = [headers, ...Array.from({ length: 500 }, (_, index) => show('Artist ' + index, '2026-10-01'))];
  const data = await fixture({ rows });
  const snapshot = data.snapshot();
  const request = { action: 'applyExpiredShows', ...plan(snapshot) };
  assert.ok(JSON.stringify({ secret, ...request }).length > 16384);
  const receipt = data.post(request);
  assert.equal(receipt.deleted, 500);
  assert.deepEqual(data.deletions, [{ first: 2, count: 500 }]);
  const failing = await fixture({ deleteFailure: true });
  const failed = failing.post({ action: 'applyExpiredShows', ...plan(failing.snapshot()) });
  assert.deepEqual(failed, { ok: false, code: 'UNAVAILABLE' });
  assert.equal(failing.log.at(-1), 'release');
  assert.equal(JSON.stringify(failed).includes('provider detail'), false);
  const busy = await fixture({ busy: true });
  assert.equal(busy.post({ action: 'applyExpiredShows', ...request }).code, 'BUSY');
  assert.equal(busy.deletions.length, 0);
});

