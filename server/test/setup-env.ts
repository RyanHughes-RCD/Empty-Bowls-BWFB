import os from 'node:os';
import path from 'node:path';

// Tests run against a dedicated PostgreSQL database (never the real one).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://eb_owner:devpass@localhost:5432/empty_bowls_test';
// Public pages use a restricted role that can only read the public_* views.
process.env.PUBLIC_DATABASE_URL =
  process.env.TEST_PUBLIC_DATABASE_URL ?? 'postgres://eb_public_test:publicpass@localhost:5432/empty_bowls_test';
process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-123';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'eb-test-uploads');
process.env.SMTP_HOST = '';
process.env.APP_BASE_URL = 'http://localhost:3000';
