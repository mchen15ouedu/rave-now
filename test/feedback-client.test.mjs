import test from 'node:test';
import assert from 'node:assert/strict';
import { initFeedback } from '../public/browser/feedback.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class Element {
  constructor() {
    this.listeners = new Map();
    this.value = '';
    this.textContent = '';
    this.attributes = {};
    this.classList = { toggle() {} };
    this.open = false;
  }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  async fire(name) {
    return Promise.all([...this.listeners.get(name) ?? []].map((handler) => handler({ preventDefault() {} })));
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  showModal() { this.open = true; }
  close() { this.open = false; void this.fire('close'); }
  focus() { this.focused = true; }
}

function page({ sampleRate = 16_000, microphone, transcribe, fetchResult, supported = true } = {}) {
  const nodes = new Map(['open', 'dialog', 'record', 'stop', 'text', 'status', 'submit', 'cancel'].map((name) => [name, new Element()]));
  const calls = [], audioCalls = [], mediaCalls = [], contexts = [], timers = new Map();
  let elapsed = 0, timerId = 0, uuid = 0;
  const track = { stops: 0, stop() { this.stops += 1; } };
  const stream = { getTracks: () => [track] };
  function audioNode() {
    return { connections: [], disconnects: 0, connect(node) { this.connections.push(node); }, disconnect() { this.disconnects += 1; } };
  }
  class AudioContext {
    constructor(options) {
      this.requested = options;
      this.sampleRate = sampleRate;
      this.destination = {};
      this.closed = 0;
      contexts.push(this);
    }
    resume() { this.resumed = true; return Promise.resolve(); }
    close() { this.closed += 1; return Promise.resolve(); }
    createMediaStreamSource(value) { this.stream = value; this.source = audioNode(); return this.source; }
    createScriptProcessor(...args) { this.processorArgs = args; this.processor = audioNode(); return this.processor; }
    createGain() { this.mute = { ...audioNode(), gain: { value: 1 } }; return this.mute; }
    samples(...channels) {
      this.processor.onaudioprocess?.({ inputBuffer: {
        length: channels[0].length,
        numberOfChannels: channels.length,
        getChannelData: (channel) => channels[channel],
      } });
    }
  }
  const window = new Element();
  window.navigator = supported ? { mediaDevices: { async getUserMedia(options) {
    mediaCalls.push(options);
    return microphone ? microphone(stream) : stream;
  } } } : {};
  window.AudioContext = supported ? AudioContext : undefined;
  window.AbortController = AbortController;
  window.setTimeout = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, at: elapsed + delay, delay });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.fetch = async (url, options) => {
    const call = { url, options, body: JSON.parse(options.body) };
    calls.push(call);
    return fetchResult ? fetchResult(call) : { ok: true, json: async () => ({ ok: true, id: call.body.id }) };
  };
  const app = initFeedback({ getElementById: (id) => nodes.get(id.replace('feedback-', '')) }, window, {
    createId: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    transcribeFeedback: async (audio, options) => {
      audioCalls.push({ audio: Array.from(audio), options });
      return transcribe ? transcribe(audio, options) : 'The show listing is missing a venue.';
    },
  });
  const advance = async (milliseconds) => {
    elapsed += milliseconds;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= elapsed).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
      await tick();
    }
    await tick();
  };
  const type = async (value) => { nodes.get('text').value = value; await nodes.get('text').fire('input'); };
  const click = (name) => nodes.get(name).fire('click');
  return { app, nodes, calls, audioCalls, mediaCalls, contexts, track, stream, timers, advance, type, click, window };
}

test('opening feedback does not request microphone access, load transcription, or send anything', async () => {
  const view = page();
  await view.click('open');
  assert.equal(view.nodes.get('dialog').open, true);
  assert.equal(view.nodes.get('text').focused, true);
  assert.equal(view.mediaCalls.length, 0);
  assert.equal(view.contexts.length, 0);
  assert.equal(view.audioCalls.length, 0);
  assert.equal(view.calls.length, 0);
});

test('typed feedback sends only trimmed text and a UUID after the explicit Send click', async () => {
  const view = page({ supported: false });
  assert.equal(view.nodes.get('record').disabled, true);
  assert.match(view.nodes.get('status').textContent, /Type your feedback/);
  await view.type('  Please show ticket prices.  ');
  assert.equal(view.calls.length, 0);
  await view.click('submit');
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0].url, '/api/browser/feedback');
  assert.equal(view.calls[0].options.method, 'POST');
  assert.equal(view.calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(Object.keys(view.calls[0].body).sort(), ['id', 'text']);
  assert.match(view.calls[0].body.id, /^[0-9a-f-]{36}$/);
  assert.equal(view.calls[0].body.text, 'Please show ticket prices.');
  assert.equal(view.nodes.get('text').value, '');
  assert.match(view.nodes.get('status').textContent, /Feedback saved/);
  assert.equal(view.mediaCalls.length, 0);
});

test('empty feedback is not sent', async () => {
  const view = page();
  await view.type(' \n ');
  assert.equal(view.nodes.get('submit').disabled, true);
  await view.click('submit');
  assert.equal(view.calls.length, 0);
});

test('voice recording uses muted Web Audio and stops all capture resources before transcription', async () => {
  const view = page();
  await view.type('Existing draft.');
  await view.click('record');
  assert.deepEqual(view.mediaCalls, [{ audio: { channelCount: 1 }, video: false }]);
  const context = view.contexts[0];
  assert.deepEqual(context.requested, { sampleRate: 16_000 });
  assert.equal(context.mute.gain.value, 0);
  assert.equal(view.nodes.get('text').disabled, true);
  context.samples(new Float32Array([0.25, 0.5, -0.5, -0.25]));
  await view.click('stop');
  assert.equal(view.track.stops, 1);
  assert.equal(context.closed, 1);
  assert.equal(context.source.disconnects, 1);
  assert.equal(context.processor.disconnects, 1);
  assert.equal(context.mute.disconnects, 1);
  assert.equal(context.processor.onaudioprocess, null);
  assert.deepEqual(view.audioCalls[0].audio, [0.25, 0.5, -0.5, -0.25]);
  assert.equal(view.nodes.get('text').value, 'Existing draft.\nThe show listing is missing a venue.');
  assert.equal(view.nodes.get('text').disabled, false);
  assert.equal(view.calls.length, 0);
  assert.match(view.nodes.get('status').textContent, /Review and edit/);
  assert.equal(view.timers.size, 0);
});

test('stereo input is mixed to mono and actual 48 kHz samples are resampled to 16 kHz', async () => {
  const view = page({ sampleRate: 48_000 });
  await view.click('record');
  view.contexts[0].samples(new Float32Array([0.6, 0.6, 0.6, 0.3, 0.3, 0.3]), new Float32Array([0, 0, 0, -0.3, -0.3, -0.3]));
  await view.click('stop');
  assert.equal(view.audioCalls[0].audio.length, 2);
  assert.ok(Math.abs(view.audioCalls[0].audio[0] - 0.3) < 0.00001);
  assert.equal(view.audioCalls[0].audio[1], 0);
});

test('Whisper string progress and object percentage progress update the dialog safely', async () => {
  const pending = deferred();
  const view = page({ transcribe: () => pending.promise });
  await view.click('record');
  view.contexts[0].samples(new Float32Array([0.25]));
  const stop = view.click('stop');
  await tick();
  const { onProgress } = view.audioCalls[0].options;
  onProgress('Downloading voice model…');
  assert.equal(view.nodes.get('status').textContent, 'Downloading voice model…');
  onProgress({ progress: 45 });
  assert.equal(view.nodes.get('status').textContent, 'Preparing voice transcription… 45%');
  onProgress({ message: 'Preparing the downloaded voice model…' });
  assert.equal(view.nodes.get('status').textContent, 'Preparing the downloaded voice model…');
  onProgress('<img src=x onerror=alert(1)>');
  assert.equal(view.nodes.get('status').textContent, '<img src=x onerror=alert(1)>');
  pending.resolve('A usable transcript.');
  await stop;
});

test('oversized typed feedback is blocked before a request and can be shortened to the limit', async () => {
  const view = page();
  await view.type('x'.repeat(2_001));
  assert.match(view.nodes.get('status').textContent, /too long \(2,001\/2,000 characters\)/);
  assert.equal(view.nodes.get('submit').disabled, true);
  await view.click('submit');
  assert.equal(view.calls.length, 0);
  assert.equal(view.nodes.get('text').value.length, 2_001);
  await view.type('x'.repeat(2_000));
  assert.equal(view.nodes.get('submit').disabled, false);
  await view.click('submit');
  assert.equal(view.calls[0].body.text.length, 2_000);
  assert.match(view.nodes.get('status').textContent, /Feedback saved/);
});

test('a transcript exceeding the limit stays editable and cannot be sent', async () => {
  const view = page({ transcribe: () => 'x'.repeat(2_001) });
  await view.click('record');
  view.contexts[0].samples(new Float32Array([0.25]));
  await view.click('stop');
  assert.equal(view.nodes.get('text').value.length, 2_001);
  assert.equal(view.nodes.get('text').disabled, false);
  assert.equal(view.nodes.get('submit').disabled, true);
  assert.match(view.nodes.get('status').textContent, /Shorten the text before sending/);
  await view.click('submit');
  assert.equal(view.calls.length, 0);
  await view.type('A shortened transcript.');
  await view.click('submit');
  assert.equal(view.calls[0].body.text, 'A shortened transcript.');
});

test('the combined draft and transcript must fit the 2000 character limit', async () => {
  const view = page({ transcribe: () => 'x'.repeat(1_000) });
  await view.type('y'.repeat(1_000));
  await view.click('record');
  view.contexts[0].samples(new Float32Array([0.25]));
  await view.click('stop');
  assert.equal(view.nodes.get('text').value, `${'y'.repeat(1_000)}\n${'x'.repeat(1_000)}`);
  assert.match(view.nodes.get('status').textContent, /too long \(2,001\/2,000 characters\)/);
  await view.click('submit');
  assert.equal(view.calls.length, 0);
});

test('recording stops after 60 seconds and starts local transcription', async () => {
  const view = page();
  await view.click('record');
  view.contexts[0].samples(new Float32Array([0.2, 0.3]));
  await view.advance(59_999);
  assert.equal(view.track.stops, 0);
  await view.advance(1);
  assert.equal(view.track.stops, 1);
  assert.equal(view.audioCalls.length, 1);
  assert.equal(view.calls.length, 0);
});

test('a delayed recording timer cannot capture more than 60 seconds of samples', async () => {
  const view = page({ sampleRate: 8_000 });
  await view.click('record');
  view.contexts[0].samples(new Float32Array(8_000 * 61).fill(0.25));
  await tick();
  assert.equal(view.track.stops, 1);
  assert.equal(view.audioCalls[0].audio.length, 16_000 * 60);
});

test('microphone denial keeps typed feedback usable', async () => {
  const view = page({ microphone: () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } });
  await view.type('Typed complaint.');
  await view.click('record');
  assert.match(view.nodes.get('status').textContent, /Microphone access was denied/);
  assert.equal(view.nodes.get('text').value, 'Typed complaint.');
  assert.equal(view.contexts[0].closed, 1);
  assert.equal(view.nodes.get('submit').disabled, false);
  await view.click('submit');
  assert.equal(view.calls[0].body.text, 'Typed complaint.');
});

test('cancel during microphone permission stops a late stream and preserves the draft', async () => {
  const permission = deferred();
  const view = page({ microphone: () => permission.promise });
  await view.type('Keep this draft.');
  const recording = view.click('record');
  await view.click('cancel');
  permission.resolve(view.stream);
  await recording;
  assert.equal(view.track.stops, 1);
  assert.equal(view.contexts[0].closed, 1);
  assert.equal(view.nodes.get('text').value, 'Keep this draft.');
  assert.equal(view.audioCalls.length, 0);
  assert.equal(view.calls.length, 0);
});

test('closing during recording stops the microphone and reopening retains typed text', async () => {
  const view = page();
  await view.type('Keep this draft.');
  await view.click('record');
  view.contexts[0].samples(new Float32Array([0.25]));
  await view.nodes.get('dialog').fire('cancel');
  await view.click('open');
  assert.equal(view.track.stops, 1);
  assert.equal(view.nodes.get('text').value, 'Keep this draft.');
  assert.equal(view.audioCalls.length, 0);
  assert.equal(view.timers.size, 0);
});

test('cancel during transcription aborts the worker request and ignores late text and progress', async () => {
  const pending = deferred();
  let audioBuffer;
  const view = page({ transcribe: (audio) => { audioBuffer = audio; return pending.promise; } });
  await view.type('Draft.');
  await view.click('record');
  view.contexts[0].samples(new Float32Array([0.25, 0.5]));
  const stop = view.click('stop');
  await tick();
  await view.click('cancel');
  const message = view.nodes.get('status').textContent;
  view.audioCalls[0].options.onProgress({ progress: 50 });
  view.audioCalls[0].options.onProgress('Late Whisper progress.');
  pending.resolve('Stale transcript.');
  await stop;
  assert.equal(view.audioCalls[0].options.signal.aborted, true);
  assert.equal(view.nodes.get('text').value, 'Draft.');
  assert.equal(view.nodes.get('status').textContent, message);
  assert.deepEqual(Array.from(audioBuffer), [0, 0]);
  assert.equal(view.calls.length, 0);
});

test('transcription has a hard 75 second timeout even when the transcriber ignores abort', async () => {
  const pending = deferred();
  const view = page({ transcribe: () => pending.promise });
  await view.click('record');
  view.contexts[0].samples(new Float32Array([0.25]));
  const stop = view.click('stop');
  await tick();
  await view.advance(75_000);
  await stop;
  assert.equal(view.audioCalls[0].options.signal.aborted, true);
  assert.match(view.nodes.get('status').textContent, /Transcription timed out/);
  assert.equal(view.nodes.get('text').disabled, false);
  const message = view.nodes.get('status').textContent;
  pending.resolve('Too late.');
  await tick();
  assert.equal(view.nodes.get('text').value, '');
  assert.equal(view.nodes.get('status').textContent, message);
});

test('no captured samples and unrecognized speech keep the existing typed draft', async () => {
  for (const silence of [true, false]) {
    const view = page({ transcribe: () => '' });
    await view.type('Draft.');
    await view.click('record');
    if (!silence) view.contexts[0].samples(new Float32Array([0.2]));
    await view.click('stop');
    assert.equal(view.nodes.get('text').value, 'Draft.');
    assert.match(view.nodes.get('status').textContent, /No (audio|speech)/);
    assert.equal(view.calls.length, 0);
  }
});

test('failed and mismatched save responses retain text and retry with the same UUID', async () => {
  for (const response of [{ ok: false, json: async () => ({}) }, { ok: true, json: async () => ({ ok: true, id: 'wrong-id' }) }]) {
    let attempt = 0;
    const view = page({ fetchResult: (call) => ++attempt === 1 ? response : { ok: true, json: async () => ({ ok: true, id: call.body.id }) } });
    await view.type('Keep the exact complaint.');
    await view.click('submit');
    assert.equal(view.nodes.get('text').value, 'Keep the exact complaint.');
    assert.match(view.nodes.get('status').textContent, /Save not confirmed/);
    assert.doesNotMatch(view.nodes.get('status').textContent, /^Feedback saved/);
    await view.click('submit');
    assert.deepEqual(view.calls[1].body, view.calls[0].body);
    assert.match(view.nodes.get('status').textContent, /Feedback saved/);
  }
});

test('editing a failed draft rotates its submission UUID', async () => {
  const view = page({ fetchResult: () => ({ ok: false }) });
  await view.type('Original complaint.');
  await view.click('submit');
  await view.type('Edited complaint.');
  await view.click('submit');
  assert.notEqual(view.calls[0].body.id, view.calls[1].body.id);
  assert.equal(view.calls[1].body.text, 'Edited complaint.');
});

test('cancel during a save reports an unknown outcome and ignores stale confirmation', async () => {
  const pending = deferred();
  let attempt = 0;
  const view = page({ fetchResult: (call) => ++attempt === 1 ? pending.promise : { ok: true, json: async () => ({ ok: true, id: call.body.id }) } });
  await view.type('Draft retained during save.');
  const sending = view.click('submit');
  await tick();
  await view.click('cancel');
  assert.equal(view.calls[0].options.signal.aborted, true);
  assert.match(view.nodes.get('status').textContent, /Save not confirmed/);
  pending.resolve({ ok: true, json: async () => ({ ok: true, id: view.calls[0].body.id }) });
  await sending;
  assert.equal(view.nodes.get('text').value, 'Draft retained during save.');
  assert.doesNotMatch(view.nodes.get('status').textContent, /^Feedback saved/);
  await view.click('open');
  await view.click('submit');
  assert.deepEqual(view.calls[1].body, view.calls[0].body);
  assert.match(view.nodes.get('status').textContent, /Feedback saved/);
});

test('a save times out while preserving the UUID for confirmation by retry', async () => {
  const pending = deferred();
  const view = page({ fetchResult: () => pending.promise });
  await view.type('Slow save.');
  const saving = view.click('submit');
  await tick();
  await view.advance(20_000);
  await saving;
  assert.equal(view.calls[0].options.signal.aborted, true);
  assert.equal(view.nodes.get('text').value, 'Slow save.');
  assert.match(view.nodes.get('status').textContent, /Save not confirmed/);
  assert.equal(view.nodes.get('submit').disabled, false);
});

test('repeated Send clicks cannot create concurrent saves', async () => {
  const pending = deferred();
  const view = page({ fetchResult: () => pending.promise });
  await view.type('One complaint.');
  const saving = view.click('submit');
  await tick();
  await view.click('submit');
  assert.equal(view.calls.length, 1);
  pending.resolve({ ok: true, json: async () => ({ ok: true, id: view.calls[0].body.id }) });
  await saving;
});

test('pagehide releases microphone capture and destroy removes dialog listeners', async () => {
  const view = page();
  await view.click('record');
  await view.window.fire('pagehide');
  assert.equal(view.track.stops, 1);
  assert.equal(view.contexts[0].closed, 1);
  view.app.destroy();
  await view.click('record');
  assert.equal(view.mediaCalls.length, 1);
  assert.equal(view.timers.size, 0);
});
