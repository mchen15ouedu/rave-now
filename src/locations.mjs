export class LocationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'LocationError';
    this.code = code;
  }
}

function normalizeQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 300) {
    throw new LocationError('NOT_FOUND', 'Please send a city and state, ZIP code, or a shared location.');
  }
  return query.trim().replace(/\s+/g, ' ');
}

function throwUnavailable(cause) {
  throw new LocationError('UNAVAILABLE', 'Location lookup is temporarily unavailable. Please try again later.', { cause });
}

/** Ephemeral in-memory coordinates; no persistent storage of user locations. */
export class GoogleLocationProvider {
  constructor({ apiKey, fetchImpl = globalThis.fetch, ttlMs = 180000, clock = Date.now, maxCacheEntries = 250 } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.ttlMs = Math.min(Math.max(Number(ttlMs) || 0, 0), 300000);
    this.clock = clock;
    this.maxCacheEntries = Math.min(Math.max(Number(maxCacheEntries) || 1, 1), 1000);
    this.cache = new Map();
  }

  async resolve(query, { signal, cache = true } = {}) {
    signal?.throwIfAborted();
    const text = normalizeQuery(query);
    const key = text.toLowerCase();
    const cached = cache ? this.cache.get(key) : undefined;
    if (cached && cached.expiresAt > this.clock()) return { ...cached.point };
    if (cache) this.cache.delete(key);
    if (!this.apiKey) throwUnavailable();
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', text);
    url.searchParams.set('key', this.apiKey);
    let response;
    let body;
    try {
      response = await this.fetchImpl(url, { signal });
      if (!response.ok) throwUnavailable();
      body = await response.json();
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      if (error instanceof LocationError) throw error;
      throwUnavailable(error);
    }
    signal?.throwIfAborted();
    if (body.status === 'ZERO_RESULTS') throw new LocationError('NOT_FOUND', 'I could not find that location. Please send a city and state or ZIP code.');
    if (body.status !== 'OK' || !Array.isArray(body.results)) throwUnavailable();
    if (body.results.length !== 1 || body.results[0].partial_match) {
      throw new LocationError('AMBIGUOUS', 'That location is ambiguous. Please send a city and state, ZIP code, or a shared location.');
    }
    const result = body.results[0];
    // A state or country spans far more than the requested radius. Ask for a city, ZIP, or pin.
    const supportedTypes = new Set([
      'street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest',
      'locality', 'postal_code', 'postal_code_prefix', 'neighborhood', 'sublocality',
      'sublocality_level_1', 'sublocality_level_2', 'sublocality_level_3',
      'sublocality_level_4', 'sublocality_level_5',
    ]);
    if (!Array.isArray(result.types) || !result.types.some((type) => supportedTypes.has(type))) {
      throw new LocationError('AMBIGUOUS', 'Please send a city and state, ZIP code, full address, or a shared location instead of a broad region.');
    }
    const coordinates = result.geometry?.location;
    if (!coordinates || !Number.isFinite(coordinates.lat) || !Number.isFinite(coordinates.lng) || Math.abs(coordinates.lat) > 90 || Math.abs(coordinates.lng) > 180) throwUnavailable();
    const precise = result.types?.some((type) => ['street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest'].includes(type));
    const point = { lat: coordinates.lat, lng: coordinates.lng, label: result.formatted_address || text, approximate: !precise };
    for (const [cacheKey, value] of this.cache) if (value.expiresAt <= this.clock()) this.cache.delete(cacheKey);
    if (cache && this.ttlMs) {
      if (this.cache.size >= this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { point, expiresAt: this.clock() + this.ttlMs });
    }
    return { ...point };
  }
}

// These deliberately coarse fixture coordinates are for local demos only; they are not verified routes or geocodes.
const DEMO_POINTS = [
  ['Dallas TX', 'Dallas, TX', 32.78, -96.8],
  ['Fort Worth TX', 'Fort Worth, TX', 32.75, -97.33],
  ['Austin TX', 'Austin, TX', 30.27, -97.74],
  ['Las Vegas NV', 'Las Vegas, NV', 36.17, -115.14],
  ['Los Angeles CA', 'Los Angeles, CA', 34.05, -118.24],
  ['Los Angeles', 'Los Angeles, CA', 34.05, -118.24],
  ['Chicago IL', 'Chicago, IL', 41.88, -87.63],
  ['Houston TX', 'Houston, TX', 29.76, -95.37],
  ['100 Example Street Dallas TX 75201', '100 Example Street, Dallas, TX 75201 (demo coordinates)', 32.79, -96.82],
  ['3000 S Las Vegas Blvd Las Vegas NV', '3000 S Las Vegas Blvd, Las Vegas, NV (demo coordinates)', 36.13, -115.16],
];

function fixtureKey(query) {
  return query.toLowerCase().replace(/[,\.]/g, '').replace(/\s+/g, ' ').trim();
}

export class DemoLocationProvider {
  constructor() {
    this.points = new Map(DEMO_POINTS.map(([query, label, lat, lng]) => [fixtureKey(query), { lat, lng, label, approximate: true }]));
  }

  async resolve(query, { signal } = {}) {
    signal?.throwIfAborted();
    const point = this.points.get(fixtureKey(normalizeQuery(query)));
    if (!point) {
      throw new LocationError('NOT_FOUND', 'Demo locations: Dallas TX, Fort Worth TX, Austin TX, Las Vegas NV, Chicago IL, or Houston TX.');
    }
    return { ...point };
  }
}
