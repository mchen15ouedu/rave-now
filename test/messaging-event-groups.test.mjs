import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.mjs';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { parseShows } from '../src/shows.mjs';
import { buildReminder, findWeekendShows, runDailyReminders } from '../src/reminders.mjs';

const sms = '+15550102026';
const whatsapp = `whatsapp:${sms}`;
const origin = { lat: 32.78, lng: -96.8, label: 'Dallas, TX' };
const headers = ['Artist', 'Event', 'Location', 'City', 'Address', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)'];
const row = (artist, event, date = '2026-10-09', extra = {}) => [
  artist, event, extra.venue || 'Festival Grounds', extra.city || 'Dallas, TX', '',
  extra.ticketUrl || 'https://example.com/festival-tickets', date, 'https://www.youtube.com/watch?v=artist-song',
];
const festivalRows = () => Array.from({ length: 4 }, (_, index) => row(`Festival DJ ${index}`, 'Mega Rave', index < 2 ? '2026-10-09' : '2026-10-10'));
const smallRows = () => Array.from({ length: 3 }, (_, index) => row(`Small DJ ${index}`, 'Small Rave'));
const geocoder = { resolve: async query => query.includes('Seattle') ? { lat: 47.61, lng: -122.33, label: 'Seattle, WA' } : origin };

function setup(t, rows) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const shows = parseShows([headers, ...rows]);
  const config = loadConfig({ APP_MODE: 'demo' });
  const source = { load: async () => ({ shows }) };
  const bot = new Bot({ config, store, source, geocoder, timezones: { resolve: async () => 'America/Chicago' }, clock: () => '2026-10-05' });
  return { bot, store, shows, source, config };
}

async function allPages(bot, from, body) {
  const pages = [];
  let reply = await bot.handle({ from, body });
  while (true) {
    assert.equal(typeof reply, 'string');
    assert.ok(reply.length <= 1450, `Reply was ${reply.length} characters`);
    pages.push(reply);
    assert.ok(pages.length <= 30, 'Result pagination must finish');
    if (!reply.includes('Reply MORE')) break;
    reply = await bot.handle({ from, body: 'MORE' });
  }
  return { first: pages[0], text: pages.join('\n\n'), pages };
}

function assertGrouped(text) {
  assert.equal(text.match(/Mega Rave\n/g)?.length, 1, 'One event title replaces its four performer entries');
  assert.doesNotMatch(text, /Festival DJ/);
  for (let index = 0; index < 3; index++) assert.ok(text.includes(`Small DJ ${index}`), 'Three event entries remain individual shows');
  assert.match(text, /Tickets: https:\/\/example.com\/festival-tickets/);
  assert.match(text, /Listen: https:\/\/www.youtube.com\/results\?search_query=Mega/);
}

test('SMS and WhatsApp FULL group festivals while retaining distant future shows and individual three-entry events', async t => {
  for (const from of [sms, whatsapp]) {
    const { bot } = setup(t, [...festivalRows(), ...smallRows(), row('Distant Future DJ', 'Seattle Future', '2027-05-08', { city: 'Seattle, WA' })]);
    await bot.handle({ from, body: 'INFO' });
    const result = await allPages(bot, from, 'FULL');
    assert.match(result.first, /^5 upcoming shows\nAll locations/);
    assertGrouped(result.text);
    assert.match(result.text, /Distant Future DJ/);
    assert.doesNotMatch(result.text, /temporarily unavailable|straight-line miles/);
  }
});

test('SMS and WhatsApp location and WEEKEND replies group only their selected results and count displayed shows', async t => {
  for (const from of [sms, whatsapp]) {
    const { bot } = setup(t, [...festivalRows(), ...smallRows(), row('Distant Future DJ', 'Seattle Future', '2027-05-08', { city: 'Seattle, WA' })]);
    await bot.handle({ from, body: 'INFO' });
    const nearby = await allPages(bot, from, 'Dallas, TX');
    assert.match(nearby.first, /4 nearby shows for Dallas, TX/);
    assertGrouped(nearby.text);
    assert.doesNotMatch(nearby.text, /Distant Future DJ/);
    const weekend = await allPages(bot, from, 'WEEKEND');
    assert.match(weekend.first, /^4 nearby weekend shows for Dallas, TX/);
    assertGrouped(weekend.text);
    assert.doesNotMatch(weekend.text, /Distant Future DJ/);
  }
});

test('festival summaries paginate complete events once on both messaging channels', async t => {
  const rows = Array.from({ length: 12 }, (_, eventIndex) => Array.from({ length: 4 }, (_, artistIndex) => row(
    `Hidden artist ${eventIndex}/${artistIndex}`, `Festival${String(eventIndex).padStart(2, '0')}`, '2026-10-09',
    { ticketUrl: `https://example.com/${'t'.repeat(220)}?event=${eventIndex}` },
  ))).flat();
  for (const from of [sms, whatsapp]) {
    const { bot } = setup(t, rows);
    await bot.handle({ from, body: 'INFO' });
    const result = await allPages(bot, from, 'FULL');
    assert.match(result.first, /^12 upcoming shows/);
    assert.ok(result.pages.length > 1);
    assert.doesNotMatch(result.text, /Hidden artist/);
    assert.deepEqual([...result.text.matchAll(/^Festival(\d{2})\n/gm)].map(match => Number(match[1])).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index));
    assert.equal(bot.pages.size, 0);
  }
});

test('daily SMS and WhatsApp reminder bodies and template variables collapse festivals and count displayed shows', async t => {
  const { store, source, config } = setup(t, [...festivalRows(), ...smallRows()]);
  for (const from of [sms, whatsapp]) {
    const registered = store.register(from);
    store.saveLocation(from, origin, 'America/Chicago', registered.revision);
  }
  const sent = [];
  const result = await runDailyReminders({
    store, source, config, geocoder, now: new Date('2026-10-06T03:00:00Z'),
    sender: { send: async request => { sent.push(request); return { outcome: 'accepted' }; } },
  });
  assert.equal(result.accepted, 2);
  assert.deepEqual(sent.map(item => item.user.channel).sort(), ['sms', 'whatsapp']);
  for (const { message, body } of sent) {
    assert.match(body, /^4 upcoming weekend shows/);
    assert.equal(body.match(/Mega Rave \|/g)?.length, 1);
    assert.doesNotMatch(body, /Festival DJ/);
    assert.match(body, /Small DJ 0/);
    assert.equal(message.matchesCount, 4);
    assert.equal(message.contentVariables['3'].match(/Mega Rave \(/g)?.length, 1);
    assert.doesNotMatch(message.contentVariables['3'], /Festival DJ/);
    assert.match(message.contentVariables['3'], /Small DJ 0/);
    assert.ok(body.length <= 1400);
    assert.ok(message.contentVariables['3'].length <= 900);
    assert.ok(Object.values(message.contentVariables).every(value => !/[\n\r\t]/.test(value)));
    assert.match(body, /In a different town\? Send your location again/);
  }
});

test('hundreds of festival performers do not inflate bounded reminders or their remaining-show counts', async t => {
  const rows = [
    ...Array.from({ length: 100 }, (_, index) => row(`Hidden hundred DJ ${index}`, 'A Hundred DJ Festival', '2026-10-11')),
    ...Array.from({ length: 20 }, (_, index) => row(`Solo${String(index).padStart(2, '0')} ${'a'.repeat(120)}`, '', '2026-10-10')),
  ];
  const { shows } = setup(t, rows);
  const found = await findWeekendShows({ shows, origin, geocoder, now: '2026-10-05', radiusMiles: 80 });
  assert.equal(found.matches.length, 120);
  const result = buildReminder({ user: { location_label: origin.label }, found });
  assert.equal(result.matchesCount, 21);
  assert.match(result.body, /^21 upcoming weekend shows/);
  assert.equal(result.body.match(/A Hundred DJ Festival \|/g)?.length, 1);
  assert.doesNotMatch(result.body + result.contentVariables['3'], /Hidden hundred DJ/);
  assert.ok(result.body.length <= 1400);
  assert.ok(result.contentVariables['3'].length <= 900);
  assert.match(result.body, /more shows\. Reply WEEKEND for the full list/);
  assert.match(result.contentVariables['3'], /more\. Reply WEEKEND for the full list/);
});
