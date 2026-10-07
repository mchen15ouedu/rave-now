const RECORDING_LIMIT_MS = 60_000;
const TRANSCRIPTION_LIMIT_MS = 75_000;
const SAVE_LIMIT_MS = 20_000;
const FEEDBACK_LIMIT = 2_000;

function operationError(name, message) {
  return Object.assign(new Error(message), { name });
}

function erase(samples) {
  try { samples?.fill(0); } catch { /* A worker may have transferred the buffer. */ }
}

function monoAt16k(chunks, length, sampleRate) {
  const source = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    source.set(chunk, offset);
    offset += chunk.length;
    erase(chunk);
  }
  if (sampleRate === 16_000) return source;
  const output = new Float32Array(Math.round(length * 16_000 / sampleRate));
  const ratio = sampleRate / 16_000;
  for (let index = 0; index < output.length; index += 1) {
    const start = index * ratio;
    if (ratio < 1) {
      const left = Math.min(Math.floor(start), length - 1);
      const right = Math.min(left + 1, length - 1);
      output[index] = source[left] + (source[right] - source[left]) * (start - left);
    } else {
      // Average the source interval when downsampling to reduce high-frequency aliasing.
      const end = Math.min((index + 1) * ratio, length);
      let sum = 0;
      for (let frame = Math.floor(start); frame < Math.ceil(end); frame += 1) {
        sum += source[frame] * (Math.min(frame + 1, end) - Math.max(frame, start));
      }
      output[index] = end > start ? sum / (end - start) : 0;
    }
  }
  erase(source);
  return output;
}

/** Wire the feedback dialog without requesting microphone access or loading Whisper. */
export function initFeedback(document, window, dependencies = {}) {
  const prefix = dependencies.prefix ?? 'feedback';
  const subject = dependencies.subject ?? 'feedback';
  const endpoint = dependencies.endpoint ?? '/api/browser/feedback';
  const ids = ['open', 'dialog', 'record', 'stop', 'text', 'status', 'submit', 'cancel'];
  const nodes = Object.fromEntries(ids.map((name) => [name, document.getElementById(`${prefix}-${name}`)]));
  if (ids.some((name) => !nodes[name])) return { destroy() {} };

  const mediaDevices = dependencies.mediaDevices ?? window.navigator?.mediaDevices;
  const AudioContext = dependencies.AudioContext ?? window.AudioContext ?? window.webkitAudioContext;
  const fetch = dependencies.fetch ?? window.fetch?.bind(window);
  const AbortController = dependencies.AbortController ?? window.AbortController ?? globalThis.AbortController;
  const setTimer = dependencies.setTimeout ?? window.setTimeout?.bind(window) ?? globalThis.setTimeout;
  const clearTimer = dependencies.clearTimeout ?? window.clearTimeout?.bind(window) ?? globalThis.clearTimeout;
  const crypto = dependencies.crypto ?? window.crypto;
  const createId = dependencies.createId ?? (() => {
    if (crypto?.randomUUID) return crypto.randomUUID();
    if (!crypto?.getRandomValues) throw new Error('A secure connection is required to send feedback.');
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });
  const transcribe = dependencies.transcribeFeedback ?? ((audio, options) =>
    import('/browser/whisper-client.js').then((module) => module.transcribeFeedback(audio, options)));
  const supported = Boolean(mediaDevices?.getUserMedia && AudioContext);
  const listeners = [];
  let phase = 'idle';
  let generation = 0;
  let capture = null;
  let controller = null;
  let submission = null;
  let confirmedSubmission = null;
  let destroyed = false;

  function status(message, error = false, translate = true) {
    nodes.status.textContent = translate ? message.replace(/\bFeedback\b/g, subject[0].toUpperCase() + subject.slice(1)).replace(/\bfeedback\b/g, subject) : message;
    nodes.status.classList?.toggle('error', error);
  }

  function updateControls() {
    const busy = phase !== 'idle';
    nodes.record.disabled = !supported || busy;
    nodes.stop.disabled = phase !== 'recording';
    nodes.stop.hidden = phase !== 'recording';
    nodes.text.disabled = busy;
    const text = nodes.text.value.trim();
    nodes.submit.disabled = busy || !text || text.length > FEEDBACK_LIMIT;
    // Live recording and processing updates must be announced immediately.
    nodes.dialog.setAttribute('aria-busy', 'false');
  }

  function lengthError(text = nodes.text.value.trim()) {
    if (text.length <= FEEDBACK_LIMIT) return false;
    status(`Feedback is too long (${text.length.toLocaleString('en-US')}/${FEEDBACK_LIMIT.toLocaleString('en-US')} characters). Shorten the text before sending.`, true);
    return true;
  }

  function releaseCapture(eraseAudio = true) {
    const recording = capture;
    capture = null;
    if (!recording) return;
    clearTimer(recording.timer);
    if (recording.processor) recording.processor.onaudioprocess = null;
    for (const node of [recording.source, recording.processor, recording.mute]) {
      try { node?.disconnect(); } catch { /* Already disconnected. */ }
    }
    for (const track of recording.stream?.getTracks() ?? []) {
      try { track.stop(); } catch { /* An ended track needs no further cleanup. */ }
    }
    try { Promise.resolve(recording.context?.close()).catch(() => {}); } catch { /* Already closed. */ }
    if (eraseAudio) recording.chunks.forEach(erase);
    recording.chunks = [];
  }

  function cancelWork() {
    const previous = phase;
    generation += 1;
    controller?.abort(operationError('AbortError', 'Feedback canceled.'));
    controller = null;
    releaseCapture();
    phase = 'idle';
    if (previous === 'sending') {
      status(confirmedSubmission?.id === submission?.id && confirmedSubmission ? 'Submission saved. Status checks paused. Your draft is kept; send it again to check progress.' : 'Save not confirmed. Your draft is kept; send it again to confirm whether it was saved.');
    } else if (previous === 'processing') {
      status('Submission saved. Status checks paused. Your draft is kept; send it again to check progress.');
    } else if (previous !== 'idle') {
      status('Canceled. Your draft is kept.');
    }
    updateControls();
  }

  function open() {
    if (destroyed) return;
    if (nodes.dialog.showModal) {
      if (!nodes.dialog.open) nodes.dialog.showModal();
    } else {
      nodes.dialog.hidden = false;
      nodes.dialog.setAttribute('open', '');
    }
    nodes.text.focus();
  }

  function close() {
    cancelWork();
    if (nodes.dialog.close) nodes.dialog.close();
    else {
      nodes.dialog.hidden = true;
      nodes.dialog.removeAttribute?.('open');
    }
    nodes.open.focus();
  }

  async function bounded(work, limit, abortController, timeoutMessage) {
    let timer;
    let onAbort;
    const canceled = new Promise((_, reject) => {
      onAbort = () => reject(abortController.signal.reason ?? operationError('AbortError', 'Canceled.'));
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      if (abortController.signal.aborted) onAbort();
      timer = setTimer(() => abortController.abort(operationError('TimeoutError', timeoutMessage)), limit);
    });
    try { return await Promise.race([Promise.resolve().then(work), canceled]); }
    finally {
      clearTimer(timer);
      abortController.signal.removeEventListener('abort', onAbort);
    }
  }

  async function stopRecording() {
    if (phase !== 'recording' || !capture) return;
    const token = generation;
    const recording = capture;
    const chunks = recording.chunks;
    recording.chunks = [];
    releaseCapture(false);
    phase = 'transcribing';
    const abortController = new AbortController();
    controller = abortController;
    status('Transcribing on your device…');
    updateControls();
    let audio;
    try {
      if (!recording.length) throw new Error('No audio was captured. Type your feedback or record again.');
      audio = monoAt16k(chunks, recording.length, recording.context.sampleRate);
      const result = await bounded(() => transcribe(audio, {
        signal: abortController.signal,
        onProgress(progress) {
          if (token !== generation || phase !== 'transcribing') return;
          const message = typeof progress === 'string' ? progress.trim() :
            (typeof progress?.message === 'string' ? progress.message.trim() : '');
          if (message) { status(message); return; }
          const percent = Number(progress?.progress);
          status(Number.isFinite(percent) ? `Preparing voice transcription… ${Math.round(Math.max(0, Math.min(100, percent)))}%` : 'Preparing voice transcription…');
        },
      }), TRANSCRIPTION_LIMIT_MS, abortController, 'Transcription timed out. Type your feedback or record again.');
      if (token !== generation) return;
      if (typeof result !== 'string' || !result.trim()) throw new Error('No speech was recognized. Type your feedback or record again.');
      nodes.text.value = [nodes.text.value.trim(), result.trim()].filter(Boolean).join('\n');
      submission = null;
      confirmedSubmission = null;
      if (!lengthError()) status('Review and edit the text, then send your feedback.');
    } catch (error) {
      if (token === generation) status(error?.name === 'TimeoutError' ? error.message :
        (error?.message?.startsWith('No ') ? error.message : 'Voice transcription is unavailable. Type your feedback or try recording again.'), true);
    } finally {
      chunks.forEach(erase);
      erase(audio);
      if (token === generation) {
        controller = null;
        phase = 'idle';
        updateControls();
      }
    }
  }

  async function record() {
    if (destroyed || !supported || phase !== 'idle') return;
    const token = ++generation;
    phase = 'requesting';
    status('Allow microphone access to record your feedback.');
    updateControls();
    try {
      let context;
      try { context = new AudioContext({ sampleRate: 16_000 }); }
      catch { context = new AudioContext(); }
      const recording = { context, stream: null, chunks: [], length: 0, timer: null };
      capture = recording;
      // Resume while the Record click still supplies browser user activation.
      const resumed = Promise.resolve(context.resume());
      resumed.catch(() => {});
      const stream = await mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      if (token !== generation || destroyed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      recording.stream = stream;
      await resumed;
      if (token !== generation || destroyed) return;
      if (!Number.isFinite(context.sampleRate) || context.sampleRate <= 0 || !context.createScriptProcessor) {
        throw new Error('Audio capture is unavailable.');
      }
      recording.source = context.createMediaStreamSource(stream);
      recording.processor = context.createScriptProcessor(4096, 1, 1);
      recording.mute = context.createGain();
      recording.mute.gain.value = 0;
      const maximumFrames = Math.floor(context.sampleRate * RECORDING_LIMIT_MS / 1000);
      recording.processor.onaudioprocess = ({ inputBuffer }) => {
        if (token !== generation || phase !== 'recording') return;
        const frames = Math.min(inputBuffer.length, maximumFrames - recording.length);
        if (frames > 0) {
          const samples = new Float32Array(frames);
          const channels = Math.max(1, inputBuffer.numberOfChannels);
          for (let channel = 0; channel < channels; channel += 1) {
            const data = inputBuffer.getChannelData(channel);
            for (let frame = 0; frame < frames; frame += 1) samples[frame] += data[frame] / channels;
          }
          recording.chunks.push(samples);
          recording.length += frames;
        }
        if (recording.length >= maximumFrames) void stopRecording();
      };
      recording.source.connect(recording.processor);
      recording.processor.connect(recording.mute);
      recording.mute.connect(context.destination);
      phase = 'recording';
      recording.timer = setTimer(() => void stopRecording(), RECORDING_LIMIT_MS);
      status('Recording… Speak your feedback, then choose Stop. Maximum 60 seconds.');
      updateControls();
    } catch (error) {
      if (token !== generation) return;
      releaseCapture();
      phase = 'idle';
      const denied = ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name);
      status(denied ? 'Microphone access was denied. Type your feedback or try again.' : 'Voice recording is unavailable. Type your feedback or try again.', true);
      updateControls();
    }
  }

  async function send() {
    if (destroyed || phase !== 'idle') return;
    const text = nodes.text.value.trim();
    if (!text) { nodes.text.focus(); return; }
    if (lengthError(text)) { nodes.text.focus(); updateControls(); return; }
    const token = ++generation;
    const abortController = new AbortController();
    controller = abortController;
    phase = 'sending';
    status('Saving your feedback…');
    updateControls();
    let saveConfirmed = false;
    try {
      if (!submission || submission.text !== text) submission = { id: createId(), text };
      saveConfirmed = confirmedSubmission?.id === submission.id && confirmedSubmission?.text === text;
      const sent = submission;
      const result = await bounded(async () => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          signal: abortController.signal,
          body: JSON.stringify(sent),
        });
        if (!response.ok) throw new Error('Save not confirmed.');
        const data = await response.json();
        if (dependencies.validateSaved && !dependencies.validateSaved(data, response.status)) throw new Error('Save not confirmed.');
        return data;
      }, SAVE_LIMIT_MS, abortController, 'Save timed out.');
      if (token !== generation) return;
      if (result?.ok !== true || result.id !== sent.id) throw new Error('Save not confirmed.');
      saveConfirmed = true;
      confirmedSubmission = { id: sent.id, text: sent.text };
      if (dependencies.onSaved) {
        phase = 'processing';
        updateControls();
        const message = await dependencies.onSaved(result, {
          signal: abortController.signal,
          status(message, error = false) { if (token === generation) status(message, error, false); },
        });
        if (token !== generation) return;
        if (typeof message === 'string') status(message, false, false);
      } else {
        nodes.text.value = '';
        submission = null;
        confirmedSubmission = null;
        status('Feedback saved. Thank you.');
      }
    } catch {
      if (token === generation) status(saveConfirmed ? 'Submission saved. Progress could not be checked. Your draft is kept; send it again to check progress.' : 'Save not confirmed. Your draft is kept; send it again to confirm whether it was saved.', true);
    } finally {
      if (token === generation) {
        controller = null;
        phase = 'idle';
        updateControls();
      }
    }
  }

  function listen(target, event, callback) {
    target.addEventListener(event, callback);
    listeners.push(() => target.removeEventListener?.(event, callback));
  }
  listen(nodes.open, 'click', (event) => { event?.preventDefault(); open(); });
  listen(nodes.record, 'click', (event) => { event?.preventDefault(); return record(); });
  listen(nodes.stop, 'click', (event) => { event?.preventDefault(); return stopRecording(); });
  listen(nodes.submit, 'click', (event) => { event?.preventDefault(); return send(); });
  listen(nodes.cancel, 'click', (event) => { event?.preventDefault(); close(); });
  listen(nodes.dialog, 'cancel', (event) => { event.preventDefault(); close(); });
  listen(nodes.dialog, 'close', cancelWork);
  listen(nodes.text, 'input', () => {
    if (submission) submission = null;
    confirmedSubmission = null;
    if (phase === 'idle' && !lengthError()) status('Review your text, then send your feedback.');
    updateControls();
  });
  if (window.addEventListener) listen(window, 'pagehide', cancelWork);
  status(supported ? 'Type your feedback or record up to 60 seconds.' : 'Voice recording is not supported here. Type your feedback below.');
  updateControls();

  return {
    open,
    close,
    destroy() {
      destroyed = true;
      cancelWork();
      listeners.forEach((remove) => remove());
    },
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') initFeedback(document, window);
