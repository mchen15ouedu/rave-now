import test from 'node:test';
import assert from 'node:assert/strict';
import { weekendWindow, findWeekendShows, buildReminder, runDailyReminders } from '../src/reminders.mjs';
import { DeliveryError, createReminderSender } from '../src/delivery.mjs';
import { Store } from '../src/store.mjs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { projectDir } from '../src/config.mjs';

const address = '+15550102026';
const origin = { lat: 32.78, lng: -96.8, label: 'Dallas, TX' };
const user = (overrides = {}) => ({ address, phone: address, channel: 'sms', active: 1, revision: 'r1', location_revision: 'location-1', location_lat: origin.lat, location_lng: origin.lng, location_label: origin.label, location_timezone: 'America/Chicago', location_saved_at: '2026-10-05T00:00:00Z', reminders_enabled: 1, ...overrides });
const show = (artist, date, locationQuery = 'Dallas TX', extra = {}) => ({ id: artist, artist, date, dateLabel: date, venue: 'Example Venue', locationQuery, locationSource: 'address', ticketUrl: 'https://example.com/tickets', ...extra });
const shows = [show('Friday artist', '2026-10-09'), show('Saturday artist', '2026-10-10'), show('Sunday artist', '2026-10-11'), show('Monday artist', '2026-10-12'), show('Next Friday', '2026-10-16')];
const geocoder = { resolve: async query => query === 'Far away' ? { lat: 40, lng: -100 } : origin };
const config = { mode: 'demo', radiusMiles: 80, remindersEnabled: true, reminderHour: 22, reminderGraceMinutes: 10, reminderSendEmpty: false };

class TestStore {
  constructor(users = [user()]) { this.users = new Map(users.map(item => [item.address, item])); this.jobs = new Map(); }
  get(address) { return this.users.get(address); }
  listReminderUsers() { return [...this.users.values()].map(item => ({ ...item })); }
  hasReminder(address, day) { return this.jobs.has(`${address}/${day}`); }
  claimReminder(address, day, revision, now, locationRevision) {
    const key = `${address}/${day}`;
    const current = this.get(address);
    if (this.jobs.has(key) || !current?.active || current.revision !== revision || current.location_revision !== locationRevision) return false;
    this.jobs.set(key, { address, day, revision, now: now.toISOString(), status: 'pending' });
    return true;
  }
  completeReminder(address, day, status, providerSid, errorCode, revision) {
    const job = this.jobs.get(`${address}/${day}`);
    if (job && job.revision === revision) Object.assign(job, { status, providerSid, errorCode });
  }
  stop(address) { const current = this.get(address); if (current) this.users.set(address, { ...current, active: 0, reminders_enabled: 0, revision: 'stopped' }); }
  forget(address) { this.users.delete(address); for (const [key, job] of this.jobs) if (job.address === address) this.jobs.delete(key); }
}

function setup(overrides = {}) {
  const store = overrides.store || new TestStore();
  const sent = [];
  let loads = 0;
  const source = { load: async () => { loads++; return { shows }; } };
  const sender = { send: async request => { sent.push(request); return { sid: 'preview-1', status: 'preview', outcome: 'accepted' }; } };
  return { store, sent, loadCount: () => loads, options: { store, source, sender, geocoder, config, now: new Date('2026-10-06T03:00:00Z'), ...overrides } };
}

test('weekend selection handles local dates, current weekend, next policy, year boundaries, and leap years', () => {
  for (const [day, start, end] of [
    ['2026-10-05', '2026-10-09', '2026-10-11'], ['2026-10-09', '2026-10-09', '2026-10-11'],
    ['2026-10-10', '2026-10-09', '2026-10-11'], ['2026-10-11', '2026-10-09', '2026-10-11'],
    ['2026-12-31', '2027-01-01', '2027-01-03'], ['2024-02-29', '2024-03-01', '2024-03-03'],
  ]) assert.deepEqual(weekendWindow(day), { localDate: day, start, end });
  assert.equal(weekendWindow('2026-10-10', 'America/Chicago', 'next').start, '2026-10-16');
  assert.equal(weekendWindow('2026-10-11', 'America/Chicago', 'next').start, '2026-10-16');
  assert.equal(weekendWindow(new Date('2026-10-12T03:00:00Z'), 'America/Chicago').localDate, '2026-10-11');
});

test('weekend search excludes earlier days and out-of-radius shows while preserving City fallback', async () => {
  const result = await findWeekendShows({
    shows: [...shows, show('Far away artist', '2026-10-11', 'Far away'), show('City artist', '2026-10-11', 'Dallas TX', { locationSource: 'city', city: 'Dallas, TX', locationApproximate: true }), show('Unknown artist', '2026-10-11', null)],
    origin, geocoder, now: '2026-10-10', radiusMiles: 80,
  });
  assert.deepEqual(result.matches.map(item => item.artist), ['Saturday artist', 'City artist', 'Sunday artist']);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.windowStart, '2026-10-09');
  assert.equal(result.windowEnd, '2026-10-11');
  assert.equal(result.matches.find(item => item.artist === 'City artist').locationApproximate, true);
});

test('a daily reminder saves one attempt and repeated timer ticks do not reload or resend', async () => {
  const app = setup();
  const result = await runDailyReminders(app.options);
  assert.equal(result.accepted, 1);
  assert.equal(app.sent.length, 1);
  assert.match(app.sent[0].body, /Friday artist/);
  assert.doesNotMatch(app.sent[0].body, /Monday artist|Next Friday/);
  assert.match(app.sent[0].body, /In a different town\? Send your location again to update it\. STOP to opt out\./);
  const repeated = await runDailyReminders({ ...app.options, now: new Date('2026-10-06T03:09:59Z') });
  assert.equal(repeated.accepted, 0);
  assert.equal(app.sent.length, 1);
  assert.equal(app.loadCount(), 1);
  assert.equal([...app.store.jobs.values()][0].day, '2026-10-05');
  await runDailyReminders({ ...app.options, now: new Date('2026-10-07T03:00:00Z') });
  assert.equal(app.sent.length, 2);
});

test('local 10 PM respects each user time zone and DST rather than server time', async () => {
  const chicago = user();
  const vegas = user({ address: 'whatsapp:+15550102027', phone: '+15550102027', channel: 'whatsapp', location_timezone: 'America/Los_Angeles' });
  const app = setup({ store: new TestStore([chicago, vegas]) });
  await runDailyReminders(app.options);
  assert.deepEqual(app.sent.map(item => item.user.address), [chicago.address]);
  await runDailyReminders({ ...app.options, now: new Date('2026-10-06T05:00:00Z') });
  assert.deepEqual(app.sent.map(item => item.user.address), [chicago.address, vegas.address]);
  const winter = setup({ source: { load: async () => ({ shows: [show('Winter Friday', '2026-11-06')] }) }, now: new Date('2026-11-03T04:00:00Z') });
  assert.equal((await runDailyReminders(winter.options)).accepted, 1);
  assert.equal([...winter.store.jobs.values()][0].day, '2026-11-02');
  const summer = setup({ source: { load: async () => ({ shows: [show('Spring Friday', '2026-03-13')] }) }, now: new Date('2026-03-10T03:00:00Z') });
  assert.equal((await runDailyReminders(summer.options)).accepted, 1);
});

test('only enabled valid locations in the grace interval trigger work, and source loads once per run', async () => {
  const users = [
    user(), user({ address: '+15550102027', phone: '+15550102027' }),
    user({ address: '+15550102028', active: 0 }), user({ address: '+15550102029', reminders_enabled: 0 }),
    user({ address: '+15550102030', location_lat: null }), user({ address: '+15550102031', location_timezone: '' }),
    user({ address: '+15550102032', location_timezone: 'invalid/timezone' }),
  ];
  const app = setup({ store: new TestStore(users) });
  const result = await runDailyReminders(app.options);
  assert.equal(result.accepted, 2);
  assert.equal(result.errors, 1);
  assert.equal(app.loadCount(), 1);
  for (const instant of ['2026-10-06T02:59:59Z', '2026-10-06T03:10:00Z', '2026-10-06T05:00:00Z']) {
    const outside = setup({ now: new Date(instant) });
    assert.equal((await runDailyReminders(outside.options)).accepted, 0);
    assert.equal(outside.loadCount(), 0);
  }
});

test('no-shows default stays quiet, optional empty reminder asks for updated location', async () => {
  const app = setup({ source: { load: async () => ({ shows: [] }) } });
  assert.equal((await runDailyReminders(app.options)).noShows, 1);
  assert.equal(app.sent.length, 0);
  assert.equal(app.store.jobs.size, 0);
  const changed = await runDailyReminders({ ...app.options, config: { ...config, reminderSendEmpty: true } });
  assert.equal(changed.accepted, 1);
  assert.match(app.sent[0].body, /No upcoming weekend shows/);
  assert.match(app.sent[0].body, /different town/);
});

test('STOP, DELETE, and a location change during an asynchronous lookup prevent sending', async () => {
  for (const action of ['STOP', 'DELETE', 'UPDATE']) {
    let release, reached;
    const started = new Promise(resolve => reached = resolve);
    const wait = new Promise(resolve => release = resolve);
    const app = setup({ source: { load: async () => { reached(); await wait; return { shows }; } } });
    const running = runDailyReminders(app.options);
    await started;
    if (action === 'STOP') app.store.stop(address);
    else if (action === 'DELETE') app.store.forget(address);
    else app.store.users.set(address, user({ location_revision: 'new-location', location_label: 'New town' }));
    release();
    assert.equal((await running).accepted, 0);
    assert.equal(app.sent.length, 0);
    assert.equal(app.store.jobs.size, 0);
  }
});

test('uncertain and explicitly failed deliveries consume the attempt without retrying or leaking errors', async () => {
  for (const outcome of ['failed', 'unknown']) {
    let calls = 0;
    const app = setup({ sender: { send: async () => { calls++; throw new DeliveryError('TEST_FAILURE', 'private provider detail', outcome); } } });
    const result = await runDailyReminders(app.options);
    assert.equal(result[outcome], 1);
    assert.equal([...app.store.jobs.values()][0].status, outcome);
    assert.equal([...app.store.jobs.values()][0].errorCode, 'TEST_FAILURE');
    await runDailyReminders(app.options);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /15550102026|private provider detail/);
  }
});

test('DELETE during an in-flight delivery does not restore erased delivery records', async () => {
  let release, reached;
  const started = new Promise(resolve => reached = resolve);
  const wait = new Promise(resolve => release = resolve);
  const app = setup({ sender: { send: async () => { reached(); await wait; return { sid: 'provider-accepted', outcome: 'accepted' }; } } });
  const pending = runDailyReminders(app.options);
  await started;
  app.store.forget(address);
  release();
  await pending;
  assert.equal(app.store.users.size, 0);
  assert.equal(app.store.jobs.size, 0);
});

test('an outage does not send partial results or claim a reminder, and an abort stops the run', async () => {
  const outage = setup({ geocoder: { resolve: async () => { throw new Error('maps offline'); } } });
  assert.equal((await runDailyReminders(outage.options)).errors, 1);
  assert.equal(outage.sent.length, 0);
  assert.equal(outage.store.jobs.size, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runDailyReminders({ ...setup().options, signal: controller.signal }), { name: 'AbortError' });
});

test('long weekend reminders stay bounded, keep complete event blocks, and point to WEEKEND', () => {
  const found = { matches: Array.from({ length: 20 }, (_, index) => show(`Artist ${index} ${'a'.repeat(120)}`, '2026-10-09', 'Dallas TX', { venue: 'v'.repeat(150), ticketUrl: `https://example.com/${'t'.repeat(250)}`, locationSource: 'city', city: 'Dallas, TX' })), windowStart: '2026-10-09', windowEnd: '2026-10-11', excludedCount: 2 };
  const result = buildReminder({ user: user(), found, radiusMiles: 80 });
  assert.ok(result.body.length <= 1400);
  assert.match(result.body, /Reply WEEKEND for the full list/);
  assert.match(result.body, /city approximation/);
  assert.ok(result.contentVariables['3'].length <= 900);
  assert.ok(Object.values(result.contentVariables).every(value => !/[\n\r\t]/.test(value)));
  assert.match(result.contentVariables['3'], /Reply WEEKEND/);
  assert.match(result.body, /different town/);
});

test('SQLite delivery claims survive a process restart, and STOP/DELETE retain their effects', async () => {
  const workRoot = path.resolve(projectDir, 'work');
  mkdirSync(workRoot, { recursive: true });
  const directory = mkdtempSync(path.join(workRoot, 'reminder-test-'));
  const databasePath = path.join(directory, 'reminders.sqlite');
  let store = new Store(databasePath);
  try {
    const registered = store.register(address);
    store.saveLocation(address, origin, 'America/Chicago', registered.revision);
    const options = { store, source: { load: async () => ({ shows }) }, geocoder, config, now: new Date('2026-10-06T03:00:00Z'), sender: createReminderSender(config, { store }) };
    assert.equal((await runDailyReminders(options)).accepted, 1);
    assert.equal(store.demoNotifications(address).length, 1);
    store.close();
    store = new Store(databasePath);
    const restarted = { ...options, store, sender: createReminderSender(config, { store }) };
    assert.equal((await runDailyReminders(restarted)).accepted, 0);
    assert.equal(store.demoNotifications(address).length, 1);
    store.stop(address);
    assert.equal((await runDailyReminders({ ...restarted, now: new Date('2026-10-07T03:00:00Z') })).accepted, 0);
    assert.equal(store.get(address).location_label, 'Dallas, TX');
    store.forget(address);
    store.completeReminder(address, '2026-10-05', 'accepted', 'late-provider-reference');
    assert.equal(store.get(address), undefined);
    assert.equal(store.hasReminder(address, '2026-10-05'), false);
    assert.equal(store.demoNotifications(address).length, 0);
  } finally {
    store.close();
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(`${workRoot}${path.sep}`)) throw new Error('Unexpected test cleanup path');
    rmSync(resolved, { recursive: true });
  }
});

test('SQLite location revision prevents stale reminders after a saved-town update', async () => {
  const store = new Store(':memory:');
  let release, reached;
  const started = new Promise(resolve => reached = resolve);
  const wait = new Promise(resolve => release = resolve);
  try {
    const registered = store.register(address);
    const first = store.saveLocation(address, origin, 'America/Chicago', registered.revision);
    const app = setup({ store, source: { load: async () => { reached(); await wait; return { shows }; } } });
    const running = runDailyReminders(app.options);
    await started;
    const updated = store.saveLocation(address, { ...origin, label: 'Fort Worth, TX', lng: -97.33 }, 'America/Chicago', registered.revision);
    assert.equal(updated.revision, first.revision);
    assert.notEqual(updated.location_revision, first.location_revision);
    release();
    assert.equal((await running).accepted, 0);
    assert.equal(app.sent.length, 0);
    assert.equal(store.hasReminder(address, '2026-10-05'), false);
    assert.equal(store.claimReminder(address, '2026-10-05', first.revision, app.options.now, first.location_revision), false);
  } finally { store.close(); }
});

test('a late provider response after DELETE and re-registration cannot overwrite a new SQLite attempt', async () => {
  const store = new Store(':memory:');
  let release, reached, calls = 0;
  const started = new Promise(resolve => reached = resolve);
  const wait = new Promise(resolve => release = resolve);
  try {
    const first = store.register(address);
    store.saveLocation(address, origin, 'America/Chicago', first.revision);
    const app = setup({ store, sender: { send: async () => {
      calls++;
      if (calls === 1) { reached(); await wait; return { sid: 'old-provider-sid', outcome: 'accepted' }; }
      return { sid: 'new-provider-sid', outcome: 'accepted' };
    } } });
    const oldAttempt = runDailyReminders(app.options);
    await started;
    store.forget(address);
    const newRegistration = store.register(address);
    store.saveLocation(address, origin, 'America/Chicago', newRegistration.revision);
    assert.equal((await runDailyReminders(app.options)).accepted, 1);
    release();
    await oldAttempt;
    const record = store.db.prepare('SELECT revision,provider_sid FROM reminder_deliveries WHERE address=? AND local_date=?').get(address, '2026-10-05');
    assert.equal(record.revision, newRegistration.revision);
    assert.equal(record.provider_sid, 'new-provider-sid');
  } finally { store.close(); }
});
