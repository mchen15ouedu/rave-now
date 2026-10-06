const MAX_TEXT_LENGTH = 2000;
const MAX_FEEDBACK_RECORDS = 2000;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HF_ORIGIN = 'https://huggingface.co';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const RECORD_PATH = /^feedback\/(\d{4}(?:0[1-9]|1[0-2]))\/([0-9a-f-]+)\.json$/;
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u;

export class FeedbackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FeedbackError';
    this.code = code;
  }
}

const unavailable = () => new FeedbackError('UNAVAILABLE', 'Feedback could not be saved or read. Please try again later.');
const cancelled = () => new FeedbackError('CANCELLED', 'The feedback request was cancelled.');
const invalid = () => new FeedbackError('INVALID_FEEDBACK', 'Enter feedback of 1 to 2000 characters with a valid submission ID.');
const limitExceeded = () => new FeedbackError('LIMIT_EXCEEDED', 'The feedback inbox is full. Please try again later.');
const configurationError = () => new FeedbackError('INVALID_CONFIGURATION', 'The private feedback connection needs configuration.');

export function cleanFeedback(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const { id, text } = input;
  if (typeof id !== 'string' || !UUID.test(id) || typeof text !== 'string' || BAD_TEXT.test(text)) throw invalid();
  const clean = text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (!clean || clean.length > MAX_TEXT_LENGTH) throw invalid();
  return { id: id.toLowerCase(), text: clean };
}

function validRepo(value) {
  if (typeof value !== 'string') return false;
  const components = value.split('/');
  return components.length === 2 && components.every(part => /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?$/.test(part) && !/\.\.|--|\.git$/.test(part));
}

async function readJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.ok || Number(response.headers?.get('content-length')) > maxBytes) throw unavailable();
  const reader = response.body?.getReader();
  let raw;
  if (reader) {
    const chunks = []; let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw unavailable(); }
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

function feedbackRecord(value, filePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id', 'submittedUtc', 'text', 'status'].includes(key))) throw unavailable();
  let clean;
  try { clean = cleanFeedback(value); } catch { throw unavailable(); }
  const match = RECORD_PATH.exec(filePath);
  if (clean.id !== value.id || clean.text !== value.text || !match || match[2] !== clean.id) throw unavailable();
  if (typeof value.submittedUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.submittedUtc) || !Number.isFinite(Date.parse(value.submittedUtc)) || new Date(value.submittedUtc).toISOString() !== value.submittedUtc || value.submittedUtc.slice(0, 7).replace('-', '') !== match[1]) throw unavailable();
  if (typeof value.status !== 'string' || !value.status.trim() || value.status.length > 80 || /[\p{Cc}\p{Cf}]/u.test(value.status)) throw unavailable();
  return { ...clean, submittedUtc: value.submittedUtc, status: value.status };
}

function nextTreePage(link, treeUrl) {
  if (!link) return null;
  const next = link.split(',').find(part => /;\s*rel="next"\s*$/.test(part.trim()));
  if (!next) {
    if (/\brel\s*=\s*"?next\b/.test(link)) throw unavailable();
    return null;
  }
  const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(next);
  let url;
  try { url = new URL(match?.[1]); } catch { throw unavailable(); }
  // Pagination must stay in the exact repository snapshot. Authentication is
  // never sent to a URL selected by a user or to another host from a Link header.
  const expected = new URL(treeUrl);
  if (url.origin !== HF_ORIGIN || url.username || url.password || url.hash || url.pathname !== expected.pathname || url.search.length > 4096 || url.searchParams.get('recursive') !== 'true') throw unavailable();
  return url.href;
}

/** Versioned, durable text in one private Hugging Face Dataset. There is no
 * audio, browser credential, local fallback, automatic write retry, or public list. */
export function createFeedbackStore({ env = process.env, fetchImpl = fetch, clock = () => new Date(), timeoutMs = 30_000 } = {}) {
  const repo = env.FEEDBACK_HF_REPO;
  const token = env.FEEDBACK_HF_TOKEN;
  const configured = Boolean(repo || token);
  const budget = Math.min(120_000, Math.max(1, Number(timeoutMs) || 30_000));

  async function run(operation, { signal } = {}) {
    if (signal?.aborted) throw cancelled();
    if (!configured) throw new FeedbackError('NOT_CONFIGURED', 'Saving feedback is not connected yet.');
    if (!validRepo(repo) || typeof token !== 'string' || !/^hf_[A-Za-z0-9]{16,256}$/.test(token)) throw configurationError();
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let abortListener;
    const timeout = setTimeout(() => controller.abort(), budget);
    try {
      // Stop waiting even when an injected provider ignores AbortSignal. An
      // interrupted commit may have saved already; manually retry its same UUID.
      const aborted = new Promise((resolve, reject) => {
        abortListener = () => reject(signal?.aborted ? cancelled() : unavailable());
        requestSignal.addEventListener('abort', abortListener, { once: true });
        if (requestSignal.aborted) abortListener();
      });
      return await Promise.race([operation(requestSignal), aborted]);
    } catch (error) {
      controller.abort();
      if (signal?.aborted) throw cancelled();
      if (error instanceof FeedbackError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timeout);
      requestSignal.removeEventListener('abort', abortListener);
    }
  }

  async function hubRequest(url, options, signal) {
    signal.throwIfAborted();
    // Every authenticated target originates in this module or its checked tree
    // pagination. Deny automatic redirects, including redirects on commit POST.
    const response = await fetchImpl(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options?.headers }, redirect: 'manual', signal });
    signal.throwIfAborted();
    return response;
  }

  async function snapshot(signal) {
    const response = await hubRequest(`${HF_ORIGIN}/api/datasets/${repo}/revision/main`, { method: 'GET' }, signal);
    const info = await readJson(response);
    if (!info || typeof info !== 'object' || Array.isArray(info) || info.private !== true || !SHA.test(info.sha)) throw unavailable();
    return info.sha;
  }

  async function recordFiles(sha, signal) {
    const treeUrl = `${HF_ORIGIN}/api/datasets/${repo}/tree/${sha}/feedback?recursive=true&limit=1000`;
    let url = treeUrl, pageCount = 0, entryCount = 0;
    const visited = new Set(), ids = new Set(), files = [];
    do {
      if (visited.has(url) || ++pageCount > 10) throw unavailable();
      visited.add(url);
      const response = await hubRequest(url, { method: 'GET' }, signal);
      // A verified repository snapshot may not have a Feedback folder yet.
      if (response.status === 404 && pageCount === 1) return [];
      const entries = await readJson(response);
      if (!Array.isArray(entries) || (entryCount += entries.length) > MAX_FEEDBACK_RECORDS * 2 + 1) throw limitExceeded();
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') throw unavailable();
        if (entry.type === 'directory' && /^feedback(?:\/\d{4}(?:0[1-9]|1[0-2]))?$/.test(entry.path)) continue;
        const match = RECORD_PATH.exec(entry.path);
        if (entry.type !== 'file' || !match || !UUID.test(match[2]) || !Number.isInteger(entry.size) || entry.size < 1 || entry.size > MAX_RECORD_BYTES || ids.has(match[2])) throw unavailable();
        ids.add(match[2]);
        files.push({ id: match[2], path: entry.path });
        if (files.length > MAX_FEEDBACK_RECORDS) throw limitExceeded();
      }
      url = nextTreePage(response.headers?.get('link'), treeUrl);
    } while (url);
    return files;
  }

  async function readRecord(sha, filePath, signal) {
    let url = `${HF_ORIGIN}/datasets/${repo}/resolve/${sha}/${filePath}`;
    for (let count = 0; count < 3; count++) {
      const response = await hubRequest(url, { method: 'GET' }, signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        let next;
        try { next = new URL(response.headers.get('location'), url); } catch { throw unavailable(); }
        // Small regular JSON files can redirect to HF's same-origin cache.
        // A signed external storage URL never receives the bearer token.
        if (next.origin !== HF_ORIGIN || next.username || next.password || next.hash || !next.pathname.startsWith(`/api/resolve-cache/datasets/${repo}/${sha}/`)) throw unavailable();
        url = next.href;
        continue;
      }
      return feedbackRecord(await readJson(response, MAX_RECORD_BYTES), filePath);
    }
    throw unavailable();
  }

  return {
    async submit(input, options = {}) {
      if (options.signal?.aborted) throw cancelled();
      const clean = cleanFeedback(input);
      return run(async signal => {
        const sha = await snapshot(signal);
        const files = await recordFiles(sha, signal);
        const existing = files.find(file => file.id === clean.id);
        if (existing) {
          const record = await readRecord(sha, existing.path, signal);
          if (record.text !== clean.text) throw new FeedbackError('ID_CONFLICT', 'This submission ID already belongs to different feedback.');
          return { id: clean.id, saved: true };
        }
        if (files.length >= MAX_FEEDBACK_RECORDS) throw limitExceeded();
        const submittedUtc = new Date(clock()).toISOString();
        if (!/^\d{4}-/.test(submittedUtc)) throw unavailable();
        const filePath = `feedback/${submittedUtc.slice(0, 7).replace('-', '')}/${clean.id}.json`;
        const record = { ...clean, submittedUtc, status: 'New' };
        const body = [
          { key: 'header', value: { summary: 'Save feedback', description: '', parentCommit: sha } },
          { key: 'file', value: { path: filePath, encoding: 'base64', content: Buffer.from(JSON.stringify(record) + '\n', 'utf8').toString('base64') } },
        ].map(item => JSON.stringify(item)).join('\n') + '\n';
        // One conditional commit. If another writer changed main, HF rejects
        // parentCommit; never overwrite a conflicting UUID or retry the POST.
        const response = await hubRequest(`${HF_ORIGIN}/api/datasets/${repo}/commit/main`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body }, signal);
        const result = await readJson(response);
        if (!result || result.success !== true || !SHA.test(result.commitOid)) throw unavailable();
        return { id: clean.id, saved: true };
      }, options);
    },
    async list(options = {}) {
      return run(async signal => {
        const sha = await snapshot(signal);
        const files = await recordFiles(sha, signal);
        const records = new Array(files.length);
        let index = 0;
        // Owner reads are bounded to four simultaneous files and one snapshot.
        await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
          for (;;) {
            signal.throwIfAborted();
            const current = index++;
            if (current >= files.length) return;
            records[current] = await readRecord(sha, files[current].path, signal);
          }
        }));
        return records.sort((a, b) => a.submittedUtc.localeCompare(b.submittedUtc) || a.id.localeCompare(b.id));
      }, options);
    },
  };
}
