import {createFeedbackReportStore} from '../src/feedback-analysis.mjs';

// Owner-only export. Reports are not served through the browser application.
try {
  const reports=await createFeedbackReportStore().list();
  process.stdout.write(JSON.stringify({exportedUtc:new Date().toISOString(),reports},null,2)+'\n');
}catch {
  console.error('Could not read private input analysis. Check the private dataset and server credentials.');
  process.exitCode=1;
}
