// Copies SQL migrations next to the compiled JavaScript so `npm start` can migrate.
import { cpSync } from 'node:fs';
cpSync(new URL('../src/db/migrations', import.meta.url), new URL('../dist/db/migrations', import.meta.url), { recursive: true });
