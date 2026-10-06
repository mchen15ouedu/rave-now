import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, projectDir } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { writeSampleData } from './generate-sample-data.mjs';

try {
  const envFile = path.join(projectDir, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig();
  if (config.mode === 'demo' && config.snapshotFile === path.join(projectDir, 'data', 'tracker-snapshot.tsv')) {
    // A fixed simulator date stays independent of the browser's current-date samples.
    const sampleDirectory = path.join(projectDir, 'work', 'demo-data');
    await writeSampleData(config.demoDate, sampleDirectory);
    config.snapshotFile = path.join(sampleDirectory, 'tracker-snapshot.tsv');
  }
  const app = createApp({ config });
  app.server.listen(config.port, config.host, () => {
    console.log(`Rave Now ${config.mode} listening on ${config.host}:${app.server.address().port}`);
    app.startReminders();
  });
  app.server.on('error', () => {
    console.error('Listener failed; check the host and port.');
    app.store.close();
    process.exitCode = 1;
  });
  const close = async () => {
    await app.stopReminders();
    app.server.close(() => { app.store.close(); process.exit(0); });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch {
  console.error('Startup failed; check local configuration.');
  process.exitCode = 1;
}
