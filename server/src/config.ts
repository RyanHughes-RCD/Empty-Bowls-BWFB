import 'dotenv/config';
import path from 'node:path';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';

const sessionSecret = required('SESSION_SECRET', isProduction ? undefined : 'dev-only-insecure-session-secret-change-me');
if (isProduction && sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters in production');
}

export const config = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === 'test',
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  // Optional least-privilege connection used only for public (anonymous) reads.
  publicDatabaseUrl: process.env.PUBLIC_DATABASE_URL || process.env.DATABASE_URL!,
  databaseSsl: process.env.DATABASE_SSL === 'true',
  sessionSecret,
  sessionMaxAgeHours: Number(process.env.SESSION_MAX_AGE_HOURS ?? 8),
  // Used to hash IP addresses for abuse prevention without storing raw IPs.
  hashSalt: process.env.HASH_SALT ?? sessionSecret,
  appBaseUrl: (process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, ''),
  // Comma separated list of origins allowed to embed / link (CORS is not needed for same-origin use).
  trustProxy: process.env.TRUST_PROXY ?? (isProduction ? '1' : 'loopback'),
  uploadDir: path.resolve(process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads')),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 5) * 1024 * 1024,
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM,
  },
  publicSubmissionRateLimit: Number(process.env.PUBLIC_SUBMISSION_RATE_LIMIT ?? 10), // per hour per IP
  // Minimum seconds between loading the form and submitting it (bot check).
  minFormFillSeconds: Number(process.env.MIN_FORM_FILL_SECONDS ?? (nodeEnv === 'test' ? 0 : 3)),
  serveClient: process.env.SERVE_CLIENT !== 'false',
  // Websites allowed to embed the public form/gallery in an <iframe>, e.g. "https://www.mycharity.ca"
  embedAllowedOrigins: (process.env.EMBED_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\/[^\s/]+$/.test(s)),
};

export function smtpConfigured(): boolean {
  return Boolean(config.smtp.host && config.smtp.from);
}

/** The charity's local time zone, used for "today" / overdue calculations. */
export const APP_TIMEZONE = process.env.APP_TIMEZONE ?? 'America/Toronto';

/** Today's date (YYYY-MM-DD) in the charity's time zone. */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}
