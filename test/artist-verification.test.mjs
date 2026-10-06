import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtistVerifier, createMusicBrainzScheduler } from '../src/artist-verification.mjs';
import { normalizeArtistName } from '../src/artist-catalog.mjs';

const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const creditId = '00000000-0000-4000-8000-000000000003';
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const instant = async operation => operation();
const search = (artists, count = artists.length) => ({ count, offset: 0, artists });
const candidate = (name = 'Sample Néon', id = firstId) => ({ id, name, type: 'Person', score: 100 });
const details = overrides => ({
  ...candidate(), recordings: [], releases: [],
  'release-groups': [{ id: creditId, title: 'Sample Nightfall EP', 'primary-type': 'EP', 'secondary-types': [] }],
  ...overrides,
});
function mockVerifier({ searchResult = search([candidate()]), lookup = details(), ...options } = {}) {
  const calls = [];
  const verifier = createArtistVerifier({ scheduler: instant, ...options, fetchImpl: async (url, request) => {
    calls.push({ url: new URL(url), request });
    return json(new URL(url).pathname === '/ws/2/artist/' ? searchResult : lookup);
  } });
  return { verifier, calls };
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('verification requires an exact normalized canonical name plus real music credits', async () => {
  const { verifier, calls } = mockVerifier();
  const result = await verifier.verify('  SAMPLE   neon  ');
  assert.deepEqual(result, { status: 'verified', name: 'Sample Néon', source: 'MusicBrainz', sourceUrl: `https://musicbrainz.org/artist/${firstId}` });
  assert.equal(normalizeArtistName(result.name), normalizeArtistName('SAMPLE neon'));
  assert.equal(calls.length, 2);
  for (const { url, request } of calls) {
    assert.equal(url.origin, 'https://musicbrainz.org');
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    assert.match(request.headers['User-Agent'], /^RaveNow\/0\.1 \(https:\/\/github\.com\//);
    assert.equal(request.headers.Authorization, undefined);
  }
  assert.equal(calls[0].url.searchParams.get('limit'), '100');
  assert.equal(calls[1].url.searchParams.get('inc'), 'recordings+releases+release-groups');
});

test('literal names escape Lucene operators separately from safe URL encoding', async () => {
  const name = 'Sample DJ "Q" / A+B:mix';
  const { verifier, calls } = mockVerifier({ searchResult: search([]) });
  assert.equal((await verifier.verify(name)).status, 'unverified');
  assert.equal(calls[0].url.searchParams.get('query'), 'artist:"Sample DJ \\"Q\\" \\/ A\\+B\\:mix"');
  assert.equal(calls[0].url.searchParams.get('fmt'), 'json');
});

test('fuzzy scores, alias matches and multiple exact artists cannot authorize an addition', async () => {
  const cases = [
    search([{ ...candidate('Sample Neon Extended'), aliases: [{ name: 'Sample Neon' }] }]),
    search([candidate(), candidate('SAMPLE neon', secondId)]),
    search([candidate()], 101),
  ];
  for (const searchResult of cases) {
    const { verifier, calls } = mockVerifier({ searchResult });
    assert.equal((await verifier.verify('Sample Neon')).status, 'unverified');
    assert.equal(calls.length, 1);
  }
});

test('a detail lookup cannot silently rename the requested artist', async () => {
  const { verifier } = mockVerifier({ lookup: details({ name: 'Sample Neon Collective' }) });
  const result = await verifier.verify('Sample Neon');
  assert.equal(result.status, 'unverified');
  assert.equal(result.name, undefined);
});

test('artist existence, DJ descriptions and tags alone are insufficient', async () => {
  const { verifier } = mockVerifier({ lookup: details({
    'release-groups': [], disambiguation: 'international DJ and electronic producer',
    tags: [{ name: 'dance', count: 20 }],
  }) });
  assert.equal((await verifier.verify('Sample Neon')).status, 'unverified');
});

test('titled recording and release credits are valid evidence, while fictional characters are rejected', async () => {
  for (const lookup of [
    details({ 'release-groups': [], recordings: [{ id: creditId, title: 'Sample Song' }] }),
    details({ 'release-groups': [], releases: [{ id: creditId, title: 'Sample Single' }] }),
  ]) {
    const { verifier } = mockVerifier({ lookup });
    assert.equal((await verifier.verify('Sample Neon')).status, 'verified');
  }
  const { verifier } = mockVerifier({ lookup: details({ type: 'Character' }) });
  assert.equal((await verifier.verify('Sample Neon')).status, 'unverified');
});

test('an exclusively nonmusic discography cannot qualify through recordings or untyped releases', async () => {
  for (const type of ['Spokenword', 'Audiobook', 'Interview', 'Audio drama', 'Field recording']) {
    const { verifier } = mockVerifier({ lookup: details({
      recordings: [{ id: creditId, title: 'Sample narration' }],
      releases: [{ id: creditId, title: 'Sample book' }],
      'release-groups': [{ id: creditId, title: 'Sample spoken collection', 'secondary-types': [type] }],
    }) });
    assert.equal((await verifier.verify('Sample Neon')).status, 'unverified');
  }
});

test('upstream outages, redirects and malformed responses are unavailable, never cached as a negative', async () => {
  for (const response of [
    () => new Response('private upstream detail', { status: 503 }),
    () => new Response('', { status: 302, headers: { Location: 'https://other.example/' } }),
    () => json({ artists: [] }),
    () => json(search([{ ...candidate(), id: '../../other' }])),
    () => new Response('not JSON'),
  ]) {
    let calls = 0;
    const verifier = createArtistVerifier({ scheduler: instant, fetchImpl: async () => { calls++; return response(); } });
    assert.deepEqual(await verifier.verify('Sample Neon'), { status: 'unavailable', source: 'MusicBrainz' });
    assert.equal((await verifier.verify('Sample Neon')).status, 'unavailable');
    assert.equal(calls, 2);
  }
});

test('both advertised and streamed oversized provider responses are rejected', async () => {
  for (const response of [
    () => new Response('{}', { headers: { 'Content-Length': String(512 * 1024 + 1) } }),
    () => new Response(JSON.stringify({ padding: 'x'.repeat(512 * 1024 + 1) })),
  ]) {
    const verifier = createArtistVerifier({ scheduler: instant, fetchImpl: async () => response() });
    assert.equal((await verifier.verify('Sample Neon')).status, 'unavailable');
  }
});

test('normalized duplicate requests share verification and canceling one visitor preserves the next', async () => {
  const pending = deferred(), started = deferred();
  let calls = 0, upstreamSignal;
  const verifier = createArtistVerifier({ scheduler: instant, fetchImpl: async (url, request) => {
    calls++; upstreamSignal = request.signal;
    if (calls === 1) { started.resolve(); return pending.promise; }
    return json(details());
  } });
  const visitor = new AbortController();
  const previous = verifier.verify('Sample Neon', { signal: visitor.signal });
  const cancelled = assert.rejects(previous, error => error.name === 'AbortError');
  await started.promise; visitor.abort(); await cancelled;
  const refresh = verifier.verify('SAMPLE néon');
  assert.equal(upstreamSignal.aborted, false);
  pending.resolve(json(search([candidate()])));
  assert.equal((await refresh).status, 'verified');
  assert.equal(calls, 2);
});

test('positive and negative cache entries expire separately and callers cannot mutate shared results', async () => {
  let time = 0, negative = true, calls = 0;
  const verifier = createArtistVerifier({ scheduler: instant, clock: () => time, fetchImpl: async url => {
    calls++;
    return json(new URL(url).pathname === '/ws/2/artist/' ? search(negative ? [] : [candidate()]) : details());
  } });
  assert.equal((await verifier.verify('Sample Neon')).status, 'unverified');
  time = 899_999;
  await verifier.verify('Sample Néon'); assert.equal(calls, 1);
  time = 900_000; negative = false;
  const positive = await verifier.verify('Sample Neon');
  assert.equal(positive.status, 'verified'); positive.name = 'Mutated';
  assert.equal((await verifier.verify('Sample Neon')).name, 'Sample Néon');
  assert.equal(calls, 3);
  time += 3_600_000;
  await verifier.verify('Sample Neon'); assert.equal(calls, 5);
});

test('the verification cache has a bounded capacity', async () => {
  let calls = 0;
  const verifier = createArtistVerifier({ scheduler: instant, maxCacheEntries: 2, fetchImpl: async () => { calls++; return json(search([])); } });
  for (const name of ['Sample One', 'Sample Two', 'Sample Three', 'Sample One']) await verifier.verify(name);
  assert.equal(calls, 4);
});

test('invalid input and canceled callers never start a verification request', async () => {
  let calls = 0;
  const verifier = createArtistVerifier({ scheduler: instant, fetchImpl: async () => { calls++; throw new Error(); } });
  for (const name of ['', 'x'.repeat(121), 'Sample\nDJ', null]) assert.equal((await verifier.verify(name)).status, 'unverified');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(verifier.verify('Sample Neon', { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(calls, 0);
});

test('unresponsive reads have a hard deadline and do not prevent later verification', async () => {
  let calls = 0, upstreamSignal;
  const verifier = createArtistVerifier({ scheduler: instant, timeoutMs: 60, requestTimeoutMs: 20, fetchImpl: async (url, request) => {
    calls++; upstreamSignal = request.signal;
    return calls === 1 ? new Promise(() => {}) : json(search([]));
  } });
  const started = performance.now();
  assert.equal((await verifier.verify('Sample Neon')).status, 'unavailable');
  assert.ok(performance.now() - started < 500);
  assert.equal(upstreamSignal.aborted, true);
  assert.equal((await verifier.verify('Sample Neon')).status, 'unverified');
  assert.equal(calls, 2);
});

test('MusicBrainz requests serialize and remain at least one second apart', async () => {
  let time = 0, running = 0;
  const waits = [], starts = [], pending = deferred();
  const scheduler = createMusicBrainzScheduler({ clock: () => time, sleep: async pause => { waits.push(pause); time += pause; } });
  const first = scheduler(async () => { running++; starts.push(time); await pending.promise; running--; });
  const second = scheduler(async () => { assert.equal(running, 0); starts.push(time); });
  await Promise.resolve();
  assert.deepEqual(starts, [0]);
  pending.resolve(); await Promise.all([first, second]);
  assert.deepEqual(starts, [0, 1000]);
  assert.deepEqual(waits, [1000]);
});

test('default production scheduling is shared across separate verifier instances', async () => {
  const starts = [];
  const fetchImpl = async () => { starts.push(performance.now()); return json(search([])); };
  await Promise.all([
    createArtistVerifier({ fetchImpl }).verify('Sample One'),
    createArtistVerifier({ fetchImpl }).verify('Sample Two'),
  ]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 990);
});
