import { initFeedback } from './feedback.js';

const ENDPOINT = '/api/browser/contributions';
const POLL_INTERVAL_MS = 5_000;
const POLL_LIMIT_MS = 180_000;
const REQUEST_LIMIT_MS = 15_000;
const states = new Set(['queued', 'processing', 'completed', 'needs-review', 'rejected']);
const terminal = new Set(['completed', 'needs-review', 'rejected']);

function canceled() { return Object.assign(new Error('Canceled.'), { name: 'AbortError' }); }

/** Reuse local voice capture; only the reviewed text and stable ID leave the browser. */
export function initContributions(document, window, dependencies = {}) {
  const fetch = dependencies.fetch ?? window.fetch?.bind(window);
  const setTimer = dependencies.setTimeout ?? window.setTimeout?.bind(window) ?? globalThis.setTimeout;
  const clearTimer = dependencies.clearTimeout ?? window.clearTimeout?.bind(window) ?? globalThis.clearTimeout;
  const AbortControllerImpl = dependencies.AbortController ?? window.AbortController ?? globalThis.AbortController;
  const clock = dependencies.now ?? (() => Date.now());

  function wait(delay, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason ?? canceled()); return; }
      let timer;
      const onAbort = () => { clearTimer(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason ?? canceled()); };
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimer(() => { signal.removeEventListener('abort', onAbort); resolve(); }, delay);
    });
  }

  async function readStatus(id, signal, remaining) {
    const controller = new AbortControllerImpl();
    let timer;
    let rejectCanceled;
    const onAbort = () => { controller.abort(signal.reason ?? canceled()); rejectCanceled(signal.reason ?? canceled()); };
    const canceledRequest = new Promise((_, reject) => { rejectCanceled = reject; });
    if (signal.aborted) throw signal.reason ?? canceled();
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimer(() => {
      const error = Object.assign(new Error('Status check timed out.'), { name: 'TimeoutError' });
      controller.abort(error); rejectCanceled(error);
    }, Math.min(REQUEST_LIMIT_MS, remaining));
    try {
      return await Promise.race([Promise.resolve().then(async () => {
        const response = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, {
          method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Status unavailable.');
        const result = await response.json();
        if (result?.id !== id || !states.has(result.status)) throw new Error('Status unavailable.');
        return result;
      }), canceledRequest]);
    } finally { clearTimer(timer); signal.removeEventListener('abort', onAbort); }
  }

  function terminalMessage(result) {
    const message = typeof result.message === 'string' ? result.message.trim().slice(0, 500) : '';
    if (result.status === 'completed') return `Submission processed.${message ? ` ${message}` : ' Search again to see the latest results.'}`;
    if (result.status === 'needs-review') return `Submission saved and needs review.${message ? ` ${message}` : ' It has not been automatically added.'}`;
    return `Submission rejected.${message ? ` ${message}` : ' It has not been added.'}`;
  }

  return initFeedback(document, window, {
    ...dependencies,
    prefix: 'contribution', subject: 'artist details', endpoint: ENDPOINT,
    validateSaved: (result, status) => status === 202 && result?.status === 'queued',
    async onSaved(result, { signal, status }) {
      status('Submission saved. Checking processing status; completion is not confirmed yet.');
      const deadline = clock() + POLL_LIMIT_MS;
      while (clock() < deadline) {
        await wait(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - clock())), signal);
        if (clock() >= deadline) break;
        const progress = await readStatus(result.id, signal, deadline - clock());
        if (signal.aborted) throw signal.reason ?? canceled();
        if (terminal.has(progress.status)) return terminalMessage(progress);
        status(progress.status === 'processing' ? 'Submission saved. Processing your artist and show details; completion is not confirmed yet.' : 'Submission saved. Waiting for processing; completion is not confirmed yet.');
      }
      return 'Submission saved. Processing is still pending. Your draft is kept; send it again to check progress.';
    },
  });
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') initContributions(document, window);
