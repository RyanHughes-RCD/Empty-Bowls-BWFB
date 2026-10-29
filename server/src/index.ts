import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { ensureUploadDir } from './services/media.js';

async function main() {
  if (process.env.AUTO_MIGRATE !== 'false') {
    await migrate(config.databaseUrl, config.databaseSsl);
  }
  ensureUploadDir();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Donor management server listening on port ${config.port} (${config.nodeEnv})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
