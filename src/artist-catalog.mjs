import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from './config.mjs';

const MAX_NAME_LENGTH = 120;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_NAMES = 30_000;
const MAX_SHOW_ROWS = 10_000;
const MAX_SHOW_COLUMNS = 100;
const SHOW_HEADERS = ['Artist', 'Event', 'Location', 'City', 'Address', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)'];
const headerKey = value => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

export class CatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
  }
}

/** A cancelled visitor stops waiting, but leaves a bounded read for the next
 * refresh to join. This helper is for reads only: mutations never use it. */
export function createReadCoalescer({ timeoutMs = 40_000 } = {}) {
  const jobs = new Map();
  let active = 0;
  const budget = Math.min(40_000, Math.max(1, Number(timeoutMs) || 40_000));
  const read = async (key, operation, { signal } = {}) => {
    signal?.throwIfAborted();
    let job = jobs.get(key);
    if (!job) {
      if (active >= 4) throw new CatalogError('UNAVAILABLE', 'The feed is busy. Please try again shortly.');
      active++;
      const controller = new AbortController();
      let timeout;
      const promise = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new CatalogError('UNAVAILABLE', 'The feed took too long. Please try again.'));
        }, budget);
        Promise.resolve().then(() => operation(controller.signal)).then(resolve, reject);
      });
      job = { promise };
      jobs.set(key, job);
      const cleanup = () => { clearTimeout(timeout); active--; if (jobs.get(key) === job) jobs.delete(key); };
      promise.then(cleanup, cleanup);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancelled);
        callback(value);
      };
      const cancelled = () => finish(reject, signal.reason ?? new DOMException('Read cancelled', 'AbortError'));
      signal?.addEventListener('abort', cancelled, { once: true });
      if (signal?.aborted) cancelled();
      job.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  };
  // Retire an outdated generation without disrupting its existing waiters.
  read.invalidate = key => jobs.delete(key);
  return read;
}

/** Keep readable spelling; normalization is used only for comparisons. */
export function cleanArtistName(name) {
  if (typeof name !== 'string' || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new CatalogError('INVALID_NAME', 'Enter an artist name without control characters.');
  }
  const clean = name.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!clean || clean.length > MAX_NAME_LENGTH) {
    throw new CatalogError('INVALID_NAME', 'Enter an artist name of 1 to 120 characters.');
  }
  return clean;
}

export function normalizeArtistName(name) {
  return cleanArtistName(name).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US');
}

function catalogNames(values) {
  if (!Array.isArray(values) || values.length > MAX_CATALOG_NAMES) throw unavailable();
  const seen = new Set(), names = [];
  for (const value of values) {
    let name;
    try { name = cleanArtistName(value); } catch { throw unavailable(); }
    const key = normalizeArtistName(name);
    if (!seen.has(key)) { seen.add(key); names.push(name); }
  }
  return names;
}

function unavailable() {
  return new CatalogError('UNAVAILABLE', 'The artist list is unavailable. Please try again later.');
}

function showRows(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_SHOW_ROWS + 1) throw unavailable();
  const headers = values[0];
  if (!Array.isArray(headers) || !headers.length || headers.length > MAX_SHOW_COLUMNS || headers.some(value => typeof value !== 'string')) throw unavailable();
  const keys = headers.map(headerKey);
  const indexes = SHOW_HEADERS.map(header => {
    const key = headerKey(header), index = keys.indexOf(key);
    if (index < 0 || keys.lastIndexOf(key) !== index) throw unavailable();
    return index;
  });
  const rows = [SHOW_HEADERS.slice()];
  for (const row of values.slice(1)) {
    if (!Array.isArray(row) || row.length !== headers.length || row.some(value => typeof value !== 'string')) throw unavailable();
    rows.push(indexes.map(index => row[index]));
  }
  return rows;
}

function bridgeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new CatalogError('INVALID_CONFIGURATION', 'The artist connection needs configuration.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) {
    throw new CatalogError('INVALID_CONFIGURATION', 'The artist connection needs configuration.');
  }
  return url.href;
}

async function readResponse(response) {
  if (!response.ok || Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES) throw unavailable();
  const reader = response.body?.getReader();
  let raw;
  if (reader) {
    const chunks = []; let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw unavailable(); }
        chunks.push(Buffer.from(value));
      }
      raw = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else {
    raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) throw unavailable();
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw unavailable(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true) throw unavailable();
  return value;
}

/** The shared secret is sent from the server, never from browser JavaScript. */
export function createArtistCatalog({ env = process.env, fetchImpl = fetch, snapshotFile, clock = () => new Date() } = {}) {
  const configured = Boolean(env.ARTIST_CATALOG_URL || env.ARTIST_CATALOG_SECRET);
  const snapshot = path.resolve(projectDir, snapshotFile || 'data/name-catalog.json');
  const read = createReadCoalescer({ timeoutMs: 35_000 });
  let cachedNames, namesVersion = 0;
  const currentTime = () => Number(clock());

  async function request(action, name, { signal } = {}) {
    if (!env.ARTIST_CATALOG_URL || typeof env.ARTIST_CATALOG_SECRET !== 'string' || env.ARTIST_CATALOG_SECRET.length < 32 || env.ARTIST_CATALOG_SECRET.length > 512) {
      throw new CatalogError('INVALID_CONFIGURATION', 'The artist connection needs configuration.');
    }
    const url = bridgeUrl(env.ARTIST_CATALOG_URL);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      let response = await fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: env.ARTIST_CATALOG_SECRET, action, ...(name === undefined ? {} : { name }) }),
        redirect: 'manual', signal: requestSignal,
      });
      // ContentService redirects its output to Google. Follow with a fresh GET,
      // so the POST's shared secret is never forwarded to a redirect destination.
      if ([301, 302, 303].includes(response.status)) {
        let outputUrl;
        try { outputUrl = new URL(response.headers.get('location')); } catch { throw unavailable(); }
        if (outputUrl.protocol !== 'https:' || outputUrl.hostname !== 'script.googleusercontent.com' || outputUrl.port || outputUrl.username || outputUrl.password) throw unavailable();
        response = await fetchImpl(outputUrl.href, { method: 'GET', redirect: 'error', signal: requestSignal });
      }
      return await readResponse(response);
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      if (signal?.aborted) throw new CatalogError('CANCELLED', 'The artist request was cancelled.');
      throw unavailable();
    } finally { clearTimeout(timeout); }
  }

  return {
    async load({ signal } = {}) {
      try {
        if (signal?.aborted) throw new CatalogError('CANCELLED', 'The artist request was cancelled.');
        if (cachedNames && cachedNames.expiresAt > currentTime()) return { ...cachedNames.value, artists: [...cachedNames.value.artists], promoters: [...cachedNames.value.promoters] };
        cachedNames = undefined;
        const version = namesVersion;
        const value = await read('catalog', async sharedSignal => {
          const result = configured ? await request('readCatalog', undefined, { signal: sharedSignal }) : JSON.parse(await readFile(snapshot, { encoding: 'utf8', signal: sharedSignal }));
          sharedSignal.throwIfAborted();
          const value = { artists: catalogNames(result.artists), promoters: catalogNames(result.promoters), canAdd: configured };
          if (version === namesVersion) cachedNames = { value, expiresAt: currentTime() + 60_000 };
          return value;
        }, { signal });
        return { ...value, artists: [...value.artists], promoters: [...value.promoters] };
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        if (signal?.aborted) throw new CatalogError('CANCELLED', 'The artist request was cancelled.');
        throw unavailable();
      }
    },
    async ensureArtist(name, { signal } = {}) {
      const clean = cleanArtistName(name);
      if (!configured) throw new CatalogError('NOT_CONFIGURED', 'Adding artists is not connected yet.');
      const result = await request('ensureArtist', clean, { signal });
      let saved;
      try { saved = cleanArtistName(result.name); } catch { throw unavailable(); }
      if (typeof result.added !== 'boolean' || normalizeArtistName(saved) !== normalizeArtistName(clean)) throw unavailable();
      namesVersion++;
      read.invalidate('catalog');
      if (cachedNames && cachedNames.expiresAt > currentTime()) {
        if (!cachedNames.value.artists.some(artist => normalizeArtistName(artist) === normalizeArtistName(saved))) cachedNames.value.artists.push(saved);
      } else cachedNames = undefined;
      return { name: saved, added: result.added };
    },
    async readShows({ signal } = {}) {
      if (signal?.aborted) throw new CatalogError('CANCELLED', 'The show request was cancelled.');
      if (!configured) throw new CatalogError('NOT_CONFIGURED', 'Live show fetching is not connected yet.');
      try {
        const rows = await read('shows', async sharedSignal => {
          const result = await request('readShows', undefined, { signal: sharedSignal });
          return showRows(result.rows);
        }, { signal });
        return { rows: rows.map(row => [...row]) };
      } catch (error) {
        if (signal?.aborted) throw new CatalogError('CANCELLED', 'The show request was cancelled.');
        throw error;
      }
    },
  };
}
