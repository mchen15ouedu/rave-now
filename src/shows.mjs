import { LocationError } from './locations.mjs';
import { usableEventName } from './event-groups.mjs';

const MONTHS = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2], ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4], ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['sept', 9], ['september', 9], ['oct', 10],
  ['october', 10], ['nov', 11], ['november', 11], ['dec', 12], ['december', 12],
]);

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function normalizedHeader(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isoDate(year, month, day) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 ||
      !Number.isInteger(day) || day < 1 || day > lengths[month - 1]) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Parse calendar dates explicitly: no timezone-dependent parsing of sheet text. */
export function parseShowDate(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 2958465) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
    return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()) : null;
  }
  let text = clean(value);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  text = text.replace(/^(?:Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)\s*,?\s+/i, '');
  const english = text.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s+(\d{4})(.*)$/i);
  if (!english) return null;
  // Optional displayed show time is retained in dateLabel, but the window uses the local calendar date.
  const tail = english[4].trim();
  if (tail && !/^(?:(?:[-–—@]|at)\s*)?\d{1,2}(?::\d{2})?\s*(?:[AP]M)?(?:\s+[A-Z]{2,5})?$/i.test(tail)) return null;
  const month = MONTHS.get(english[1].toLowerCase());
  return month ? isoDate(Number(english[3]), month, Number(english[2])) : null;
}

function usableLocation(value) {
  const text = clean(value);
  if (!text || /^(?:[-—–]|n\/?a|none|unknown)$/i.test(text)) return null;
  if (/\b(?:tba|tbd|to be (?:announced|determined)|secret|undisclosed)\b/i.test(text)) return null;
  return text;
}

function safeHttpUrl(value) {
  const text = clean(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Convert the actual tracker columns into show records. Invalid date rows are skipped with diagnostics. */
export function parseShows(rows) {
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) throw new TypeError('The tracker must contain a header row.');
  const headers = rows[0].map(normalizedHeader);
  const required = ['artist', 'location', 'address', 'ticketlink', 'showtime', 'youtubemostpopularsong'];
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`The tracker is missing required columns: ${missing.join(', ')}.`);
  const indexes = Object.fromEntries(required.map((header) => [header, headers.indexOf(header)]));
  // Optional while the tracker is being updated; locate by header so column insertion is safe.
  indexes.city = headers.indexOf('city');
  indexes.event = headers.indexOf('event');
  const shows = [];
  let invalidDates = 0;
  let missingArtists = 0;
  rows.slice(1).forEach((row, index) => {
    if (!Array.isArray(row) || row.every((cell) => clean(cell) === '')) return;
    const dateValue = row[indexes.showtime];
    const date = parseShowDate(dateValue);
    if (!date) {
      invalidDates += 1;
      return;
    }
    const sourceArtist = clean(row[indexes.artist]);
    const event = indexes.event >= 0 ? clean(row[indexes.event]) : '';
    const eventOnly = !sourceArtist && usableEventName(event);
    const artist = sourceArtist || eventOnly;
    if (!artist) {
      missingArtists += 1;
      return;
    }
    const address = clean(row[indexes.address]);
    const venue = clean(row[indexes.location]);
    const city = indexes.city >= 0 ? clean(row[indexes.city]) : '';
    const usableAddress = usableLocation(address);
    const usableCity = usableLocation(city);
    const locationQuery = usableAddress ?? usableCity;
    const locationSource = usableAddress ? 'address' : usableCity ? 'city' : null;
    const ticketUrl = safeHttpUrl(row[indexes.ticketlink]);
    shows.push({
      id: `tracker-row-${index + 2}`,
      artist,
      ...(indexes.event >= 0 ? { event } : {}),
      ...(eventOnly ? {
        type: 'event',
        entryCount: 0,
        dateEnd: date,
        ticketLinks: ticketUrl ? [{ url: ticketUrl, label: 'Tickets' }] : [],
      } : {}),
      venue,
      address,
      city,
      ticketUrl,
      youtubeUrl: eventOnly ? `https://www.youtube.com/results?search_query=${encodeURIComponent(artist)}` : safeHttpUrl(row[indexes.youtubemostpopularsong]),
      date,
      dateLabel: clean(dateValue),
      locationQuery,
      locationSource,
      locationApproximate: locationSource === 'city',
    });
  });
  const warnings = [];
  if (invalidDates) warnings.push(`Skipped ${invalidDates} tracker row(s) with missing, TBA, or invalid show dates.`);
  if (missingArtists) warnings.push(`Skipped ${missingArtists} tracker row(s) without an artist.`);
  Object.defineProperty(shows, 'warnings', { value: warnings, enumerable: false });
  return shows;
}

export function haversineMiles(a, b) {
  const radians = (number) => number * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function calendarDate(now = new Date(), timeZone = 'America/Chicago') {
  // An explicit YYYY-MM-DD is useful for deterministic demos and refers to a calendar day, not an instant.
  if (typeof now === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(now)) {
    if (!parseShowDate(now)) throw new TypeError('Invalid reference date.');
    return now;
  }
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('Invalid reference time.');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

/** All dated upcoming shows, soonest first, without a location or end-date filter. */
export function findFutureShows({ shows, now = new Date(), timeZone = 'America/Chicago', signal }) {
  if (!Array.isArray(shows)) throw new TypeError('shows must be an array.');
  signal?.throwIfAborted();
  const windowStart = calendarDate(now, timeZone);
  const matches = shows.filter(show => parseShowDate(show.date) && show.date >= windowStart);
  matches.sort((a,b) => a.date.localeCompare(b.date) || a.artist.localeCompare(b.artist) || a.id.localeCompare(b.id));
  return { matches, windowStart };
}

function addCalendarDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day + days);
  date.setUTCHours(0, 0, 0, 0);
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function validatePoint(point) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
    throw new LocationError('NOT_FOUND', 'Please send a city and state, ZIP code, or a shared location.');
  }
  return point;
}

/** Today plus the next six local calendar dates; the radius is an explicit straight-line approximation. */
export async function findNearbyShows({ shows, origin, geocoder, now = new Date(), timeZone = 'America/Chicago', days = 7, radiusMiles = 80, signal }) {
  if (!Array.isArray(shows)) throw new TypeError('shows must be an array.');
  if (!geocoder || typeof geocoder.resolve !== 'function') throw new TypeError('A location provider is required.');
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new TypeError('days must be between 1 and 366.');
  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) throw new TypeError('radiusMiles must be positive.');
  signal?.throwIfAborted();
  const point = validatePoint(typeof origin === 'string' ? await geocoder.resolve(origin, { signal, cache: false }) : origin);
  const windowStart = calendarDate(now, timeZone);
  const windowEnd = addCalendarDays(windowStart, days - 1);
  const matches = [];
  let excludedCount = 0;
  for (const show of shows) {
    signal?.throwIfAborted();
    if (!show.date || show.date < windowStart || show.date > windowEnd) continue;
    if (!show.locationQuery) {
      excludedCount += 1;
      continue;
    }
    let destination;
    try {
      destination = validatePoint(await geocoder.resolve(show.locationQuery, { signal }));
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      if (error instanceof LocationError && ['NOT_FOUND', 'AMBIGUOUS'].includes(error.code)) {
        excludedCount += 1;
        continue;
      }
      // Outages must be visible; returning partial results would look like an exhaustive search.
      throw error;
    }
    const distanceMiles = haversineMiles(point, destination);
    if (distanceMiles <= radiusMiles) matches.push({
      ...show,
      distanceMiles,
      locationApproximate: Boolean(show.locationApproximate || destination.approximate),
    });
  }
  matches.sort((a, b) => a.date.localeCompare(b.date) || a.distanceMiles - b.distanceMiles || a.artist.localeCompare(b.artist));
  return { matches, excludedCount, locationLabel: point.label || (typeof origin === 'string' ? origin : 'your shared location'), windowStart, windowEnd };
}
