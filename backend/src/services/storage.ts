import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { PassThrough, Readable } from 'node:stream';
import { decryptBuffer, encryptBuffer, isEncryptedFile } from '../utils/crypto';
import { badRequest } from '../utils/http';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function uploadRoot(): string {
  return path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
}

/** Files are held in memory just long enough to verify and write them. */
export const uploadSingle = (field: string) => multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20 },
}).single(field);

const SIGNATURES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/**
 * Identifies the file by its leading bytes rather than its name or the
 * browser-supplied type, so a renamed executable cannot pass as a PDF.
 */
export function sniffFile(buffer: Buffer, allowed: string[]): { mime: string; ext: string } {
  const match = SIGNATURES.find((item) => allowed.includes(item.mime) && item.test(buffer));
  if (!match) {
    throw badRequest(allowed.every((mime) => mime.startsWith('image/'))
      ? 'يجب أن تكون الصورة بصيغة JPG أو PNG أو WEBP.'
      : 'الملفات المقبولة: PDF أو صور JPG/PNG/WEBP فقط.');
  }
  return match;
}

/** Writes the file under a generated name; the returned key is stored in the database. */
export async function storeFile(folder: string, buffer: Buffer, ext: string): Promise<string> {
  if (!/^[a-z0-9/_-]+$/i.test(folder)) throw new Error('Invalid storage folder');
  const key = `${folder}/${randomUUID()}.${ext}`;
  const target = resolveKey(key);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
  // Encrypted at rest with the server's key (AES-256-GCM); a stolen disk or backup shows nothing.
  await fsp.writeFile(target, encryptBuffer(buffer), { mode: 0o640, flag: 'wx' });
  return key;
}

export function resolveKey(key: string): string {
  const root = uploadRoot();
  const target = path.resolve(root, key);
  if (!target.startsWith(root + path.sep)) throw new Error('Storage key escapes the upload directory');
  return target;
}

export async function readStoredFile(key: string): Promise<Buffer> {
  return decryptBuffer(await fsp.readFile(resolveKey(key)));
}

/** The stored file as a stream, decrypted. */
export function openStoredFile(key: string): Readable {
  const out = new PassThrough();
  readStoredFile(key).then((buffer) => out.end(buffer)).catch((error) => out.destroy(error));
  return out;
}

/** Encrypts files saved before encryption at rest was switched on. Returns [encrypted, alreadyEncrypted]. */
export async function encryptExistingFiles(): Promise<[number, number]> {
  let done = 0;
  let already = 0;
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      const data = await fsp.readFile(full);
      if (isEncryptedFile(data)) { already += 1; continue; }
      const sealed = encryptBuffer(data);
      if (sealed === data) return;
      await fsp.writeFile(`${full}.tmp`, sealed, { mode: 0o640 });
      await fsp.rename(`${full}.tmp`, full);
      done += 1;
    }
  }
  await walk(uploadRoot());
  return [done, already];
}

/** How many stored files are still in plain form. */
export async function plainFileCount(): Promise<number> {
  let plain = 0;
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const handle = await fsp.open(full, 'r');
        try {
          const head = Buffer.alloc(40);
          const { bytesRead } = await handle.read(head, 0, 40, 0);
          if (!isEncryptedFile(head.subarray(0, bytesRead))) plain += 1;
        } finally { await handle.close(); }
      }
    }
  }
  await walk(uploadRoot());
  return plain;
}

export async function storedFileExists(key: string): Promise<boolean> {
  try {
    await fsp.access(resolveKey(key));
    return true;
  } catch {
    return false;
  }
}

/**
 * Multer (busboy) decodes the multipart file name as Latin-1, which garbles
 * Arabic names. Re-decode as UTF-8 when the bytes form valid UTF-8.
 */
export function uploadedName(file: Express.Multer.File, fallback: string): string {
  const raw = file.originalname || '';
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  const name = decoded.includes('\uFFFD') ? raw : decoded;
  return (name.replace(/[\u0000-\u001f\\/]/g, '_').trim() || fallback).slice(0, 255);
}

/** RFC 5987 Content-Disposition so Arabic file names survive the download. */
export function contentDisposition(name: string, inline: boolean): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

/** Archive uploads accept any file type, up to 50 MB. */
export const uploadArchive = (field: string) => multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ARCHIVE_BYTES, files: 1, fields: 20 },
}).single(field);

/** Types the browser may show in place; anything else is only ever downloaded. */
export function inlineSafeType(buffer: Buffer): { mime: string; ext: string } | null {
  return SIGNATURES.find((item) => item.test(buffer)) ?? null;
}

/** A short, safe extension from the uploaded name, used only for the stored file name. */
export function safeExtension(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) && ext !== name.toLowerCase() ? ext : 'bin';
}
