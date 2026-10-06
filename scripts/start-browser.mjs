import { existsSync } from 'node:fs';
import path from 'node:path';
import { projectDir } from '../src/config.mjs';
import { createHostedApp } from '../src/hosted.mjs';
import { calendarDate } from '../src/shows.mjs';
import { writeSampleData } from './generate-sample-data.mjs';

try {
  const envFile = path.join(projectDir, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = { ...process.env, PORT: process.env.BROWSER_PORT || '7860' };
  const bundledFile = path.join(projectDir, 'data', 'tracker-snapshot.tsv');
  const snapshotFile = path.resolve(projectDir, env.BROWSER_SNAPSHOT_FILE || env.SNAPSHOT_FILE || bundledFile);
  if (!['live', 'apps-script'].includes(env.BROWSER_SOURCE_MODE) && snapshotFile === bundledFile) {
    await writeSampleData(calendarDate(new Date(), env.TIME_ZONE || 'America/Chicago'));
  }
  const app = createHostedApp({ env });
  const host = env.HOST || '127.0.0.1';
  app.server.listen(app.config.port, host, () => {
    console.log(`Rave Now browser listening on ${host}:${app.server.address().port}`);
    app.startReminders();
  });
  app.server.on('error', () => {
    console.error('Browser listener failed; check the host and browser port.');
    app.store?.close();
    process.exitCode = 1;
  });
  const close = async () => {
    await app.stopReminders();
    app.server.close(() => { app.store?.close(); process.exit(0); });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch {
  console.error('Browser startup failed; check local configuration.');
  process.exitCode = 1;
}
