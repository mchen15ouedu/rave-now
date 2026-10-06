import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeedbackStore, cleanFeedback, FeedbackError } from '../src/feedback-store.mjs';

const env = { FEEDBACK_HF_REPO: 'example-owner/private-feedback', FEEDBACK_HF_TOKEN: 'hf_' + 'testonlynotarealsecret0123456789' };
const id = '20b0baf4-2d28-4781-9a4a-3d8f036e8cd2';
const sha = 'a'.repeat(40), newSha = 'b'.repeat(40);
const now = '2026-10-06T04:05:06.000Z';
const api = `https://huggingface.co/api/datasets/${env.FEEDBACK_HF_REPO}`;
const tree = `${api}/tree/${sha}/feedback?recursive=true&limit=1000`;
const json = (value, options = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', ...options.headers }, ...options });
const record = (options = {}) => ({ id, text: 'The artist search feels slow.', submittedUtc: now, status: 'New', ...options });
const recordPath = value => `feedback/${value.submittedUtc.slice(0, 7).replace('-', '')}/${value.id}.json`;
const fileEntry = value => ({ type: 'file', path: recordPath(value), size: Buffer.byteLength(JSON.stringify(value)) });
const code = expected => error => error instanceof FeedbackError && error.code === expected && !/hf_test|private-provider|sensitive/.test(error.message);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };

function fixture({ records = [], privateRepo = true, infoSha = sha, treeResponse, commitResponse } = {}) {
  let currentSha = infoSha;
  const files = new Map(records.map(value => [recordPath(value), value]));
  const calls = [], commits = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === `${api}/revision/main`) return json({ private: privateRepo, sha: currentSha });
    if (url.includes('/tree/')) return treeResponse ? treeResponse(url, options) : json([...files.values()].map(fileEntry));
    if (url.includes('/resolve/')) {
      const path = url.split(`/resolve/${currentSha}/`)[1];
      return files.has(path) ? json(files.get(path)) : new Response('', { status: 404 });
    }
    if (url === `${api}/commit/main`) {
      commits.push({ url, options });
      if (commitResponse) return commitResponse(url, options);
      const [header, file] = options.body.trim().split('\n').map(value => JSON.parse(value));
      if (header.value.parentCommit !== currentSha) return json({ error: 'sensitive parent changed' }, { status: 409 });
      assert.equal(file.key, 'file');
      const value = JSON.parse(Buffer.from(file.value.content, 'base64').toString('utf8'));
      files.set(file.value.path, value); currentSha = newSha;
      return json({ success: true, commitOid: currentSha });
    }
    throw new Error('Unexpected request');
  };
  return { calls, commits, files, store: createFeedbackStore({ env, fetchImpl, clock: () => new Date(now) }), fetchImpl };
}

test('feedback validates a stable UUID and bounded plain text while preserving useful line breaks', () => {
  assert.deepEqual(cleanFeedback({ id: id.toUpperCase(), text: '  Cafe\u0301 search\r\nneeds\ta fix.  ' }), { id, text: 'Café search\nneeds\ta fix.' });
  assert.equal(cleanFeedback({ id, text: 'x'.repeat(2000) }).text.length, 2000);
  for (const input of [null, [], {}, { id: '../escape', text: 'hi' }, { id: '00000000-0000-0000-0000-000000000000', text: 'hi' }, { id, text: '' }, { id, text: ' '.repeat(5) }, { id, text: 'x'.repeat(2001) }, { id, text: 123 }, { id, text: 'a\u0000b' }, { id, text: 'a\u202eb' }]) assert.throws(() => cleanFeedback(input), code('INVALID_FEEDBACK'));
});

test('unconfigured public sample never claims feedback was saved and does not fall back to Google', async () => {
  let calls = 0;
  const store = createFeedbackStore({ env: { ARTIST_CATALOG_URL: 'https://example.test', ARTIST_CATALOG_SECRET: 'old-secret' }, fetchImpl: async () => { calls++; } });
  await assert.rejects(store.submit({ id, text: 'Please fix search.' }), code('NOT_CONFIGURED'));
  await assert.rejects(store.list(), code('NOT_CONFIGURED'));
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(store).sort(), ['list', 'submit']);
  assert.ok(!JSON.stringify(store).includes(env.FEEDBACK_HF_TOKEN));
});

test('invalid HF configuration is rejected before any token-bearing request', async () => {
  for (const invalidEnv of [
    { FEEDBACK_HF_REPO: env.FEEDBACK_HF_REPO }, { FEEDBACK_HF_TOKEN: env.FEEDBACK_HF_TOKEN },
    { ...env, FEEDBACK_HF_TOKEN: 'short' }, { ...env, FEEDBACK_HF_TOKEN: env.FEEDBACK_HF_TOKEN + '\n' },
    ...['https://huggingface.co/datasets/owner/repo', '../repo', 'owner/repo/extra', 'owner/a..b', 'owner/repo?redirect=evil', 'owner/.private', 'owner/repo.git'].map(repo => ({ ...env, FEEDBACK_HF_REPO: repo })),
  ]) {
    let calls = 0;
    const store = createFeedbackStore({ env: invalidEnv, fetchImpl: async () => { calls++; } });
    await assert.rejects(store.submit({ id, text: 'Feedback' }), code('INVALID_CONFIGURATION'));
    assert.equal(calls, 0);
  }
});

test('save verifies privacy, pins a snapshot, and writes only one server-timestamped text record', async () => {
  const provider = fixture();
  const input = { id, text: '=HYPERLINK("https://example.test", "Complaint")', audio: 'never-save-this', submittedUtc: '1900-01-01', status: 'fake', location: 'private' };
  assert.deepEqual(await provider.store.submit(input), { id, saved: true });
  assert.equal(provider.commits.length, 1);
  assert.deepEqual(provider.calls.map(call => call.url), [`${api}/revision/main`, tree, `${api}/commit/main`]);
  for (const { url, options } of provider.calls) {
    assert.equal(new URL(url).origin, 'https://huggingface.co');
    assert.equal(options.headers.Authorization, `Bearer ${env.FEEDBACK_HF_TOKEN}`);
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!url.includes(env.FEEDBACK_HF_TOKEN));
  }
  const post = provider.commits[0].options;
  assert.equal(post.headers['Content-Type'], 'application/x-ndjson');
  const [header, file] = post.body.trim().split('\n').map(value => JSON.parse(value));
  assert.deepEqual(header, { key: 'header', value: { summary: 'Save feedback', description: '', parentCommit: sha } });
  assert.equal(file.value.path, `feedback/202610/${id}.json`);
  assert.equal(file.value.encoding, 'base64');
  assert.deepEqual(JSON.parse(Buffer.from(file.value.content, 'base64').toString('utf8')), { id, text: input.text, submittedUtc: now, status: 'New' });
  assert.equal(post.body.includes('never-save-this'), false);
});

test('public repositories and malformed metadata fail closed without reading or writing transcripts', async () => {
  for (const options of [{ privateRepo: false }, { privateRepo: undefined, infoSha: 'invalid' }, { infoSha: 'invalid' }]) {
    const provider = fixture(options);
    await assert.rejects(provider.store.submit({ id, text: 'Complaint' }), code('UNAVAILABLE'));
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.commits.length, 0);
  }
});

test('manual same-UUID retry is idempotent across months and preserves the original timestamp/status', async () => {
  const saved = record({ submittedUtc: '2026-09-30T23:59:59.000Z', status: 'Reviewed' });
  const provider = fixture({ records: [saved] });
  assert.deepEqual(await provider.store.submit({ id: id.toUpperCase(), text: saved.text }), { id, saved: true });
  assert.equal(provider.commits.length, 0);
  assert.deepEqual([...provider.files.values()], [saved]);
  assert.ok(provider.calls.at(-1).url.endsWith(`/resolve/${sha}/feedback/202609/${id}.json`));
});

test('same UUID with different text is rejected without overwriting its saved record', async () => {
  const saved = record();
  const provider = fixture({ records: [saved] });
  await assert.rejects(provider.store.submit({ id, text: 'Different complaint.' }), code('ID_CONFLICT'));
  assert.equal(provider.commits.length, 0);
  assert.deepEqual([...provider.files.values()], [saved]);
});

test('racing writers use parentCommit and never automatically retry an unsuccessful commit', async () => {
  const reached = deferred(); let trees = 0;
  const provider = fixture({ treeResponse: async () => { if (++trees === 2) reached.resolve(); await reached.promise; return json([]); } });
  const results = await Promise.allSettled([provider.store.submit({ id, text: 'First' }), provider.store.submit({ id, text: 'Second' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && code('UNAVAILABLE')(result.reason)).length, 1);
  assert.equal(provider.commits.length, 2);
  assert.equal(provider.files.size, 1);
  assert.equal([...provider.files.values()][0].text, 'First');
  for (const commit of provider.commits) assert.equal(JSON.parse(commit.options.body.split('\n')[0]).value.parentCommit, sha);
});

test('missing feedback folder is an empty inbox and the first save creates only a record file', async () => {
  const provider = fixture({ treeResponse: async () => new Response('', { status: 404 }) });
  assert.deepEqual(await provider.store.list(), []);
  assert.deepEqual(await provider.store.submit({ id, text: 'Please improve search.' }), { id, saved: true });
  assert.deepEqual([...provider.files.keys()], [`feedback/202610/${id}.json`]);
});

test('owner listing reads one pinned snapshot, returns text records, and stays bounded to four files', async () => {
  const values = Array.from({ length: 8 }, (_, index) => record({ id: `${index.toString(16).padStart(8, '0')}-2d28-4781-9a4a-3d8f036e8cd2`, submittedUtc: `2026-10-06T04:05:0${index}.000Z` }));
  let active = 0, maximum = 0;
  const base = fixture({ records: values.toReversed() });
  const store = createFeedbackStore({ env, fetchImpl: async (url, options) => {
    if (!url.includes('/resolve/')) return base.fetchImpl(url, options);
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    try { return await base.fetchImpl(url, options); } finally { active--; }
  } });
  assert.deepEqual(await store.list(), values);
  assert.equal(maximum, 4);
  assert.equal(base.commits.length, 0);
  assert.ok(base.calls.filter(call => call.url.includes('/resolve/')).every(call => call.url.includes(`/resolve/${sha}/`)));
});

test('tree pagination accepts only the same HF snapshot and fails closed on duplicate UUIDs', async () => {
  const saved = record();
  const next = `${api}/tree/${sha}/feedback?recursive=true&limit=1000&cursor=second`;
  const provider = fixture({ records: [saved], treeResponse: async url => url === tree ? json([{ type: 'directory', path: 'feedback/202610' }], { headers: { Link: `<${next}>; rel="next"` } }) : json([fileEntry(saved)]) });
  assert.deepEqual(await provider.store.list(), [saved]);
  assert.equal(provider.calls[2].url, next);
  for (const destination of ['https://evil.example/steal?recursive=true', `${api}/tree/main/feedback?recursive=true`, `${api}/tree/${sha}/other?recursive=true`, `https://user:pass@huggingface.co/api/datasets/${env.FEEDBACK_HF_REPO}/tree/${sha}/feedback?recursive=true`]) {
    const unsafe = fixture({ treeResponse: async () => json([], { headers: { Link: `<${destination}>; rel="next"` } }) });
    await assert.rejects(unsafe.store.list(), code('UNAVAILABLE'));
    assert.equal(unsafe.calls.length, 2);
  }
  const duplicate = fixture({ treeResponse: async () => json([fileEntry(saved), fileEntry(record({ submittedUtc: '2026-09-01T01:00:00.000Z' }))]) });
  await assert.rejects(duplicate.store.submit({ id, text: saved.text }), code('UNAVAILABLE'));
  assert.equal(duplicate.commits.length, 0);
});

test('resolve redirects keep authentication at the exact HF cache origin and deny external destinations', async () => {
  const saved = record();
  const cache = `https://huggingface.co/api/resolve-cache/datasets/${env.FEEDBACK_HF_REPO}/${sha}/${recordPath(saved)}?etag=known`;
  const requests = [];
  const base = fixture({ records: [saved] });
  const store = createFeedbackStore({ env, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/resolve/')) return new Response(null, { status: 307, headers: { Location: cache } });
    if (url === cache) return json(saved);
    return base.fetchImpl(url, options);
  } });
  assert.deepEqual(await store.list(), [saved]);
  assert.equal(requests.at(-1).url, cache);
  assert.equal(requests.at(-1).options.method, 'GET');
  assert.equal(requests.at(-1).options.body, undefined);
  for (const destination of ['https://cdn.example/steal', 'http://huggingface.co/cache', 'https://huggingface.co.evil.test/cache', `https://user:pass@huggingface.co/api/resolve-cache/datasets/${env.FEEDBACK_HF_REPO}/${sha}/file`, 'https://huggingface.co/api/other']) {
    const calls = [];
    const unsafe = createFeedbackStore({ env, fetchImpl: async (url, options) => { calls.push(url); return url.includes('/resolve/') ? new Response(null, { status: 302, headers: { Location: destination } }) : base.fetchImpl(url, options); } });
    await assert.rejects(unsafe.list(), code('UNAVAILABLE'));
    assert.equal(calls.length, 3);
    assert.equal(calls.includes(destination), false);
  }
});

test('provider failures, redirects and unverified commit responses never become saved feedback', async () => {
  for (const commitResponse of [
    async () => { throw new Error('sensitive private-provider ' + env.FEEDBACK_HF_TOKEN); },
    async () => json({ error: 'sensitive' }, { status: 403 }),
    async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }),
    async () => json({ success: false, commitOid: newSha }),
    async () => json({ success: true, commitOid: 'invalid' }),
    async () => new Response('<html>Login required</html>'),
  ]) {
    const provider = fixture({ commitResponse });
    await assert.rejects(provider.store.submit({ id, text: 'Complaint' }), code('UNAVAILABLE'));
    assert.equal(provider.commits.length, 1);
    assert.equal(provider.files.size, 0);
    assert.equal(provider.calls.length, 3);
  }
});

test('invalid stored schemas and oversized responses are rejected without returning partial records', async () => {
  for (const saved of [record({ text: 'x'.repeat(2001) }), record({ audio: 'private' }), record({ submittedUtc: '2026-10-35T00:00:00.000Z' }), record({ status: 'New\n' }), record({ text: ' leading ' })]) {
    const provider = fixture({ records: [saved] });
    await assert.rejects(provider.store.list(), code('UNAVAILABLE'));
  }
  const large = createFeedbackStore({ env, fetchImpl: async () => new Response('x', { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }) });
  await assert.rejects(large.list(), code('UNAVAILABLE'));
  const oversizedBody = createFeedbackStore({ env, fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(oversizedBody.list(), code('UNAVAILABLE'));
});

test('feedback capacity is checked before another commit, while saved IDs remain idempotent', async () => {
  const values = Array.from({ length: 2000 }, (_, index) => record({ id: `${index.toString(16).padStart(8, '0')}-2d28-4781-9a4a-3d8f036e8cd2` }));
  const full = fixture({ records: values });
  await assert.rejects(full.store.submit({ id, text: 'Complaint' }), code('LIMIT_EXCEEDED'));
  assert.equal(full.commits.length, 0);
  assert.deepEqual(await full.store.submit({ id: values[0].id, text: values[0].text }), { id: values[0].id, saved: true });
  const overflow = fixture({ treeResponse: async () => json([...values.map(fileEntry), fileEntry(record())]) });
  await assert.rejects(overflow.store.list(), code('LIMIT_EXCEEDED'));
  assert.equal(overflow.calls.length, 2);
});

test('feedback cancellation before/during reads never begins a later commit or retries', async () => {
  const already = new AbortController(); already.abort();
  const provider = fixture();
  await assert.rejects(provider.store.submit({ id, text: 'Complaint' }, { signal: already.signal }), code('CANCELLED'));
  await assert.rejects(provider.store.list({ signal: already.signal }), code('CANCELLED'));
  assert.equal(provider.calls.length, 0);
  const started = deferred(), response = deferred(), active = new AbortController(); let calls = 0;
  const store = createFeedbackStore({ env, fetchImpl: async () => { calls++; started.resolve(); return response.promise; } });
  const waiting = store.submit({ id, text: 'Complaint' }, { signal: active.signal });
  const rejected = assert.rejects(waiting, code('CANCELLED'));
  await started.promise; active.abort(); await rejected;
  response.resolve(json({ private: true, sha }));
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(calls, 1);
});

test('an interrupted or timed-out commit has one attempt and never reports saved', async () => {
  const started = deferred(), response = deferred(), active = new AbortController();
  const provider = fixture({ commitResponse: async () => { started.resolve(); return response.promise; } });
  const waiting = provider.store.submit({ id, text: 'Complaint' }, { signal: active.signal });
  const rejected = assert.rejects(waiting, code('CANCELLED'));
  await started.promise; active.abort(); await rejected;
  response.resolve(json({ success: true, commitOid: newSha }));
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(provider.commits.length, 1);
  let calls = 0;
  const stalled = createFeedbackStore({ env, timeoutMs: 5, fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(stalled.submit({ id, text: 'Complaint' }), code('UNAVAILABLE'));
  assert.equal(calls, 1);
});
