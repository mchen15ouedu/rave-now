import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleTimeZoneProvider, DemoTimeZoneProvider } from '../src/timezones.mjs';

const point = { lat: 32.78, lng: -96.8 };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, json: async () => body });
const result = { status: 'OK', timeZoneId: 'America/Chicago', rawOffset: -21600, dstOffset: 3600 };

test('Google time zone lookup sends UTC seconds, coordinates, and signal then returns the named zone', async () => {
  const controller = new AbortController();
  const provider = new GoogleTimeZoneProvider({
    apiKey: 'test-key',
    fetchImpl: async (url, { signal }) => {
      assert.equal(url.origin + url.pathname, 'https://maps.googleapis.com/maps/api/timezone/json');
      assert.equal(url.searchParams.get('location'), '32.78,-96.8');
      assert.equal(url.searchParams.get('timestamp'), '1791255600');
      assert.equal(url.searchParams.get('key'), 'test-key');
      assert.equal(signal, controller.signal);
      return response(result);
    },
  });
  assert.equal(await provider.resolve(point, { signal: controller.signal, at: new Date('2026-10-06T03:00:00.999Z') }), 'America/Chicago');
});

test('time zone lookup uses the injected clock and supports a valid UTC zone', async () => {
  const provider = new GoogleTimeZoneProvider({ apiKey: 'test-key', clock: () => 1000500, fetchImpl: async (url) => {
    assert.equal(url.searchParams.get('timestamp'), '1000');
    return response({ status: 'OK', timeZoneId: 'UTC' });
  } });
  assert.equal(await provider.resolve({ lat: 0, lng: 0 }), 'UTC');
});

test('invalid coordinates and timestamps fail before an external request', async () => {
  const provider = new GoogleTimeZoneProvider({ apiKey: 'test-key', fetchImpl: async () => assert.fail('Must not fetch') });
  for (const invalid of [null, {}, { lat: 91, lng: 0 }, { lat: 0, lng: -181 }, { lat: NaN, lng: 0 }, { lat: '32.78', lng: -96.8 }]) {
    await assert.rejects(provider.resolve(invalid), { code: 'INVALID_LOCATION' });
  }
  for (const at of [new Date('invalid'), Infinity, Number.MAX_SAFE_INTEGER, '2026-10-06', null]) {
    await assert.rejects(provider.resolve(point, { at }), { code: 'INVALID_TIME' });
  }
});

test('quota, HTTP, missing key, malformed bodies, and network errors remain visible outages', async () => {
  const fetches = [
    async () => response({ status: 'OVER_QUERY_LIMIT', errorMessage: 'Sensitive detail' }),
    async () => response({ status: 'REQUEST_DENIED' }),
    async () => response({}, 503),
    async () => response(null),
    async () => response({ status: 'OK', timeZoneId: 'Mars/Olympus' }),
    async () => response({ status: 'OK', timeZoneId: '+05:00' }),
    async () => response({ status: 'OK', timeZoneId: ' America/Chicago ' }),
    async () => { throw new Error('Network offline'); },
    async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } }),
  ];
  for (const fetchImpl of fetches) {
    const provider = new GoogleTimeZoneProvider({ apiKey: 'test-key', fetchImpl });
    await assert.rejects(provider.resolve(point), { name: 'TimeZoneError', code: 'UNAVAILABLE', message: 'Time zone lookup is temporarily unavailable. Please try updating your location later.' });
  }
  await assert.rejects(new GoogleTimeZoneProvider().resolve(point), { code: 'UNAVAILABLE' });
});

test('unresolved water or land locations request a more useful location', async () => {
  const provider = new GoogleTimeZoneProvider({ apiKey: 'test-key', fetchImpl: async () => response({ status: 'ZERO_RESULTS' }) });
  await assert.rejects(provider.resolve({ lat: 0, lng: -30 }), { code: 'NOT_FOUND' });
});

test('cancellation is preserved before fetch, during fetch, and during response parsing', async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const noFetch = new GoogleTimeZoneProvider({ apiKey: 'test-key', fetchImpl: async () => assert.fail('Must not fetch') });
  await assert.rejects(noFetch.resolve(point, { signal: alreadyAborted.signal }), { name: 'AbortError' });
  for (const parseAfterAbort of [false, true]) {
    const controller = new AbortController();
    const provider = new GoogleTimeZoneProvider({ apiKey: 'test-key', fetchImpl: async (_, { signal }) => {
      assert.equal(signal, controller.signal);
      if (!parseAfterAbort) {
        controller.abort();
        signal.throwIfAborted();
      }
      return { ok: true, json: async () => { controller.abort(); return result; } };
    } });
    await assert.rejects(provider.resolve(point, { signal: controller.signal }), { name: 'AbortError' });
  }
});

test('demo zones cover supported fixtures and nearby pins while rejecting unsupported geography', async () => {
  const provider = new DemoTimeZoneProvider();
  for (const [lat, lng] of [[32.78, -96.8], [32.75, -97.33], [30.27, -97.74], [29.76, -95.37], [41.88, -87.63], [32.79, -96.82]]) {
    assert.equal(await provider.resolve({ lat, lng }), 'America/Chicago');
  }
  for (const [lat, lng] of [[36.17, -115.14], [36.13, -115.16], [34.05, -118.24]]) {
    assert.equal(await provider.resolve({ lat, lng }), 'America/Los_Angeles');
  }
  for (const unsupported of [{ lat: 40.71, lng: -74.01 }, { lat: 0, lng: 0 }, { lat: 37, lng: -100 }]) {
    await assert.rejects(provider.resolve(unsupported), { code: 'NOT_FOUND' });
  }
  await assert.rejects(provider.resolve({ lat: 100, lng: 0 }), { code: 'INVALID_LOCATION' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.resolve(point, { signal: controller.signal }), { name: 'AbortError' });
});
