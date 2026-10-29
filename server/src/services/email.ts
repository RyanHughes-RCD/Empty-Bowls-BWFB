import nodemailer, { type Transporter } from 'nodemailer';
import { config, smtpConfigured } from '../config.js';
import { pool } from '../db/pool.js';

let transporter: Transporter | null = null;
function getTransporter(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transporter;
}

export interface EmailResult {
  status: 'sent' | 'failed' | 'not_configured';
  messageId?: string;
  error?: string;
}

/** Sends an email if SMTP is configured; always records the attempt in email_log. */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  purpose: string;
  userId?: number | null;
  replyTo?: string;
}): Promise<EmailResult> {
  let result: EmailResult;
  if (!smtpConfigured()) {
    result = { status: 'not_configured' };
  } else {
    try {
      const info = await getTransporter().sendMail({
        from: config.smtp.from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        replyTo: opts.replyTo || undefined,
      });
      result = { status: 'sent', messageId: info.messageId };
    } catch (err) {
      result = { status: 'failed', error: (err as Error).message.slice(0, 500) };
    }
  }
  await pool.query(
    `INSERT INTO email_log (recipient, subject, purpose, status, error, message_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [opts.to, opts.subject, opts.purpose, result.status, result.error ?? null, result.messageId ?? null, opts.userId ?? null],
  );
  return result;
}
