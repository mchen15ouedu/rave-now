import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.mjs';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { parseShows } from '../src/shows.mjs';

const headers = ['Artist', 'Location', 'Address', 'City', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)'];
const row = (artist, date, { venue = 'Example Venue', address = 'Seattle, WA', city = '', ticketUrl = 'https://example.com/ticket' } = {}) =>
  [artist, venue, address, city, ticketUrl, date, ''];
const sms = '+15550102026';
const whatsapp = `whatsapp:${sms}`;

function botForTest(t, rows, overrides = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const shows = parseShows([headers, ...rows]);
  const observations = { sourceCalls: 0, geocoderCalls: 0 };
  const source = { load: async () => { observations.sourceCalls++; return { shows }; } };
  const geocoder = { resolve: async () => { observations.geocoderCalls++; throw new Error('FULL must not geocode'); } };
  const bot = new Bot({ config: loadConfig({ APP_MODE: 'demo' }), store, source, geocoder, clock: () => '2026-10-05', ...overrides });
  return { bot, store, observations, shows };
}

test('FULL works on both channels before a location, includes today and all future dates, and never geocodes', async t => {
  for (const from of [sms, whatsapp]) {
    const { bot, store, observations } = botForTest(t, [
      row('Far future', '2028-04-09'),
      row('Yesterday', '2026-10-04'),
      row('New year', '2027-01-01'),
      row('Today', '2026-10-05'),
      row('Beyond nearby window', '2026-10-12'),
      row('Year end', '2026-12-31'),
    ]);
    await bot.handle({ from, body: 'INFO' });
    const reply = await bot.handle({ from, body: '  fUlL  ' });
    assert.match(reply, /upcoming|future/i);
    assert.doesNotMatch(reply, /Yesterday|temporarily unavailable|nearby shows/i);
    const artists = ['Far future', 'New year', 'Year end', 'Beyond nearby window', 'Today'];
    for (const artist of artists) assert.ok(reply.includes(artist), `Missing ${artist}: ${reply}`);
    for (let index = 1; index < artists.length; index++) assert.ok(reply.indexOf(artists[index - 1]) < reply.indexOf(artists[index]), 'Future shows must have the latest date first');
    assert.equal(observations.sourceCalls, 1);
    assert.equal(observations.geocoderCalls, 0);
    assert.equal(store.get(from).active, 1);
    assert.ok(reply.length <= 1600);
  }
});

test('FULL retains future events without an Address, City, or known venue and uses artist ordering within a date', async t => {
  const { bot, observations } = botForTest(t, [
    row('Zulu', '2026-10-06', { venue: 'TBA', address: 'TBA', city: 'n/a' }),
    row('Alpha', '2026-10-06', { address: '', city: 'Tokyo, Japan' }),
    row('Unknown place', '2026-10-07', { venue: '', address: '', city: '' }),
    row('Date not announced', 'TBA', { address: '' }),
  ]);
  await bot.handle({ from: sms, body: 'INFO' });
  const reply = await bot.handle({ from: sms, body: 'FULL' });
  for (const artist of ['Alpha', 'Zulu', 'Unknown place']) assert.ok(reply.includes(artist), artist);
  assert.doesNotMatch(reply, /Date not announced|Approx\. \d+ straight-line/);
  assert.ok(reply.indexOf('Alpha') < reply.indexOf('Zulu'));
  assert.ok(reply.indexOf('Unknown place') < reply.indexOf('Alpha'));
  assert.match(reply, /Tokyo, Japan/);
  assert.match(reply, /Unknown place\n2026-10-07 \| Venue not announced\.\nLocation not announced\./);
  assert.match(reply, /Zulu\n2026-10-06 \| TBA\nLocation not announced\./);
  assert.equal(observations.geocoderCalls, 0);
});

test('FULL uses the configured calendar date when the UTC date differs', async t => {
  const { bot } = botForTest(t, [row('Chicago today', '2026-10-05'), row('Past date', '2026-10-04')], {
    clock: () => new Date('2026-10-06T02:00:00Z'),
  });
  await bot.handle({ from: sms, body: 'INFO' });
  const reply = await bot.handle({ from: sms, body: 'FULL' });
  assert.match(reply, /Chicago today/);
  assert.doesNotMatch(reply, /Past date/);
});

test('FULL paginates every future event exactly once; MORE headings stay upcoming and a repeated FULL restarts the list', async t => {
  const rows = Array.from({ length: 18 }, (_, index) => row(`Unique${String(index).padStart(2, '0')}`, `2027-01-${String(index + 1).padStart(2, '0')}`, {
    address: index % 2 ? '' : 'A distant venue address in Seattle, WA',
    city: index % 2 ? 'Tokyo, Japan' : '',
    ticketUrl: `https://example.com/tickets/${'a'.repeat(240)}?artist=${index}`,
  }));
  const { bot, observations } = botForTest(t, rows.reverse());
  await bot.handle({ from: whatsapp, body: 'INFO' });
  const firstReply = await bot.handle({ from: whatsapp, body: 'FULL' });
  assert.match(firstReply, /Reply MORE/);
  const nextReply = await bot.handle({ from: whatsapp, body: 'MORE' });
  assert.match(nextReply, /^More upcoming shows:/);
  assert.notEqual(nextReply, firstReply);
  let reply = await bot.handle({ from: whatsapp, body: 'FULL' });
  assert.equal(reply, firstReply, 'A new FULL must reset the saved list');
  const seen = [];
  let pageCount = 0;
  while (true) {
    pageCount++;
    assert.ok(pageCount <= rows.length, 'Pagination must finish without cycling');
    assert.ok(reply.length <= 1600, `Page ${pageCount} has ${reply.length} characters`);
    assert.doesNotMatch(reply, /nearby|straight-line miles/);
    seen.push(...[...reply.matchAll(/Unique(\d{2})\n/g)].map(match => Number(match[1])));
    if (!reply.includes('Reply MORE')) break;
    reply = await bot.handle({ from: whatsapp, body: 'MORE' });
    assert.match(reply, /^More upcoming shows:/);
  }
  assert.ok(pageCount > 1);
  assert.deepEqual(seen, Array.from({ length: 18 }, (_, index) => 17 - index));
  assert.equal(bot.pages.size, 0);
  assert.match(await bot.handle({ from: whatsapp, body: 'MORE' }), /No more saved results/);
  assert.equal(observations.sourceCalls, 2);
  assert.equal(observations.geocoderCalls, 0);
});

test('FULL requires active registration and stays unavailable after STOP or DELETE', async t => {
  const { bot, store, observations } = botForTest(t, [row('Future show', '2027-01-01')]);
  assert.match(await bot.handle({ from: sms, body: 'FULL' }), /register/);
  assert.equal(store.counts().registered, 0);
  await bot.handle({ from: sms, body: 'INFO' });
  await bot.handle({ from: sms, body: 'STOP' });
  assert.match(await bot.handle({ from: sms, body: 'FULL' }), /register again/);
  await bot.handle({ from: sms, body: 'START' });
  await bot.handle({ from: sms, body: 'DELETE' });
  assert.match(await bot.handle({ from: sms, body: 'FULL' }), /register/);
  assert.equal(store.counts().registered, 0);
  assert.equal(observations.sourceCalls, 0);
  assert.equal(observations.geocoderCalls, 0);
  assert.equal(bot.pages.size, 0);
});

test('a pending FULL cannot restore registration or pages after STOP or DELETE', async t => {
  for (const command of ['STOP', 'DELETE']) {
    let release;
    let reached;
    const started = new Promise(resolve => { reached = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const shows = parseShows([headers, ...Array.from({ length: 20 }, (_, index) => row(`Held event ${index}`, '2027-01-01'))]);
    const { bot, store } = botForTest(t, [], {
      source: { load: async () => { reached(); await held; return { shows }; } },
    });
    await bot.handle({ from: whatsapp, body: 'INFO' });
    const pending = bot.handle({ from: whatsapp, body: 'FULL' });
    await started;
    await bot.handle({ from: whatsapp, body: command });
    release();
    assert.equal(await pending, null);
    assert.equal(bot.pages.size, 0);
    if (command === 'DELETE') assert.equal(store.get(whatsapp), undefined);
    else assert.equal(store.get(whatsapp).active, 0);
    assert.match(await bot.handle({ from: whatsapp, body: 'FULL' }), /register/);
  }
});

test('FULL searches share the existing five searches per minute limit', async t => {
  const { bot, observations } = botForTest(t, [row('Future show', '2027-01-01')]);
  await bot.handle({ from: sms, body: 'INFO' });
  for (let index = 0; index < 5; index++) assert.match(await bot.handle({ from: sms, body: 'FULL' }), /Future show/);
  assert.match(await bot.handle({ from: sms, body: 'FULL' }), /wait a minute/);
  assert.equal(observations.sourceCalls, 5);
  assert.equal(observations.geocoderCalls, 0);
});

test('FULL reports an empty future list and source outages without leaking provider details', async t => {
  const empty = botForTest(t, [row('Past only', '2026-10-04')]);
  await empty.bot.handle({ from: sms, body: 'INFO' });
  const emptyReply = await empty.bot.handle({ from: sms, body: 'FULL' });
  assert.match(emptyReply, /No .*upcoming|No .*future/i);
  assert.doesNotMatch(emptyReply, /Past only|nearby/);
  const unavailable = botForTest(t, [], { source: { load: async () => { throw new Error('private source credentials'); } } });
  await unavailable.bot.handle({ from: sms, body: 'INFO' });
  const failedReply = await unavailable.bot.handle({ from: sms, body: 'FULL' });
  assert.match(failedReply, /temporarily unavailable/);
  assert.doesNotMatch(failedReply, /private source credentials|No .*upcoming|No .*future/i);
});
