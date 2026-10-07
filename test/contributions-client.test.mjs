import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initContributions } from '../public/browser/contributions.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });

class Element {
  constructor() { this.listeners = new Map(); this.value = ''; this.textContent = ''; this.attributes = {}; this.classList = { toggle() {} }; this.open = false; }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  fire(name) { return Promise.all([...this.listeners.get(name) ?? []].map(callback => callback({ preventDefault() {} }))); }
  setAttribute(name, value) { this.attributes[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; void this.fire('close'); }
  focus() { this.focused = true; }
}

function page({ post, get, voice = false, transcript = 'DJ Example at Example Venue on October 10.' } = {}) {
  const nodes = new Map(['open', 'dialog', 'record', 'stop', 'text', 'status', 'submit', 'cancel'].map(name => [name, new Element()]));
  const calls = [], contexts = [], voiceCalls = [], transcription = [], timers = new Map();
  let elapsed = 0, nextTimer = 0, uuid = 0, lastId;
  const stream = { stops: 0, getTracks() { return [{ stop: () => { stream.stops++; } }]; } };
  const audioNode = () => ({ connect() {}, disconnect() {} });
  class AudioContext {
    constructor() { this.sampleRate = 16000; this.destination = {}; this.closed = false; contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    createMediaStreamSource() { return audioNode(); }
    createGain() { return { ...audioNode(), gain: { value: 1 } }; }
    createScriptProcessor() { return this.processor = audioNode(); }
    samples() { this.processor.onaudioprocess({ inputBuffer: { length: 1600, numberOfChannels: 1, getChannelData: () => new Float32Array(1600).fill(.2) } }); }
  }
  const window = new Element();
  window.navigator = voice ? { mediaDevices: { async getUserMedia(options) { voiceCalls.push(options); return stream; } } } : {};
  window.AudioContext = voice ? AudioContext : undefined;
  window.AbortController = AbortController;
  window.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: elapsed + delay }); return id; };
  window.clearTimeout = id => timers.delete(id);
  window.fetch = async (url, options) => {
    const call = { url, options, ...(options.body ? { body: JSON.parse(options.body) } : {}) }; calls.push(call);
    if (options.method === 'POST') { lastId = call.body.id; return post ? post(call) : response({ ok: true, id: lastId, status: 'queued' }, 202); }
    return get ? get(call) : response({ id: lastId, status: 'queued' });
  };
  const app = initContributions({ getElementById: id => nodes.get(id.replace('contribution-', '')) }, window, {
    now: () => elapsed,
    createId: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    transcribeFeedback: async (audio, options) => { transcription.push({ samples: Array.from(audio), options }); return transcript; },
  });
  const advance = async milliseconds => {
    elapsed += milliseconds;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= elapsed).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); due[1].callback(); await tick();
    }
    await tick();
  };
  const type = async text => { nodes.get('text').value = text; await nodes.get('text').fire('input'); };
  return { app, nodes, calls, timers, contexts, voiceCalls, transcription, stream, advance, type, click: name => nodes.get(name).fire('click'), window };
}

test('feedback is visible near the top and the missing-artist button is directly beside the search label', async () => {
  const html = await readFile(new URL('../public/browser/index.html', import.meta.url), 'utf8');
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.match(header, /id="feedback-open"[^>]*>Give feedback/);
  assert.equal((html.match(/id="feedback-open"/g) || []).length, 1);
  assert.match(html, /<div class="search-label"><label for="city">Location or artist<\/label><button id="contribution-open"/);
  assert.match(html, /contribution-text"[^>]*maxlength="2000"/);
  assert.match(html, /id="contribution-dialog"[^>]*aria-describedby="contribution-intro"/);
  assert.match(html, /\/browser\/contributions\.js/);
});

test('voice contribution stays editable and sends only reviewed text and UUID after explicit Send', async () => {
  const view = page({ voice: true, get: call => response({ id: call.url.split('/').at(-1), status: 'completed', message: 'Artist and show details updated.' }) });
  await view.click('open'); assert.equal(view.voiceCalls.length, 0); assert.equal(view.transcription.length, 0); assert.equal(view.calls.length, 0);
  await view.click('record'); view.contexts[0].samples(); await view.click('stop');
  assert.equal(view.stream.stops, 1); assert.equal(view.contexts[0].closed, true); assert.equal(view.transcription.length, 1);
  assert.equal(view.nodes.get('text').disabled, false); assert.equal(view.calls.length, 0);
  await view.type('DJ Corrected, Oct 10, Example Venue. https://tickets.example/show');
  const sending = view.click('submit'); await tick();
  assert.equal(view.calls.length, 1); assert.equal(view.calls[0].url, '/api/browser/contributions');
  assert.deepEqual(Object.keys(view.calls[0].body).sort(), ['id', 'text']);
  assert.equal(view.calls[0].body.text, 'DJ Corrected, Oct 10, Example Venue. https://tickets.example/show');
  assert.match(view.nodes.get('status').textContent, /saved.*completion is not confirmed yet/);
  assert.equal(view.nodes.get('dialog').attributes['aria-busy'],'false');
  await view.advance(5000); await sending;
  assert.equal(view.calls[1].options.method, 'GET'); assert.equal(view.calls[1].options.body, undefined);
  assert.match(view.nodes.get('status').textContent, /Submission processed.*details updated/);
  assert.equal(view.nodes.get('text').value, view.calls[0].body.text);
  view.app.destroy();
});

test('save is confirmed only by a matching UUID and HTTP 202 queued acknowledgement', async () => {
  for (const invalid of [call => response({ ok: true, id: call.body.id, status: 'queued' }, 200), call => response({ ok: true, id: call.body.id }, 202), () => response({ ok: true, id: 'wrong', status: 'queued' }, 202)]) {
    const view = page({ post: invalid }); await view.type('DJ Example, missing artist.'); await view.click('submit');
    assert.match(view.nodes.get('status').textContent, /Save not confirmed/); assert.equal(view.nodes.get('text').value, 'DJ Example, missing artist.');
    await view.click('submit'); assert.deepEqual(view.calls[0].body, view.calls[1].body); assert.ok(view.calls.every(call => call.options.method === 'POST'));
    view.app.destroy();
  }
});

test('closing pauses polling and preserves the draft and UUID for an explicit retry', async () => {
  let checks = 0;
  const view = page({ get: call => response({ id: call.url.split('/').at(-1), status: ++checks === 1 ? 'processing' : 'needs-review', message: 'More event details are needed.' }) });
  await view.type('DJ Example.'); const first = view.click('submit'); await tick(); await view.advance(5000);
  assert.match(view.nodes.get('status').textContent, /Processing.*completion is not confirmed/);
  await view.click('cancel'); await first;
  assert.match(view.nodes.get('status').textContent, /saved.*paused.*draft is kept/); assert.equal(view.timers.size, 0);
  await view.click('open'); const retry = view.click('submit'); await tick();
  const posts = view.calls.filter(call => call.options.method === 'POST'); assert.deepEqual(posts[0].body, posts[1].body);
  await view.advance(5000); await retry;
  assert.match(view.nodes.get('status').textContent, /saved and needs review.*More event details/);
  assert.equal(view.nodes.get('text').value, 'DJ Example.');
  await view.type('DJ Example, Oct 10 in Dallas.'); const edited = view.click('submit'); await tick(); await view.click('cancel'); await edited;
  assert.notEqual(view.calls.filter(call => call.options.method === 'POST').at(-1).body.id, posts[0].body.id);
  view.app.destroy();
});

test('status failure preserves the confirmed save and draft without claiming artist or show addition', async () => {
  const view = page({ get: () => response({ error: 'Private provider detail' }, 503) });
  await view.type('DJ Example.'); const sending = view.click('submit'); await tick(); await view.advance(5000); await sending;
  assert.match(view.nodes.get('status').textContent, /Submission saved.*Progress could not be checked/);
  assert.doesNotMatch(view.nodes.get('status').textContent, /Private provider|added|processed/);
  assert.equal(view.nodes.get('text').value, 'DJ Example.'); assert.equal(view.nodes.get('submit').disabled, false);
  view.app.destroy();
});

test('a Space outage during a saved-receipt retry preserves the known saved status and stable UUID', async () => {
  let posts=0;
  const view=page({post:call=>++posts===2?response({},503):response({ok:true,id:call.body.id,status:'queued'},202),get:()=>response({},503)});
  await view.type('DJ Example.');const first=view.click('submit');await tick();await view.advance(5000);await first;
  assert.match(view.nodes.get('status').textContent,/Submission saved/);
  await view.click('submit');assert.match(view.nodes.get('status').textContent,/Submission saved.*Progress could not be checked/);
  assert.doesNotMatch(view.nodes.get('status').textContent,/Save not confirmed/);
  const posted=view.calls.filter(call=>call.options.method==='POST');assert.deepEqual(posted[0].body,posted[1].body);
  assert.equal(view.nodes.get('text').value,'DJ Example.');view.app.destroy();
});

test('Escape during contribution recording stops the microphone, keeps the draft and returns focus to its opener', async () => {
  const view=page({voice:true});await view.type('Draft artist details.');await view.click('open');await view.click('record');view.contexts[0].samples();
  assert.equal(view.nodes.get('dialog').attributes['aria-busy'],'false');await view.nodes.get('dialog').fire('cancel');
  assert.equal(view.stream.stops,1);assert.equal(view.contexts[0].closed,true);assert.equal(view.nodes.get('dialog').open,false);
  assert.equal(view.nodes.get('open').focused,true);assert.equal(view.nodes.get('text').value,'Draft artist details.');assert.equal(view.calls.length,0);assert.equal(view.transcription.length,0);assert.equal(view.timers.size,0);view.app.destroy();
});

test('processing outcomes preserve artist names containing the word Feedback', async () => {
  const view=page({get:call=>response({id:call.url.split('/').at(-1),status:'completed',message:'DJ Feedback is already in the artist list.'})});
  await view.type('DJ Feedback.');const sending=view.click('submit');await tick();await view.advance(5000);await sending;
  assert.equal(view.nodes.get('status').textContent,'Submission processed. DJ Feedback is already in the artist list.');view.app.destroy();
});

test('rejected submissions show their review outcome, while a status for another UUID cannot confirm completion', async () => {
  for (const mismatch of [false, true]) {
    const view = page({ get: call => response({ id: mismatch ? 'another-id' : call.url.split('/').at(-1), status: mismatch ? 'completed' : 'rejected', message: 'No verifiable event information was found.' }) });
    await view.type('DJ Example.'); const sending = view.click('submit'); await tick(); await view.advance(5000); await sending;
    assert.match(view.nodes.get('status').textContent, mismatch ? /saved.*Progress could not be checked/ : /Submission rejected.*No verifiable event information/);
    assert.doesNotMatch(view.nodes.get('status').textContent, /Submission processed/); assert.equal(view.nodes.get('text').value, 'DJ Example.'); view.app.destroy();
  }
});

test('polling stops after three minutes with honest pending status and no extra submission', async () => {
  const view = page(); await view.type('DJ Example.'); const sending = view.click('submit'); await tick();
  for (let i = 0; i < 36; i++) await view.advance(5000);
  await sending; assert.equal(view.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(view.calls.filter(call => call.options.method === 'GET').length, 35);
  assert.equal(view.timers.size, 0); assert.match(view.nodes.get('status').textContent, /saved.*still pending.*draft is kept/);
  view.app.destroy();
});

test('cancel during status fetch aborts it and a late completion cannot change the draft or paused status', async () => {
  const pending = deferred(); const view = page({ get: () => pending.promise });
  await view.type('DJ Example.'); const sending = view.click('submit'); await tick(); await view.advance(5000);
  const check = view.calls.at(-1); await view.click('cancel'); await sending;
  assert.equal(check.options.signal.aborted, true); const message = view.nodes.get('status').textContent;
  pending.resolve(response({ id: view.calls[0].body.id, status: 'completed', message: 'Added.' })); await tick();
  assert.equal(view.nodes.get('status').textContent, message); assert.equal(view.nodes.get('text').value, 'DJ Example.'); assert.equal(view.timers.size, 0);
  view.app.destroy();
});

test('a stalled status request is bounded and contribution text over 2000 characters never sends', async () => {
  const view = page({ get: () => new Promise(() => {}) });
  await view.type('x'.repeat(2001)); await view.click('submit'); assert.equal(view.calls.length, 0); assert.match(view.nodes.get('status').textContent, /too long/);
  await view.type('DJ Example.'); const sending = view.click('submit'); await tick(); await view.advance(5000); await view.advance(15000); await sending;
  assert.equal(view.calls.at(-1).options.signal.aborted, true); assert.match(view.nodes.get('status').textContent, /saved.*Progress could not be checked/);
  assert.equal(view.nodes.get('text').value, 'DJ Example.'); view.app.destroy();
});
