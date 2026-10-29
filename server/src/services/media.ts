import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { badRequest } from '../lib/errors.js';

/**
 * Private file storage on the local disk (outside any static directory).
 * Files are only ever streamed through authorization-checked endpoints.
 * Swap this module for S3 / Supabase Storage etc. if desired.
 */
const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    ext: 'png',
    test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')) },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

export const ALLOWED_IMAGE_TYPES = SIGNATURES.map((s) => s.mime);

/** Validates by file content (magic bytes), not by the client-supplied name or type. */
export function detectImageType(buffer: Buffer): { mime: string; ext: string } | null {
  const sig = SIGNATURES.find((s) => s.test(buffer));
  return sig ? { mime: sig.mime, ext: sig.ext } : null;
}

export function ensureUploadDir() {
  fs.mkdirSync(config.uploadDir, { recursive: true, mode: 0o750 });
}

export async function storeImage(buffer: Buffer): Promise<{ storageKey: string; mime: string; size: number }> {
  if (buffer.length === 0) throw badRequest('The uploaded file is empty.');
  if (buffer.length > config.maxUploadBytes) {
    throw badRequest(`Images must be ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB or smaller.`);
  }
  const type = detectImageType(buffer);
  if (!type) throw badRequest('Please upload a JPEG, PNG, WebP or GIF image.');
  ensureUploadDir();
  const storageKey = `${crypto.randomUUID()}.${type.ext}`;
  await fs.promises.writeFile(path.join(config.uploadDir, storageKey), buffer, { mode: 0o640 });
  return { storageKey, mime: type.mime, size: buffer.length };
}

export function storagePath(storageKey: string): string {
  // storage keys are generated server-side; still guard against traversal
  if (!/^[0-9a-f-]{36}\.(jpg|png|gif|webp)$/.test(storageKey)) throw badRequest('Invalid file reference.');
  return path.join(config.uploadDir, storageKey);
}

export async function deleteStoredFile(storageKey: string) {
  await fs.promises.unlink(storagePath(storageKey)).catch(() => undefined);
}
