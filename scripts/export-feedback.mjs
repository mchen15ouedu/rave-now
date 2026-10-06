import {createFeedbackStore} from '../src/feedback-store.mjs';

// Owner-only CLI. Set HF credentials in your environment, never in browser code.
try {
  const records=await createFeedbackStore({timeoutMs:120000}).list();
  process.stdout.write(JSON.stringify({exportedUtc:new Date().toISOString(),records},null,2)+'\n');
} catch {
  console.error('Could not read private feedback. Check the HF repository and secret environment variables.');
  process.exitCode=1;
}
