import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createContributionsStore, cleanContribution, ContributionError } from '../src/contributions-store.mjs';

const env = { CONTRIBUTIONS_HF_REPO: 'example-owner/private-contributions', CONTRIBUTIONS_HF_TOKEN: 'hf_' + 'testonlynotarealsecret0123456789' };
const id = '20b0baf4-2d28-4781-9a4a-3d8f036e8cd2';
const secondId = '30b0baf4-2d28-4781-9a4a-3d8f036e8cd2';
const sha = 'a'.repeat(40), now = '2026-10-07T12:00:00.000Z';
const api = `https://huggingface.co/api/datasets/${env.CONTRIBUTIONS_HF_REPO}`;
const tree = `${api}/tree/${sha}/contributions?recursive=true&limit=1000`;
const json = (value, options = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...options });
const record = (patch = {}) => ({ id, text: 'Please add this artist.', submittedUtc: now, updatedUtc: now, status: 'queued', lease: null, result: null, ...patch });
const result = (patch = {}) => ({ message: 'Artist added.', artistStatus: 'added', eventStatus: 'not-requested', ...patch });
const pathFor = value => `contributions/${value.submittedUtc.slice(0, 7).replace('-', '')}/${value.id}.json`;
const entry = value => ({ type: 'file', path: pathFor(value), size: Buffer.byteLength(JSON.stringify(value)) });
const code = expected => error => error instanceof ContributionError && error.code === expected && !/private-provider|hf_test|sensitive/.test(error.message);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };

function fixture({ records = [], privateRepo = true, infoSha, treeResponse, commitResponse, clock = () => now, storeEnv = env, treeOids = false } = {}) {
  let head = sha, counter = 0;
  const snapshots = new Map([[head, new Map(records.map(value => [pathFor(value), structuredClone(value)]))]]);
  const calls = [], commits = [];
  const applyCommit = options => {
    const [header, file] = options.body.trim().split('\n').map(JSON.parse);
    if (header.value.parentCommit !== head) return json({ error: 'sensitive parent changed' }, { status: 409 });
    const files = new Map(snapshots.get(head));
    files.set(file.value.path, JSON.parse(Buffer.from(file.value.content, 'base64').toString('utf8')));
    head = (++counter).toString(16).padStart(40, '0'); snapshots.set(head, files);
    return json({ success: true, commitOid: head });
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/revision/main')) return json({ private: privateRepo, sha: infoSha ?? head });
    if (url.includes('/tree/')) {
      if (treeResponse) return treeResponse(url, options);
      const revision = /\/tree\/([a-f0-9]{40})\//.exec(url)?.[1];
      return json([...snapshots.get(revision).values()].map(value => ({ ...entry(value), ...(treeOids ? { oid: createHash('sha1').update(JSON.stringify(value)).digest('hex') } : {}) })));
    }
    if (url.includes('/resolve/')) {
      const match = /\/resolve\/([a-f0-9]{40})\/(.+)$/.exec(url);
      const value = snapshots.get(match?.[1])?.get(match?.[2]);
      return value ? json(value) : new Response('', { status: 404 });
    }
    if (url.endsWith('/commit/main')) {
      commits.push({ url, options });
      return commitResponse ? commitResponse(url, options, applyCommit) : applyCommit(options);
    }
    throw new Error('Unexpected private-provider endpoint');
  };
  const store = createContributionsStore({ env: storeEnv, fetchImpl, clock });
  return { store, fetchImpl, calls, commits, latest: () => [...snapshots.get(head).values()] };
}

test('contributions validate bounded canonical text, UUIDs and text-only submission keys', () => {
  assert.deepEqual(cleanContribution({ id: id.toUpperCase(), text: ' Cafe\u0301\r\nshow ' }), { id, text: 'Café\nshow' });
  assert.equal(cleanContribution({ id, text: 'x'.repeat(2000) }).text.length, 2000);
  for (const input of [null, [], {}, { id: '../escape', text: 'artist' }, { id, text: '' }, { id, text: ' ' }, { id, text: 123 }, { id, text: 'x'.repeat(2001) }, { id, text: 'a\u0000b' }, { id, text: 'a\u202eb' }, { id, text: 'artist', audio: 'raw' }]) assert.throws(() => cleanContribution(input), code('INVALID_CONTRIBUTION'));
});

test('unconfigured contributions never use feedback storage or falsely save, and configuration exposes no token', async () => {
  let calls = 0;
  const store = createContributionsStore({ env: { FEEDBACK_HF_REPO: 'other/private', FEEDBACK_HF_TOKEN: env.CONTRIBUTIONS_HF_TOKEN }, fetchImpl: async () => { calls++; } });
  await assert.rejects(store.submit({ id, text: 'artist' }), code('NOT_CONFIGURED'));
  await assert.rejects(store.get(id), code('NOT_CONFIGURED'));
  await assert.rejects(store.pending(), code('NOT_CONFIGURED'));
  await assert.rejects(store.claim(id, { owner: 'worker' }), code('NOT_CONFIGURED'));
  await assert.rejects(store.update(id, { status: 'completed', result: result() }, { owner: 'worker' }), code('NOT_CONFIGURED'));
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(store).sort(), ['claim', 'get', 'pending', 'submit', 'update']);
  assert.equal(JSON.stringify(store).includes(env.CONTRIBUTIONS_HF_TOKEN), false);
});

test('dedicated repo may reuse feedback token, but invalid repo/token never contacts arbitrary endpoints', async () => {
  const fallback = fixture({ storeEnv: { CONTRIBUTIONS_HF_REPO: env.CONTRIBUTIONS_HF_REPO, FEEDBACK_HF_TOKEN: env.CONTRIBUTIONS_HF_TOKEN } });
  assert.deepEqual(await fallback.store.submit({ id, text: 'artist' }), { id, saved: true });
  assert.equal(fallback.calls[0].options.headers.Authorization, `Bearer ${env.CONTRIBUTIONS_HF_TOKEN}`);
  for (const invalid of [
    { CONTRIBUTIONS_HF_REPO: env.CONTRIBUTIONS_HF_REPO }, { CONTRIBUTIONS_HF_TOKEN: env.CONTRIBUTIONS_HF_TOKEN },
    ...['https://evil.example/owner/repo', 'owner/repo/extra', 'owner/a..b', 'owner/repo.git', 'owner/repo?key=x'].map(repo => ({ ...env, CONTRIBUTIONS_HF_REPO: repo })),
    { ...env, CONTRIBUTIONS_HF_TOKEN: 'short' }, { ...env, CONTRIBUTIONS_HF_TOKEN: env.CONTRIBUTIONS_HF_TOKEN + '\n' },
  ]) {
    let calls = 0;
    const store = createContributionsStore({ env: invalid, fetchImpl: async () => { calls++; } });
    await assert.rejects(store.get(id), code('INVALID_CONFIGURATION'));
    assert.equal(calls, 0);
  }
});

test('submit verifies private storage and atomically creates a queued record with server timestamps', async () => {
  const provider = fixture();
  assert.deepEqual(await provider.store.submit({ id: id.toUpperCase(), text: '=Artist name' }), { id, saved: true });
  assert.deepEqual(provider.latest(), [record({ text: '=Artist name' })]);
  assert.equal(provider.commits.length, 1);
  const [header, file] = provider.commits[0].options.body.trim().split('\n').map(JSON.parse);
  assert.equal(header.value.parentCommit, sha);
  assert.equal(file.value.path, `contributions/202610/${id}.json`);
  assert.equal(file.value.encoding, 'base64');
  assert.equal(provider.commits[0].options.headers['Content-Type'], 'application/x-ndjson');
  for (const { url, options } of provider.calls) {
    assert.equal(new URL(url).origin, 'https://huggingface.co');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Bearer ${env.CONTRIBUTIONS_HF_TOKEN}`);
    assert.equal(url.includes(env.CONTRIBUTIONS_HF_TOKEN), false);
    assert.ok(options.signal instanceof AbortSignal);
  }
  for (const options of [{ privateRepo: false }, { infoSha: 'invalid' }]) {
    const unsafe = fixture(options);
    await assert.rejects(unsafe.store.submit({ id, text: 'artist' }), code('UNAVAILABLE'));
    assert.equal(unsafe.calls.length, 1); assert.equal(unsafe.commits.length, 0);
  }
});

test('submit is idempotent across months and statuses but refuses UUID text conflicts', async () => {
  const completed = record({ submittedUtc: '2026-09-30T23:00:00.000Z', status: 'completed', result: result() });
  const provider = fixture({ records: [completed] });
  assert.deepEqual(await provider.store.submit({ id, text: completed.text }), { id, saved: true });
  assert.deepEqual(await provider.store.get(id.toUpperCase()), completed);
  assert.equal(await provider.store.get(secondId), null);
  await assert.rejects(provider.store.submit({ id, text: 'Different artist.' }), code('ID_CONFLICT'));
  assert.equal(provider.commits.length, 0);
});

test('missing contribution directory is an empty pending list and first submit writes one JSON file', async () => {
  const provider = fixture({ treeResponse: async () => new Response('', { status: 404 }) });
  assert.deepEqual(await provider.store.pending(), []);
  assert.equal(await provider.store.get(id), null);
  assert.deepEqual(await provider.store.submit({ id, text: 'artist' }), { id, saved: true });
  assert.equal(provider.latest().length, 1);
});

test('pending returns FIFO queued and expired leases only, bounded to the requested limit', async () => {
  const old = '2026-10-06T12:00:00.000Z';
  const values = [
    record({ id: '10b0baf4-2d28-4781-9a4a-3d8f036e8cd2', submittedUtc: old, updatedUtc: old, status: 'processing', lease: { owner: 'lost-worker', until: '2026-10-06T12:07:00.000Z' } }),
    record({ id: secondId }),
    record(),
    record({ id: '40b0baf4-2d28-4781-9a4a-3d8f036e8cd2', status: 'processing', lease: { owner: 'live-worker', until: '2026-10-07T12:07:00.000Z' } }),
    record({ id: '50b0baf4-2d28-4781-9a4a-3d8f036e8cd2', status: 'needs-review', result: result({ artistStatus: 'needs-review' }) }),
    record({ id: '60b0baf4-2d28-4781-9a4a-3d8f036e8cd2', status: 'rejected', result: result({ artistStatus: 'rejected' }) }),
  ];
  const provider = fixture({ records: values.toReversed() });
  assert.deepEqual((await provider.store.pending()).map(value => value.id), [values[0].id, id, secondId]);
  assert.deepEqual((await provider.store.pending({ limit: 2 })).map(value => value.id), [values[0].id, id]);
  assert.equal(provider.commits.length, 0);
  for (const limit of [0, -1, 51, 1.5, '10']) await assert.rejects(provider.store.pending({ limit }), code('INVALID_UPDATE'));
});

test('claim installs a seven-minute lease atomically and cannot take a live or terminal record', async () => {
  const provider = fixture({ records: [record()] });
  const claimed = await provider.store.claim(id, { owner: 'worker-one' });
  assert.deepEqual(claimed, record({ status: 'processing', lease: { owner: 'worker-one', until: '2026-10-07T12:07:00.000Z' } }));
  assert.equal(await provider.store.claim(id, { owner: 'worker-two' }), null);
  assert.equal(await provider.store.claim(id, { owner: 'worker-one' }), null);
  assert.equal(await provider.store.claim(secondId, { owner: 'worker-one' }), null);
  assert.equal(provider.commits.length, 1);
  for (const options of [{}, { owner: '' }, { owner: 'bad owner' }, { owner: 'x'.repeat(121) }, { owner: 'worker', leaseMs: 0 }, { owner: 'worker', leaseMs: 420001 }]) await assert.rejects(provider.store.claim(id, options), code('INVALID_UPDATE'));
  const terminal = fixture({ records: [record({ status: 'completed', result: result() })] });
  assert.equal(await terminal.store.claim(id, { owner: 'worker' }), null);
  assert.equal(terminal.commits.length, 0);
});

test('expired lease is recoverable and its former owner cannot update the new claim', async () => {
  let time = Date.parse(now);
  const provider = fixture({ records: [record()], clock: () => new Date(time) });
  await provider.store.claim(id, { owner: 'worker-old', leaseMs: 1000 });
  time += 1000;
  assert.equal((await provider.store.pending())[0].id, id);
  await assert.rejects(provider.store.update(id, { status: 'completed', result: result() }, { owner: 'worker-old' }), code('LEASE_LOST'));
  const renewed = await provider.store.claim(id, { owner: 'worker-new' });
  assert.equal(renewed.lease.owner, 'worker-new');
  await assert.rejects(provider.store.update(id, { status: 'completed', result: result() }, { owner: 'worker-old' }), code('LEASE_LOST'));
  const complete = await provider.store.update(id, { status: 'completed', result: result() }, { owner: 'worker-new' });
  assert.equal(complete.status, 'completed'); assert.equal(complete.lease, null);
  assert.deepEqual(complete.result, result());
  assert.equal((await provider.store.pending()).length, 0);
});

test('two Spaces racing for one record obtain at most one lease without commit retries', async () => {
  const reached = deferred(); let trees = 0;
  const provider = fixture({ records: [record()], treeResponse: async () => { if (++trees === 2) reached.resolve(); await reached.promise; return json([entry(record())]); } });
  const results = await Promise.all([provider.store.claim(id, { owner: 'space-one' }), provider.store.claim(id, { owner: 'space-two' })]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(provider.commits.length, 2);
  assert.equal(provider.latest()[0].lease.owner, 'space-one');
  for (const commit of provider.commits) assert.equal(JSON.parse(commit.options.body.split('\n')[0]).value.parentCommit, sha);
});

test('only the current live owner can checkpoint or finish, and immutable fields cannot be patched', async () => {
  let time = Date.parse(now);
  const provider = fixture({ records: [record()], clock: () => new Date(time) });
  await provider.store.claim(id, { owner: 'worker' });
  const progress = result({ message: 'Checking this event.', artistStatus: 'existing', eventStatus: 'pending' });
  time += 1000;
  const checkpoint = await provider.store.update(id, { result: progress }, { owner: 'worker' });
  assert.equal(checkpoint.status, 'processing'); assert.equal(checkpoint.lease.owner, 'worker');
  assert.equal(checkpoint.updatedUtc, '2026-10-07T12:00:01.000Z');
  await assert.rejects(provider.store.update(id, { status: 'completed', result: result() }, { owner: 'other' }), code('LEASE_LOST'));
  for (const patch of [{}, { text: 'new text' }, { id: secondId }, { lease: null }, { updatedUtc: now }, { status: 'queued' }, { status: 'anything' }, { error: 'private-provider-error' }]) await assert.rejects(provider.store.update(id, patch, { owner: 'worker' }), code('INVALID_UPDATE'));
  const done = await provider.store.update(id, { status: 'completed', result: result({ eventStatus: 'merged' }) }, { owner: 'worker' });
  assert.equal(done.lease, null); assert.equal(done.result.eventStatus, 'merged');
  await assert.rejects(provider.store.update(id, { result: result() }, { owner: 'worker' }), code('LEASE_LOST'));
});

test('terminal results require allowlisted statuses and bounded public text with no credential fields', async () => {
  const provider = fixture({ records: [record()] }); await provider.store.claim(id, { owner: 'worker' });
  await assert.rejects(provider.store.update(id, { status: 'completed', result: null }, { owner: 'worker' }), code('INVALID_UPDATE'));
  for (const value of [
    {}, result({ message: '' }), result({ message: 'x'.repeat(1001) }), result({ message: 'a\nsecret' }),
    result({ message: env.CONTRIBUTIONS_HF_TOKEN }), result({ message: 'sk-projectSensitiveToken0123456789' }),
    result({ artistStatus: 'anything' }), result({ eventStatus: 'unverified' }), result({ artistName: 'x'.repeat(121) }),
    result({ token: 'private' }), result({ error: 'private-provider-error' }), result({ audio: 'raw' }),
  ]) await assert.rejects(provider.store.update(id, { status: 'completed', result: value }, { owner: 'worker' }), code('INVALID_UPDATE'));
  const accepted = result({ artistName: 'Café Artist', sourceUrls: ['https://artist.example/music', 'https://venue.example/events?date=2026-10-07'] });
  assert.deepEqual((await provider.store.update(id, { status: 'needs-review', result: accepted }, { owner: 'worker' })).result, accepted);
});

test('result source URLs reject insecure/local targets and credential-bearing query keys', async () => {
  const provider = fixture({ records: [record()] }); await provider.store.claim(id, { owner: 'worker' });
  const unsafe = ['http://example.com/event', 'https://user:pass@example.com/event', 'https://localhost/event', 'https://foo.local/event', 'https://metadata.google.internal/', 'https://127.0.0.1/', 'https://10.1.2.3/', 'https://172.16.1.1/', 'https://192.168.1.1/', 'https://169.254.169.254/', 'https://[::1]/', 'https://[fc00::1]/', 'https://example.com/event#token', 'https://example.com/?access_token=secret', 'https://example.com/?ApiKey=secret', 'https://example.com/?authorization=secret', 'https://example.com/?secret=secret'];
  for (const url of unsafe) await assert.rejects(provider.store.update(id, { result: result({ sourceUrls: [url] }) }, { owner: 'worker' }), code('INVALID_UPDATE'));
  await assert.rejects(provider.store.update(id, { result: result({ sourceUrls: Array(11).fill('https://example.com/') }) }, { owner: 'worker' }), code('INVALID_UPDATE'));
  await assert.rejects(provider.store.update(id, { result: result({ sourceUrls: ['https://example.com/', 'https://example.com/'] }) }, { owner: 'worker' }), code('INVALID_UPDATE'));
});

test('update CAS conflict loses the lease without overwriting or retrying', async () => {
  const processing = record({ status: 'processing', lease: { owner: 'worker', until: '2026-10-07T12:07:00.000Z' } });
  const provider = fixture({ records: [processing], commitResponse: async () => json({ error: 'sensitive parent changed' }, { status: 409 }) });
  await assert.rejects(provider.store.update(id, { status: 'completed', result: result() }, { owner: 'worker' }), code('LEASE_LOST'));
  assert.equal(provider.commits.length, 1); assert.deepEqual(provider.latest(), [processing]);
});

test('an in-flight former owner cannot overwrite a claim taken after its lease expired', async () => {
  let time = Date.parse(now);
  const started = deferred(), release = deferred();
  const processing = record({ status: 'processing', lease: { owner: 'old-attempt', until: '2026-10-07T12:00:01.000Z' } });
  const provider = fixture({ records: [processing], clock: () => new Date(time), commitResponse: async (url, options, commit) => {
    const value = JSON.parse(Buffer.from(JSON.parse(options.body.trim().split('\n')[1]).value.content, 'base64').toString('utf8'));
    if (value.status === 'completed') { started.resolve(); await release.promise; }
    return commit(options);
  } });
  const finishing = provider.store.update(id, { status: 'completed', result: result() }, { owner: 'old-attempt' });
  const rejected = assert.rejects(finishing, code('LEASE_LOST'));
  await started.promise; time += 1000;
  const claimed = await provider.store.claim(id, { owner: 'new-attempt' });
  release.resolve(); await rejected;
  assert.equal(claimed.lease.owner, 'new-attempt');
  assert.equal(provider.latest()[0].lease.owner, 'new-attempt');
  assert.equal(provider.latest()[0].status, 'processing');
  assert.equal(provider.commits.length, 2);
});

test('immutable tree oid cache avoids rereading completed records and invalidates changed processing records', async () => {
  const completed = record({ status: 'completed', result: result({ sourceUrls: ['https://artist.example/'] }) });
  const provider = fixture({ records: [completed, record({ id: secondId })], treeOids: true });
  const reads = () => provider.calls.filter(call => call.url.includes('/resolve/')).length;
  const first = await provider.store.pending();
  assert.deepEqual(first.map(value => value.id), [secondId]); assert.equal(reads(), 2);
  first[0].text = 'caller mutation';
  const terminal = await provider.store.get(id); terminal.result.sourceUrls[0] = 'https://malicious.example/';
  assert.equal((await provider.store.get(id)).result.sourceUrls[0], 'https://artist.example/');
  assert.equal((await provider.store.pending())[0].text, 'Please add this artist.');
  assert.equal(reads(), 2);
  await provider.store.claim(secondId, { owner: 'worker' });
  assert.deepEqual(await provider.store.pending(), []);
  assert.equal(reads(), 3, 'changed processing oid forces a fresh read');
  await provider.store.pending(); assert.equal(reads(), 3);
  await provider.store.update(secondId, { status: 'completed', result: result() }, { owner: 'worker' });
  assert.deepEqual(await provider.store.pending(), []); assert.equal(reads(), 4);
  await provider.store.pending(); assert.equal(reads(), 4, 'unchanged terminal records read once');
  const noOids = fixture({ records: [record()] });
  await noOids.store.pending(); await noOids.store.pending();
  assert.equal(noOids.calls.filter(call => call.url.includes('/resolve/')).length, 2);
});

test('tree/resolve redirects are constrained to the exact HF snapshot and never forward the token externally', async () => {
  const next = `${api}/tree/${sha}/contributions?recursive=true&cursor=second`;
  const provider = fixture({ records: [record()], treeResponse: async url => url === tree ? json([], { headers: { Link: `<${next}>; rel="next"` } }) : json([entry(record())]) });
  assert.equal((await provider.store.get(id)).id, id);
  for (const destination of ['https://evil.example/steal?recursive=true', `${api}/tree/main/contributions?recursive=true`]) {
    const unsafe = fixture({ treeResponse: async () => json([], { headers: { Link: `<${destination}>; rel="next"` } }) });
    await assert.rejects(unsafe.store.get(id), code('UNAVAILABLE')); assert.equal(unsafe.calls.length, 2);
  }
  const base = fixture({ records: [record()] });
  const cache = `https://huggingface.co/api/resolve-cache/datasets/${env.CONTRIBUTIONS_HF_REPO}/${sha}/${pathFor(record())}`;
  const store = createContributionsStore({ env, fetchImpl: async (url, options) => url.includes('/resolve/') ? new Response(null, { status: 307, headers: { Location: cache } }) : url === cache ? json(record()) : base.fetchImpl(url, options) });
  assert.equal((await store.get(id)).id, id);
  let calls = 0;
  const unsafe = createContributionsStore({ env, fetchImpl: async (url, options) => { calls++; return url.includes('/resolve/') ? new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal' } }) : base.fetchImpl(url, options); } });
  await assert.rejects(unsafe.get(id), code('UNAVAILABLE')); assert.equal(calls, 3);
});

test('malformed stored states, leaked result fields, duplicate IDs and oversize responses fail closed', async () => {
  for (const invalid of [record({ status: 'other' }), record({ status: 'processing', lease: null }), record({ status: 'processing', lease: { until: '2026-10-07T12:07:00.000Z' } }), record({ status: 'completed', result: null }), record({ status: 'queued', result: result() }), record({ audio: 'raw' }), record({ updatedUtc: '2026-09-01T00:00:00.000Z' }), record({ text: ' leading ' })]) {
    const provider = fixture({ records: [invalid] }); await assert.rejects(provider.store.get(id), code('UNAVAILABLE'));
  }
  const duplicate = fixture({ treeResponse: async () => json([entry(record()), entry(record({ submittedUtc: '2026-09-01T00:00:00.000Z' }))]) });
  await assert.rejects(duplicate.store.get(id), code('UNAVAILABLE'));
  const oversized = createContributionsStore({ env, fetchImpl: async () => new Response('x', { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }) });
  await assert.rejects(oversized.pending(), code('UNAVAILABLE'));
});

test('capacity prevents new records while saved UUIDs remain idempotent', async () => {
  const values = Array.from({ length: 2000 }, (_, index) => record({ id: `${index.toString(16).padStart(8, '0')}-2d28-4781-9a4a-3d8f036e8cd2` }));
  const provider = fixture({ records: values });
  await assert.rejects(provider.store.submit({ id, text: 'new' }), code('LIMIT_EXCEEDED')); assert.equal(provider.commits.length, 0);
  assert.deepEqual(await provider.store.submit({ id: values[0].id, text: values[0].text }), { id: values[0].id, saved: true });
  const overflow = fixture({ treeResponse: async () => json([...values.map(entry), entry(record())]) });
  await assert.rejects(overflow.store.pending(), code('LIMIT_EXCEEDED')); assert.equal(overflow.calls.length, 2);
});

test('provider failures and unconfirmed commits are sanitized and never retried', async () => {
  for (const commitResponse of [async () => { throw new Error('private-provider ' + env.CONTRIBUTIONS_HF_TOKEN); }, async () => json({ error: 'sensitive' }, { status: 403 }), async () => json({ success: false, commitOid: sha }), async () => json({ success: true, commitOid: 'invalid' }), async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } })]) {
    const provider = fixture({ commitResponse });
    await assert.rejects(provider.store.submit({ id, text: 'artist' }), code('UNAVAILABLE'));
    assert.equal(provider.commits.length, 1); assert.deepEqual(provider.latest(), []);
  }
});

test('cancellation and deadlines prevent later commits even when an injected provider ignores the signal', async () => {
  const active = new AbortController(), started = deferred(), response = deferred(); let calls = 0;
  const store = createContributionsStore({ env, fetchImpl: async () => { calls++; started.resolve(); return response.promise; } });
  const waiting = store.submit({ id, text: 'artist' }, { signal: active.signal });
  const rejected = assert.rejects(waiting, code('CANCELLED'));
  await started.promise; active.abort(); await rejected;
  response.resolve(json({ private: true, sha })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  const timeout = createContributionsStore({ env, timeoutMs: 5, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(timeout.pending(), code('UNAVAILABLE'));
  const cancelled = new AbortController(); cancelled.abort();
  const provider = fixture();
  await assert.rejects(provider.store.claim(id, { owner: 'worker', signal: cancelled.signal }), code('CANCELLED'));
  assert.equal(provider.calls.length, 0);
});
