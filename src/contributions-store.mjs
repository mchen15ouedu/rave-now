import { isIP } from 'node:net';

const HF_ORIGIN = 'https://huggingface.co';
const MAX_RECORDS = 2000;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const PATH = /^contributions\/(\d{4}(?:0[1-9]|1[0-2]))\/([0-9a-f-]+)\.json$/;
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u;
const STATUSES = new Set(['queued', 'processing', 'completed', 'needs-review', 'rejected']);
const TERMINAL = new Set(['completed', 'needs-review', 'rejected']);
const ARTIST_STATUSES = new Set(['not-requested', 'pending', 'added', 'existing', 'unverified', 'needs-review', 'rejected', 'unavailable']);
const EVENT_STATUSES = new Set(['not-requested', 'pending', 'added', 'existing', 'merged', 'needs-review', 'rejected', 'unavailable']);
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export class ContributionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContributionError';
    this.code = code;
  }
}

const unavailable = () => new ContributionError('UNAVAILABLE', 'The contribution inbox is temporarily unavailable.');
const cancelled = () => new ContributionError('CANCELLED', 'The contribution request was cancelled.');
const invalid = () => new ContributionError('INVALID_CONTRIBUTION', 'Enter a contribution of 1 to 2000 characters with a valid submission ID.');
const invalidUpdate = () => new ContributionError('INVALID_UPDATE', 'The contribution update is invalid.');
const leaseLost = () => new ContributionError('LEASE_LOST', 'The contribution lease is no longer owned by this worker.');
const limitExceeded = () => new ContributionError('LIMIT_EXCEEDED', 'The contribution inbox is full.');
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function cleanId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw invalid();
  return id.toLowerCase();
}

export function cleanContribution(input = {}) {
  if (!object(input) || !keysOnly(input, ['id', 'text'])) throw invalid();
  const id = cleanId(input.id);
  if (typeof input.text !== 'string' || BAD_TEXT.test(input.text)) throw invalid();
  const text = input.text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (!text || text.length > 2000) throw invalid();
  return { id, text };
}

function validRepo(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  return parts.length === 2 && parts.every(part => /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?$/.test(part) && !/\.\.|--|\.git$/.test(part));
}

function publicHostname(value) {
  const host = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host)) return false;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) return !/^(?:::1?$|f[cd]|fe[89a-f]|ff|::ffff:)/i.test(host);
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && host.includes('.') && !host.includes('..');
}

function resultText(value, max, token) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value)) throw invalidUpdate();
  const text = value.normalize('NFC').trim();
  if (typeof token === 'string' && token && text.includes(token) || /\b(?:hf_[a-z0-9]{16,}|sk-(?:proj-)?[a-z0-9_-]{16,})\b/i.test(text)) throw invalidUpdate();
  return text;
}

function cleanResult(value, token) {
  if (!object(value) || !keysOnly(value, ['message', 'artistStatus', 'eventStatus', 'artistName', 'sourceUrls']) || !ARTIST_STATUSES.has(value.artistStatus) || !EVENT_STATUSES.has(value.eventStatus)) throw invalidUpdate();
  const result = { message: resultText(value.message, 1000, token), artistStatus: value.artistStatus, eventStatus: value.eventStatus };
  if (Object.hasOwn(value, 'artistName')) result.artistName = resultText(value.artistName, 120, token);
  if (Object.hasOwn(value, 'sourceUrls')) {
    if (!Array.isArray(value.sourceUrls) || value.sourceUrls.length > 10) throw invalidUpdate();
    result.sourceUrls = value.sourceUrls.map(value => {
      if (typeof value !== 'string' || value.length > 2048 || /[\p{Cc}\p{Cf}]/u.test(value)) throw invalidUpdate();
      let url;
      try { url = new URL(value); } catch { throw invalidUpdate(); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href.length > 2048 || !publicHostname(url.hostname) || [...url.searchParams.keys()].some(key => /auth|token|secret|key/i.test(key)) || typeof token === 'string' && token && url.href.includes(token) || /\b(?:hf_[a-z0-9]{16,}|sk-(?:proj-)?[a-z0-9_-]{16,})\b/i.test(url.href)) throw invalidUpdate();
      return url.href;
    });
    if (new Set(result.sourceUrls).size !== result.sourceUrls.length) throw invalidUpdate();
  }
  return result;
}

async function readJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.ok || Number(response.headers?.get('content-length')) > maxBytes) {
    try { await response.body?.cancel(); } catch {}
    throw unavailable();
  }
  const reader = response.body?.getReader();
  let raw;
  if (reader) {
    const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw unavailable(); }
        chunks.push(Buffer.from(value));
      }
      raw = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else {
    raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw unavailable();
  }
  try { return JSON.parse(raw); } catch { throw unavailable(); }
}

function nextTreePage(link, initial) {
  if (!link) return null;
  const next = link.split(',').find(part => /;\s*rel="next"\s*$/.test(part.trim()));
  if (!next) { if (/\brel\s*=\s*"?next\b/.test(link)) throw unavailable(); return null; }
  let url;
  try { url = new URL(/^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(next)?.[1]); } catch { throw unavailable(); }
  if (url.origin !== HF_ORIGIN || url.username || url.password || url.hash || url.pathname !== new URL(initial).pathname || url.search.length > 4096 || url.searchParams.get('recursive') !== 'true') throw unavailable();
  return url.href;
}

/** Private text submissions and processing leases live in atomic, versioned HF
 * Dataset commits. This module never creates a repository or retries a POST. */
export function createContributionsStore({ env = process.env, fetchImpl = fetch, clock = () => new Date(), timeoutMs = 30_000 } = {}) {
  const repo = env.CONTRIBUTIONS_HF_REPO;
  const token = env.CONTRIBUTIONS_HF_TOKEN || env.FEEDBACK_HF_TOKEN;
  const configured = Boolean(repo || env.CONTRIBUTIONS_HF_TOKEN);
  const budget = Math.min(120_000, Math.max(1, Number(timeoutMs) || 30_000));
  const recordCache = new Map();
  const now = () => {
    const value = new Date(clock()).toISOString();
    if (!iso(value)) throw unavailable();
    return value;
  };

  function record(value, filePath) {
    if (!object(value) || !keysOnly(value, ['id', 'text', 'submittedUtc', 'updatedUtc', 'status', 'lease', 'result'])) throw unavailable();
    let clean;
    try { clean = cleanContribution({ id: value.id, text: value.text }); } catch { throw unavailable(); }
    const path = PATH.exec(filePath);
    if (!path || path[2] !== clean.id || value.id !== clean.id || value.text !== clean.text || !iso(value.submittedUtc) || !iso(value.updatedUtc) || value.updatedUtc < value.submittedUtc || value.submittedUtc.slice(0, 7).replace('-', '') !== path[1] || !STATUSES.has(value.status)) throw unavailable();
    let lease = null, result = null;
    if (value.status === 'processing') {
      if (!object(value.lease) || !keysOnly(value.lease, ['owner', 'until']) || typeof value.lease.owner !== 'string' || !OWNER.test(value.lease.owner) || !iso(value.lease.until) || value.lease.until <= value.updatedUtc) throw unavailable();
      lease = { owner: value.lease.owner, until: value.lease.until };
    } else if (value.lease !== null) throw unavailable();
    if (value.result !== null) {
      try { result = cleanResult(value.result, token); } catch { throw unavailable(); }
      if (result.message !== value.result.message || result.artistName !== value.result.artistName || value.result.sourceUrls?.some((url, index) => result.sourceUrls[index] !== url)) throw unavailable();
    }
    if (value.status === 'queued' && result !== null || TERMINAL.has(value.status) && result === null) throw unavailable();
    return { ...clean, submittedUtc: value.submittedUtc, updatedUtc: value.updatedUtc, status: value.status, lease, result };
  }

  async function run(operation, { signal } = {}) {
    if (signal?.aborted) throw cancelled();
    if (!configured) throw new ContributionError('NOT_CONFIGURED', 'Saving contributions is not connected yet.');
    if (!validRepo(repo) || typeof token !== 'string' || !/^hf_[A-Za-z0-9]{16,256}$/.test(token)) throw new ContributionError('INVALID_CONFIGURATION', 'The private contribution connection needs configuration.');
    const controller = new AbortController();
    const limited = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let aborted;
    const timeout = setTimeout(() => controller.abort(), budget);
    try {
      const cancellation = new Promise((_, reject) => {
        aborted = () => reject(signal?.aborted ? cancelled() : unavailable());
        limited.addEventListener('abort', aborted, { once: true });
        if (limited.aborted) aborted();
      });
      return await Promise.race([operation(limited), cancellation]);
    } catch (error) {
      controller.abort();
      if (signal?.aborted) throw cancelled();
      if (error instanceof ContributionError) throw error;
      throw unavailable();
    } finally { clearTimeout(timeout); limited.removeEventListener('abort', aborted); }
  }

  async function hub(url, options, signal) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options?.headers }, redirect: 'manual', signal });
    signal.throwIfAborted();
    return response;
  }

  async function snapshot(signal) {
    const response = await hub(`${HF_ORIGIN}/api/datasets/${repo}/revision/main`, { method: 'GET' }, signal);
    const info = await readJson(response);
    if (!object(info) || info.private !== true || !SHA.test(info.sha)) throw unavailable();
    return info.sha;
  }

  async function filesAt(sha, signal) {
    const initial = `${HF_ORIGIN}/api/datasets/${repo}/tree/${sha}/contributions?recursive=true&limit=1000`;
    let url = initial, pages = 0, count = 0;
    const visited = new Set(), ids = new Set(), files = [];
    do {
      if (visited.has(url) || ++pages > 10) throw unavailable();
      visited.add(url);
      const response = await hub(url, { method: 'GET' }, signal);
      if (response.status === 404 && pages === 1) return [];
      const entries = await readJson(response);
      if (!Array.isArray(entries) || (count += entries.length) > MAX_RECORDS * 2 + 1) throw limitExceeded();
      for (const entry of entries) {
        if (!object(entry) || typeof entry.path !== 'string') throw unavailable();
        if (entry.type === 'directory' && /^contributions(?:\/\d{4}(?:0[1-9]|1[0-2]))?$/.test(entry.path)) continue;
        const path = PATH.exec(entry.path);
        if (entry.type !== 'file' || !path || !UUID.test(path[2]) || !Number.isInteger(entry.size) || entry.size < 1 || entry.size > MAX_RECORD_BYTES || ids.has(path[2])) throw unavailable();
        ids.add(path[2]); files.push({ id: path[2], path: entry.path, ...(typeof entry.oid === 'string' && SHA.test(entry.oid) ? { oid: entry.oid } : {}) });
        if (files.length > MAX_RECORDS) throw limitExceeded();
      }
      url = nextTreePage(response.headers?.get('link'), initial);
    } while (url);
    return files;
  }

  async function readRecord(sha, path, signal, oid) {
    signal.throwIfAborted();
    const cached = oid && recordCache.get(path);
    if (cached && cached.oid === oid) {
      recordCache.delete(path); recordCache.set(path, cached);
      return structuredClone(cached.value);
    }
    let url = `${HF_ORIGIN}/datasets/${repo}/resolve/${sha}/${path}`;
    for (let redirects = 0; redirects < 3; redirects++) {
      const response = await hub(url, { method: 'GET' }, signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        let next;
        try { next = new URL(response.headers.get('location'), url); } catch { throw unavailable(); }
        if (next.origin !== HF_ORIGIN || next.username || next.password || next.hash || !next.pathname.startsWith(`/api/resolve-cache/datasets/${repo}/${sha}/`)) throw unavailable();
        url = next.href; continue;
      }
      const value = record(await readJson(response, MAX_RECORD_BYTES), path);
      // Git blob IDs describe immutable content across commits. Never cache
      // responses without a verified tree oid, and never share mutable objects.
      if (oid) {
        recordCache.delete(path);
        recordCache.set(path, { oid, value: structuredClone(value) });
        if (recordCache.size > MAX_RECORDS) recordCache.delete(recordCache.keys().next().value);
      }
      return value;
    }
    throw unavailable();
  }

  async function locate(id, signal) {
    const sha = await snapshot(signal), files = await filesAt(sha, signal);
    const file = files.find(file => file.id === id);
    return { sha, files, file, value: file ? await readRecord(sha, file.path, signal, file.oid) : null };
  }

  async function writeRecord(sha, path, value, signal, { conflict } = {}) {
    record(value, path);
    const content = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(content, 'utf8') > MAX_RECORD_BYTES) throw invalidUpdate();
    const body = [
      { key: 'header', value: { summary: 'Update contribution', description: '', parentCommit: sha } },
      { key: 'file', value: { path, encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n';
    const response = await hub(`${HF_ORIGIN}/api/datasets/${repo}/commit/main`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body }, signal);
    if ([409, 412].includes(response.status) && conflict) { try { await response.body?.cancel(); } catch {} return false; }
    const result = await readJson(response);
    if (!object(result) || result.success !== true || !SHA.test(result.commitOid)) throw unavailable();
    return true;
  }

  return {
    async submit(input, options = {}) {
      if (options.signal?.aborted) throw cancelled();
      const clean = cleanContribution(input);
      return run(async signal => {
        const found = await locate(clean.id, signal);
        if (found.value) {
          if (found.value.text !== clean.text) throw new ContributionError('ID_CONFLICT', 'This submission ID already belongs to different text.');
          return { id: clean.id, saved: true };
        }
        if (found.files.length >= MAX_RECORDS) throw limitExceeded();
        const submittedUtc = now();
        const path = `contributions/${submittedUtc.slice(0, 7).replace('-', '')}/${clean.id}.json`;
        await writeRecord(found.sha, path, { ...clean, submittedUtc, updatedUtc: submittedUtc, status: 'queued', lease: null, result: null }, signal);
        return { id: clean.id, saved: true };
      }, options);
    },
    async get(id, options = {}) {
      const clean = cleanId(id);
      return run(async signal => (await locate(clean, signal)).value, options);
    },
    async pending({ limit = 10, signal } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalidUpdate();
      return run(async signal => {
        const sha = await snapshot(signal), files = await filesAt(sha, signal), values = new Array(files.length);
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
          for (;;) {
            signal.throwIfAborted();
            const current = index++;
            if (current >= files.length) return;
            values[current] = await readRecord(sha, files[current].path, signal, files[current].oid);
          }
        }));
        const timestamp = now();
        return values.filter(value => value.status === 'queued' || value.status === 'processing' && value.lease.until <= timestamp).sort((a, b) => a.submittedUtc.localeCompare(b.submittedUtc) || a.id.localeCompare(b.id)).slice(0, limit);
      }, { signal });
    },
    async claim(id, { owner, leaseMs = 420_000, signal } = {}) {
      const clean = cleanId(id);
      if (typeof owner !== 'string' || !OWNER.test(owner) || !Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 420_000) throw invalidUpdate();
      return run(async signal => {
        const found = await locate(clean, signal);
        if (!found.value) return null;
        const updatedUtc = now();
        if (found.value.status !== 'queued' && !(found.value.status === 'processing' && found.value.lease.until <= updatedUtc)) return null;
        const value = { ...found.value, updatedUtc, status: 'processing', lease: { owner, until: new Date(Date.parse(updatedUtc) + leaseMs).toISOString() } };
        return await writeRecord(found.sha, found.file.path, value, signal, { conflict: true }) ? value : null;
      }, { signal });
    },
    async update(id, patch, { owner, signal } = {}) {
      const clean = cleanId(id);
      if (typeof owner !== 'string' || !OWNER.test(owner) || !object(patch) || !Object.keys(patch).length || !keysOnly(patch, ['status', 'result']) || Object.hasOwn(patch, 'status') && patch.status !== 'processing' && !TERMINAL.has(patch.status)) throw invalidUpdate();
      const result = Object.hasOwn(patch, 'result') ? patch.result === null ? null : cleanResult(patch.result, token) : undefined;
      return run(async signal => {
        const found = await locate(clean, signal), updatedUtc = now();
        if (!found.value || found.value.status !== 'processing' || found.value.lease.owner !== owner || found.value.lease.until <= updatedUtc) throw leaseLost();
        const status = patch.status ?? found.value.status;
        const value = { ...found.value, updatedUtc, status, result: result === undefined ? found.value.result : result, lease: TERMINAL.has(status) ? null : found.value.lease };
        if (TERMINAL.has(status) && value.result === null) throw invalidUpdate();
        if (!await writeRecord(found.sha, found.file.path, value, signal, { conflict: true })) throw leaseLost();
        return value;
      }, { signal });
    },
  };
}
