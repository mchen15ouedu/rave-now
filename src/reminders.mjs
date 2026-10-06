import { findNearbyShows, calendarDate } from './shows.mjs';
import { groupEventResults } from './event-groups.mjs';

const DAY = 86_400_000;
const FOOTER = 'In a different town? Send your location again to update it. STOP to opt out.';
const tidy = (value, max = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const dateLabel = iso => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));

function addDays(iso, days) {
  return new Date(new Date(`${iso}T12:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
}

/** Friday-Sunday of the current weekend, or the next weekend on Monday-Thursday. */
export function weekendWindow(now = new Date(), timeZone = 'America/Chicago', policy = 'current') {
  const localDate = calendarDate(now, timeZone);
  const weekday = new Date(`${localDate}T12:00:00Z`).getUTCDay();
  if (!['current', 'next'].includes(policy)) throw new TypeError('Weekend policy must be current or next.');
  const daysToFriday = policy === 'next' && (weekday === 0 || weekday === 6)
    ? (5 - weekday + 7) % 7 : weekday === 0 ? -2 : 5 - weekday;
  const start = addDays(localDate, daysToFriday);
  return { localDate, start, end: addDays(start, 2) };
}

/** Reuses the same radius and Address/City rules as an inbound location search. */
export async function findWeekendShows({ shows, origin, geocoder, now = new Date(), timeZone = 'America/Chicago', radiusMiles = 80, weekendPolicy = 'current', signal }) {
  const window = weekendWindow(now, timeZone, weekendPolicy);
  const found = await findNearbyShows({
    shows: shows.filter(show => show.date >= window.localDate), origin, geocoder,
    now: window.start, timeZone, days: 3, radiusMiles, signal,
  });
  return { ...found, localDate: window.localDate };
}

/** A bounded SMS body and single-line variables for a pre-approved WhatsApp template. */
export function buildReminder({ user, found, radiusMiles = 80 }) {
  const results = groupEventResults(found.matches);
  const location = tidy(user.location_label || found.locationLabel || 'your saved location', 120);
  const range = `${dateLabel(found.windowStart)} - ${dateLabel(found.windowEnd)}`;
  const heading = `${results.length ? `${results.length} upcoming weekend show${results.length === 1 ? '' : 's'}` : 'No upcoming weekend shows'} near ${location}\n${range}; within ${radiusMiles} straight-line miles (approx. two-hour radius).`;
  const blocks = results.map(show => [
    `${tidy(show.artist, 100)} | ${tidy(show.dateLabel || show.date, 60)}`,
    `${tidy(show.venue, 80) || 'Venue not announced'} | ${tidy(show.locationQuery || show.city, 120)}${show.locationSource === 'city' ? ' (city approximation)' : ''}`,
    show.ticketUrl ? `Tickets: ${tidy(show.ticketUrl, 200)}` : 'Ticket link not listed.',
  ].join('\n'));
  let body = heading;
  let index = 0;
  for (const block of blocks) {
    const next = `${body}\n\n${block}`;
    // Always reserve room for the location question and the full-list command.
    if (next.length + FOOTER.length + 65 > 1400) break;
    body = next;
    index++;
  }
  if (index < blocks.length) body += `\n\n${blocks.length - index} more show${blocks.length - index === 1 ? '' : 's'}. Reply WEEKEND for the full list.`;
  if (found.excludedCount && body.length + FOOTER.length + 90 <= 1400) body += `\n${found.excludedCount} tracker show${found.excludedCount === 1 ? '' : 's'} could not be located.`;
  body += `\n\n${FOOTER}`;

  // Template variables cannot contain newlines. Avoid a clipped URL or show by
  // adding only complete compact event descriptions that fit the variable budget.
  const compact = results.map(show => `${tidy(show.artist, 90)} (${tidy(show.dateLabel || show.date, 50)}), ${tidy(show.venue, 65) || 'venue TBA'}${show.locationSource === 'city' ? `, ${tidy(show.city, 65)} (city approximation)` : ''}`);
  let events = '';
  let included = 0;
  for (const item of compact) {
    const next = events ? `${events}; ${item}` : item;
    if (next.length + 70 > 900) break;
    events = next;
    included++;
  }
  if (included < compact.length) events += `${events ? '; ' : ''}${compact.length - included} more. Reply WEEKEND for the full list.`;
  if (!compact.length) events = 'No nearby shows are currently listed for this weekend.';
  return { body, contentVariables: { '1': location, '2': range, '3': events }, matchesCount: results.length };
}

function localTime(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour), minute: Number(values.minute) };
}

function eligible(user) {
  return Boolean(user?.active && user.reminders_enabled && user.location_saved_at && user.location_timezone &&
    Number.isFinite(user.location_lat) && Number.isFinite(user.location_lng) && Math.abs(user.location_lat) <= 90 && Math.abs(user.location_lng) <= 180);
}

/** One durable attempt per channel/user/local day; never retry uncertain deliveries. */
export async function runDailyReminders({ store, source, geocoder, sender, config, now = new Date(), signal }) {
  const metrics = { considered: 0, due: 0, accepted: 0, failed: 0, unknown: 0, noShows: 0, skipped: 0, errors: 0 };
  if (config.remindersEnabled === false) return metrics;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Reminder scheduling requires a valid instant.');
  signal?.throwIfAborted();
  const hour = config.reminderHour ?? 22;
  const graceMinutes = config.reminderGraceMinutes ?? 10;
  let snapshotPromise;
  for (const candidate of store.listReminderUsers()) {
    signal?.throwIfAborted();
    metrics.considered++;
    if (!eligible(candidate)) { metrics.skipped++; continue; }
    let local;
    try { local = localTime(now, candidate.location_timezone); }
    catch { metrics.errors++; continue; }
    if (local.hour !== hour || local.minute >= graceMinutes) { metrics.skipped++; continue; }
    metrics.due++;
    if (store.hasReminder?.(candidate.address, local.date)) { metrics.skipped++; continue; }
    const currentUser = () => {
      const user = store.get(candidate.address);
      return eligible(user) && user.revision === candidate.revision && user.location_revision === candidate.location_revision ? user : null;
    };
    if (!currentUser()) { metrics.skipped++; continue; }
    let found;
    try {
      snapshotPromise ??= source.load({ signal });
      const snapshot = await snapshotPromise;
      if (!currentUser()) { metrics.skipped++; continue; }
      found = await findWeekendShows({
        shows: snapshot.shows, origin: { lat: candidate.location_lat, lng: candidate.location_lng, label: candidate.location_label },
        geocoder, now, timeZone: candidate.location_timezone, radiusMiles: config.radiusMiles, weekendPolicy: config.reminderWeekendPolicy, signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      metrics.errors++;
      continue;
    }
    const user = currentUser();
    if (!user) { metrics.skipped++; continue; }
    if (!found.matches.length && !config.reminderSendEmpty) { metrics.noShows++; continue; }
    signal?.throwIfAborted();
    if (!store.claimReminder(user.address, local.date, user.revision, now, user.location_revision)) { metrics.skipped++; continue; }
    // No await between this last eligibility check and invoking the sender.
    if (!currentUser()) {
      store.completeReminder(user.address, local.date, 'cancelled', null, 'USER_CHANGED', user.revision);
      metrics.skipped++;
      continue;
    }
    try {
      const message = buildReminder({ user, found, radiusMiles: config.radiusMiles });
      const result = await sender.send({ user, message, body: message.body, now });
      const status = result?.outcome === 'failed' ? 'failed' : result?.outcome === 'unknown' ? 'unknown' : 'accepted';
      store.completeReminder(user.address, local.date, status, result?.sid ?? null, result?.errorCode ?? null, user.revision);
      metrics[status]++;
    } catch (error) {
      const status = error?.outcome === 'failed' ? 'failed' : 'unknown';
      store.completeReminder(user.address, local.date, status, null, String(error?.code ?? 'DELIVERY_UNKNOWN').slice(0, 80), user.revision);
      metrics[status]++;
    }
  }
  return metrics;
}
