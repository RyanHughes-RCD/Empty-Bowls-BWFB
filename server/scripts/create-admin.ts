/**
 * Creates the first Super Admin account.
 *
 *   npm run create-admin -- --email you@charity.ca --name "Your Name"
 *
 * The password is read from the ADMIN_PASSWORD environment variable or typed
 * at a hidden prompt. Refuses to run if a Super Admin already exists unless
 * --additional is passed.
 */
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword, passwordProblems } from '../src/auth/password.js';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closePools, pool } from '../src/db/pool.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function promptHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  if (!email || !name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: npm run create-admin -- --email you@charity.ca --name "Your Name"');
    process.exit(1);
  }
  await migrate(config.databaseUrl, config.databaseSsl);
  const existing = await pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'super_admin'`);
  if (existing.rows[0].n > 0 && !process.argv.includes('--additional')) {
    console.error('A Super Admin already exists. Sign in and add users from Administration > Users, or pass --additional.');
    process.exit(1);
  }
  const password = process.env.ADMIN_PASSWORD ?? (await promptHidden('Password (min 12 characters): '));
  const problem = passwordProblems(password);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const dup = await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
  if (dup.rows.length) {
    console.error('A user with that email already exists.');
    process.exit(1);
  }
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, role, password_hash) VALUES ($1, $2, 'super_admin', $3) RETURNING id`,
    [name, email, await hashPassword(password)],
  );
  await pool.query(`INSERT INTO audit_log (user_id, action, record_type, record_id, summary) VALUES ($1, 'user.create', 'user', $1, 'Super Admin created from command line')`, [
    rows[0].id,
  ]);
  console.log(`Super Admin ${email} created (user #${rows[0].id}). You can now sign in at ${config.appBaseUrl}/login`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePools());
