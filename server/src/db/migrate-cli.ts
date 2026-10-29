import { config } from '../config.js';
import { migrate } from './migrate.js';

migrate(config.databaseUrl, config.databaseSsl)
  .then((applied) => {
    console.log(applied.length ? `Done (${applied.length} applied).` : 'Database is up to date.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
