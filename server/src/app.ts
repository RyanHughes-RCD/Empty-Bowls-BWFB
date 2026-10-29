import connectPgSimple from 'connect-pg-simple';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachUser, csrfProtection, requireAuth } from './auth/middleware.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { HttpError } from './lib/errors.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { donationsRouter } from './routes/donations.js';
import { donorsRouter } from './routes/donors.js';
import { eventsRouter } from './routes/events.js';
import { publicRouter } from './routes/public.js';
import { reportsRouter } from './routes/reports.js';
import { submissionsRouter } from './routes/submissions.js';
import { tasksRouter } from './routes/tasks.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'self'"],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: config.isProduction ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));

  // ----- Public API: anonymous, no session needed, read-only views + submission intake
  app.use('/api/public', publicRouter);

  // ----- Internal API: session authentication
  const PgStore = connectPgSimple(session);
  app.use(
    '/api',
    session({
      store: new PgStore({ pool, tableName: 'user_sessions', createTableIfMissing: false, pruneSessionInterval: config.isTest ? false : 900 }),
      name: 'eb.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        maxAge: config.sessionMaxAgeHours * 60 * 60 * 1000,
      },
    }),
  );
  app.use('/api', attachUser);
  app.use('/api', csrfProtection);
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/auth', authRouter);
  app.use('/api', requireAuth);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/donations', donationsRouter);
  app.use('/api/submissions', submissionsRouter);
  app.use('/api/donors', donorsRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api', adminRouter);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  // ----- Built React client (single-page app)
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (config.serveClient && fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  // ----- Error handler (never leaks stack traces or SQL details)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    const e = err as { type?: string; code?: string; status?: number; message?: string; constraint?: string };
    if (e.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
    if (e.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
    if (e.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `Images must be ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB or smaller.` });
    }
    if (e.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Unexpected file upload.' });
    if (e.code === '23505') return res.status(409).json({ error: 'This record already exists (duplicate).' });
    if (e.code === '23503') return res.status(400).json({ error: 'A related record does not exist or is still in use.' });
    if (e.code === '23514' || e.code === '22P02' || e.code === '22007' || e.code === '22008') {
      return res.status(400).json({ error: 'Some values are not valid.', details: { constraint: e.constraint } });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}
