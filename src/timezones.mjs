import { haversineMiles } from './shows.mjs';

export class TimeZoneError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'TimeZoneError';
    this.code = code;
  }
}

function validatePoint(point) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)
    || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
    throw new TimeZoneError('INVALID_LOCATION', 'Please send a valid city, ZIP code, or shared location.');
  }
}

function unavailable(cause) {
  throw new TimeZoneError('UNAVAILABLE', 'Time zone lookup is temporarily unavailable. Please try updating your location later.', { cause });
}

function validTimeZone(value) {
  // Reject numeric offsets, even on runtimes that support them: saved schedules need named zones for DST.
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value) || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Resolves coordinates to a named zone. `at` and `clock()` use Dates or epoch milliseconds. */
export class GoogleTimeZoneProvider {
  constructor({ apiKey, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
  }

  async resolve(point, { signal, at = this.clock() } = {}) {
    signal?.throwIfAborted();
    validatePoint(point);
    const milliseconds = at instanceof Date ? at.getTime() : at;
    if (!Number.isFinite(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())
      || !Number.isSafeInteger(Math.floor(milliseconds / 1000))) {
      throw new TimeZoneError('INVALID_TIME', 'A valid timestamp is required for time zone lookup.');
    }
    if (!this.apiKey) unavailable();
    const url = new URL('https://maps.googleapis.com/maps/api/timezone/json');
    url.searchParams.set('location', `${point.lat},${point.lng}`);
    url.searchParams.set('timestamp', String(Math.floor(milliseconds / 1000)));
    url.searchParams.set('key', this.apiKey);
    let body;
    try {
      const response = await this.fetchImpl(url, { signal });
      if (!response.ok) unavailable();
      body = await response.json();
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      if (error instanceof TimeZoneError) throw error;
      unavailable(error);
    }
    signal?.throwIfAborted();
    if (body?.status === 'ZERO_RESULTS') {
      throw new TimeZoneError('NOT_FOUND', 'I could not determine the time zone for that location. Please send a town or a location on land.');
    }
    if (body?.status !== 'OK' || !validTimeZone(body.timeZoneId)) unavailable();
    // Persist the named zone, not today's rawOffset/dstOffset, so the scheduler follows future DST changes.
    return body.timeZoneId;
  }
}

const DEMO_ZONES = [
  [32.78, -96.8, 'America/Chicago'], // Dallas
  [32.75, -97.33, 'America/Chicago'], // Fort Worth
  [30.27, -97.74, 'America/Chicago'], // Austin
  [29.76, -95.37, 'America/Chicago'], // Houston
  [41.88, -87.63, 'America/Chicago'], // Chicago
  [36.17, -115.14, 'America/Los_Angeles'], // Las Vegas
  [34.05, -118.24, 'America/Los_Angeles'], // Los Angeles
];

/** Fixture-only lookup; pins must be within 25 miles of a supported demo city. */
export class DemoTimeZoneProvider {
  async resolve(point, { signal } = {}) {
    signal?.throwIfAborted();
    validatePoint(point);
    const nearby = DEMO_ZONES
      .map(([lat, lng, timeZone]) => ({ timeZone, distance: haversineMiles(point, { lat, lng }) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!nearby || nearby.distance > 25) {
      throw new TimeZoneError('NOT_FOUND', 'Demo reminders support locations near Dallas TX, Fort Worth TX, Austin TX, Houston TX, Chicago IL, Las Vegas NV, or Los Angeles CA.');
    }
    return nearby.timeZone;
  }
}
