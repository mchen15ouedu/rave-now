import { setTimeout as delay } from 'node:timers/promises';
import { isIP } from 'node:net';
import { cleanArtistName, normalizeArtistName, createReadCoalescer } from './artist-catalog.mjs';

const API = 'https://musicbrainz.org/ws/2/artist/';
const USER_AGENT = 'RaveNow/0.1 (https://github.com/mchen15ouedu/rave-now)';
const MAX_BYTES = 512 * 1024;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONMUSIC = new Set(['spokenword', 'interview', 'audiobook', 'audiodrama', 'fieldrecording']);
const PLACEHOLDERS = new Set(['various artists', '[unknown]', '[no artist]', '[anonymous]', 'unknown artist']);
const typeKey = value => String(value || '').toLowerCase().replace(/[^a-z]/g, '');
const HOMEPAGE_RELATION = 'fe33d22f-c3b0-4d68-bd53-a856badf2b15';
const failed = () => new Error('Artist verification is unavailable.');
const clamp = (value, fallback, maximum) => Math.min(maximum, Math.max(1, Number(value) || fallback));

/** All production verifier instances share this queue, including cache misses
 * for different names. MusicBrainz requires at most one request per second.
 * Clock/sleep injection lets tests check spacing without contacting the API. */
export function createMusicBrainzScheduler({ clock = Date.now, sleep = delay } = {}) {
  let tail = Promise.resolve(), pending = 0, lastStarted = -Infinity;
  return async (operation, { signal } = {}) => {
    signal?.throwIfAborted();
    if (pending >= 8) throw failed();
    pending++;
    const next = tail.then(async () => {
      signal?.throwIfAborted();
      const pause = Math.max(0, 1000 - (Number(clock()) - lastStarted));
      if (pause) await sleep(pause, undefined, { signal });
      signal?.throwIfAborted();
      lastStarted = Number(clock());
      return operation();
    });
    tail = next.catch(() => {});
    try { return await next; } finally { pending--; }
  };
}

const globalRequests = createMusicBrainzScheduler();

async function responseJSON(response, signal) {
  if (!response.ok || Number(response.headers?.get('content-length')) > MAX_BYTES) throw failed();
  const reader = response.body?.getReader();
  let raw;
  if (reader) {
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw failed(); }
        chunks.push(Buffer.from(value));
      }
      raw = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else {
    raw = await response.text();
    signal.throwIfAborted();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw failed();
  }
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failed();
  return value;
}

async function boundedRequest(fetchImpl, url, { signal, timeoutMs, userAgent }) {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let timeout, onAbort;
  const interrupted = new Promise((resolve, reject) => {
    onAbort = () => reject(combined.reason || failed());
    combined.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (combined.aborted) onAbort();
  });
  const request = (async () => {
    combined.throwIfAborted();
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'error', signal: combined,
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
    });
    combined.throwIfAborted();
    return responseJSON(response, combined);
  })();
  try { return await Promise.race([request, interrupted]); }
  finally { clearTimeout(timeout); combined.removeEventListener('abort', onAbort); }
}

function literalQuery(name) {
  // URL encoding alone does not escape Lucene operators in a search query.
  return `artist:"${name.replace(/[+\-!(){}\[\]^"~*?:\\/|&]/g, '\\$&')}"`;
}

function candidateFromSearch(result, key) {
  if (!Array.isArray(result.artists) || result.artists.length > 100 || !Number.isInteger(result.count) ||
      result.count < result.artists.length || result.offset !== 0) throw failed();
  // A truncated search could hide a second exact-name artist. Do not guess.
  if (result.count > result.artists.length) return null;
  const matches = new Map();
  for (const artist of result.artists) {
    if (!artist || !MBID.test(artist.id) || typeof artist.name !== 'string') throw failed();
    if (normalizeArtistName(artist.name) === key) matches.set(artist.id.toLowerCase(), artist);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function hasMusicCredit(artist) {
  if (typeKey(artist.type) === 'character' || PLACEHOLDERS.has(normalizeArtistName(artist.name))) return false;
  for (const key of ['recordings', 'releases', 'release-groups']) {
    if (!Array.isArray(artist[key]) || artist[key].length > 25) throw failed();
  }
  const titled = entry => entry && MBID.test(entry.id) && typeof entry.title === 'string' && Boolean(entry.title.trim());
  const groups = artist['release-groups'];
  const nonmusic = group => Array.isArray(group?.['secondary-types']) && group['secondary-types'].some(type => NONMUSIC.has(typeKey(type)));
  if (groups.some(group => titled(group) && !nonmusic(group))) return true;
  if (artist.releases.some(release => titled(release) && !nonmusic(release['release-group']))) {
    // An exclusively spoken discography must not qualify via untyped releases.
    if (!groups.length || groups.some(group => !nonmusic(group))) return true;
  }
  return artist.recordings.some(titled) && (!groups.length || groups.some(group => !nonmusic(group)));
}

function officialHomepages(artist) {
  if (!Array.isArray(artist.relations) || artist.relations.length > 500) return [];
  const urls = new Set();
  for (const relation of artist.relations) {
    if (!relation || relation.type !== 'official homepage' || relation['target-type'] !== 'url' ||
        relation.direction !== 'forward' || relation.ended === true ||
        relation['type-id'] && relation['type-id'] !== HOMEPAGE_RELATION) continue;
    const value = relation.url?.resource;
    if (typeof value !== 'string' || value.length > 2048 || /[\p{Cc}\p{Cf}\s]/u.test(value)) continue;
    let url;
    try { url = new URL(value); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search ||
        isIP(url.hostname) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
        /\.(?:localhost|local|internal|lan|home|onion|invalid|test|example)$/.test(url.hostname) || /[<>"\\]/.test(url.href)) continue;
    url.hash = '';
    urls.add(url.href);
    if (urls.size === 5) break;
  }
  return [...urls];
}

const copyResult = value => ({ ...value, ...(value.officialUrls ? { officialUrls: [...value.officialUrls] } : {}) });

/** Read-only MusicBrainz evidence. Search scores and aliases cannot authorize
 * additions. Public JSON metadata requires no key; see MusicBrainz's API,
 * Search and Rate_Limiting documentation. No provider payload is exposed. */
export function createArtistVerifier({
  fetchImpl = fetch, clock = Date.now, scheduler = globalRequests,
  timeoutMs = 8000, requestTimeoutMs = 3500,
  positiveTtlMs = 3_600_000, negativeTtlMs = 900_000, maxCacheEntries = 200,
  userAgent = USER_AGENT,
} = {}) {
  const read = createReadCoalescer({ timeoutMs: clamp(timeoutMs, 8000, 8000) });
  const cache = new Map(), limit = Math.floor(clamp(maxCacheEntries, 200, 200));
  const now = () => Number(clock());
  const requestBudget = clamp(requestTimeoutMs, 3500, 3500);
  // Reject malformed header overrides locally, without issuing a request.
  const validAgent = typeof userAgent === 'string' && userAgent.length <= 300 &&
    /^[^\r\n]+\/[^\s]+ \(https:\/\/[^\s()]+\)$/.test(userAgent);
  const remember = (key, value) => {
    for (const [name, item] of cache) if (item.expiresAt <= now()) cache.delete(name);
    cache.delete(key);
    cache.set(key, { value, expiresAt: now() + (value.status === 'verified'
      ? clamp(positiveTtlMs, 3_600_000, 3_600_000) : clamp(negativeTtlMs, 900_000, 900_000)) });
    while (cache.size > limit) cache.delete(cache.keys().next().value);
  };
  const request = (url, signal) => scheduler(
    () => boundedRequest(fetchImpl, url, { signal, timeoutMs: requestBudget, userAgent }), { signal },
  );
  return {
    async verify(name, { signal } = {}) {
      signal?.throwIfAborted();
      let clean, key;
      try { clean = cleanArtistName(name); key = normalizeArtistName(clean); }
      catch { return { status: 'unverified' }; }
      const cached = cache.get(key);
      if (cached?.expiresAt > now()) return copyResult(cached.value);
      cache.delete(key);
      try {
        const result = await read(key, async sharedSignal => {
          if (!validAgent) throw failed();
          const searchUrl = new URL(API);
          searchUrl.searchParams.set('query', literalQuery(clean));
          searchUrl.searchParams.set('fmt', 'json');
          searchUrl.searchParams.set('limit', '100');
          const candidate = candidateFromSearch(await request(searchUrl, sharedSignal), key);
          let value = { status: 'unverified', source: 'MusicBrainz' };
          if (candidate) {
            const id = candidate.id.toLowerCase(), detailsUrl = new URL(id, API);
            detailsUrl.searchParams.set('fmt', 'json');
            detailsUrl.searchParams.set('inc', 'recordings+releases+release-groups+url-rels');
            const artist = await request(detailsUrl, sharedSignal);
            if (typeof artist.name !== 'string' || artist.id?.toLowerCase() !== id) throw failed();
            if (normalizeArtistName(artist.name) === key && hasMusicCredit(artist)) {
              value = { status: 'verified', name: cleanArtistName(artist.name), source: 'MusicBrainz', sourceUrl: `https://musicbrainz.org/artist/${id}` };
              const officialUrls = officialHomepages(artist);
              if (officialUrls.length) value.officialUrls = officialUrls;
            }
          }
          sharedSignal.throwIfAborted();
          remember(key, value);
          return value;
        }, { signal });
        return copyResult(result);
      } catch {
        signal?.throwIfAborted();
        return { status: 'unavailable', source: 'MusicBrainz' };
      }
    },
  };
}
