import { NextFunction, Request, Response } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { decryptBuffer, encryptBuffer } from '../utils/crypto';
import { badRequest, HttpError } from '../utils/http';
import { makeThumb } from './employeePhotos';
import { resolveKey, uploadRoot } from './storage';

// Each photo is decoded once; nothing is worth keeping in libvips' cache.
sharp.cache(false);

/**
 * Employee photos in one ZIP: every entry is checked before anything is kept.
 * The limits hold while the archive is read, not only from what its headers
 * claim, so an archive that lies about its sizes (a "zip bomb") stops early.
 * Changed only by tests.
 */
export const PHOTO_ZIP_LIMITS = {
  /** The ZIP file as uploaded. */
  zipBytes: 100 * 1024 * 1024,
  /** Every entry, folders and system files included. */
  entries: 3000,
  /** Photos (JPG, JPEG, PNG, WebP). */
  images: 1000,
  /** One photo after it is taken out of the archive. */
  imageBytes: 15 * 1024 * 1024,
  /** All photos together after they are taken out of the archive. */
  totalBytes: 600 * 1024 * 1024,
  /** Width × height of one photo (a 50-megapixel camera photo still fits). */
  pixels: 50_000_000,
  /** An image barely compresses; an entry far smaller than its content is not a photo. */
  ratio: 500,
};

/** The stored photo: the right way up, at most 1024 px, JPEG, with camera data (GPS and the rest) removed. */
const PHOTO_SIZE = 1024;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
/** Programs and scripts: an archive carrying one is refused whole. */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'dll', 'com', 'bat', 'cmd', 'msi', 'msp', 'mst', 'scr', 'pif', 'cpl', 'ocx', 'sys', 'drv', 'inf', 'reg', 'lnk', 'url', 'scf',
  'ps1', 'psm1', 'vb', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs', 'wsf', 'wsh', 'ws', 'hta', 'gadget', 'jar', 'class',
  'sh', 'bash', 'zsh', 'csh', 'ksh', 'command', 'py', 'pyc', 'pl', 'rb', 'php', 'elf', 'so', 'dylib', 'bin', 'run', 'out',
  'app', 'apk', 'ipa', 'dmg', 'pkg', 'deb', 'rpm', 'appimage',
]);

export type ZipEntryStatus = 'ok' | 'corrupt' | 'too_large' | 'encrypted' | 'not_image';

export interface ZipPhoto {
  /** The entry's path inside the archive, as the person sees it in their ZIP tool. */
  entry: string;
  /** The file name without its extension: the employee number, kept as text (leading zeros count). */
  stem: string;
  status: ZipEntryStatus;
  reason: string | null;
  photo?: Buffer;
  thumb?: Buffer;
  width?: number;
  height?: number;
}

export interface ZipScan { photos: ZipPhoto[]; ignored: number; inflatedBytes: number }

/** Arabic-Indic digits typed on an Arabic keyboard read as the same number; nothing else is changed. */
export function normaliseDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Files every operating system adds to archives: never photos, never reported one by one. */
function isSystemFile(fileName: string, base: string): boolean {
  return fileName.split('/').includes('__MACOSX') || base.startsWith('._')
    || ['.ds_store', 'thumbs.db', 'desktop.ini'].includes(base.toLowerCase());
}

/** A program however it is named: Windows (MZ), Linux (ELF), macOS (Mach-O), Java, or a #! script. */
export function looksExecutable(head: Buffer): boolean {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return true;
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return true;
  if (head.length < 4) return false;
  const magic = head.readUInt32BE(0);
  return magic === 0x7f454c46 || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic);
}

function isImageSignature(head: Buffer): boolean {
  return (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    || head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP');
}

/** Decodes the whole picture (a broken or cut-off file fails here) and writes the stored photo and its thumbnail. */
export async function preparePhoto(input: Buffer): Promise<{ photo: Buffer; thumb: Buffer; width: number; height: number }> {
  const options = { failOn: 'warning' as const, limitInputPixels: PHOTO_ZIP_LIMITS.pixels };
  const meta = await sharp(input, options).metadata();
  if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) throw new Error('unsupported format');
  const photo = await sharp(input, options)
    .rotate()
    .resize({ width: PHOTO_SIZE, height: PHOTO_SIZE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 86 })
    .toBuffer({ resolveWithObject: true });
  return { photo: photo.data, thumb: await makeThumb(photo.data), width: photo.info.width, height: photo.info.height };
}

class ZipRefused extends Error {}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true, strictFileNames: false }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('unreadable'));
      else resolve(zip);
    });
  });
}

function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { zip.off('entry', onEntry); zip.off('end', onEnd); zip.off('error', onError); };
    const onEntry = (entry: yauzl.Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    zip.on('entry', onEntry);
    zip.on('end', onEnd);
    zip.on('error', onError);
    zip.readEntry();
  });
}

type ReadResult = { data: Buffer } | { tooLarge: true };

/** Reads one entry, stopping the moment it passes the photo limit or the archive's total. */
function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, counter: { bytes: number }): Promise<ReadResult> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) { reject(error ?? new Error('unreadable entry')); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (outcome: () => void) => { if (!settled) { settled = true; outcome(); } };
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        counter.bytes += chunk.length;
        if (counter.bytes > PHOTO_ZIP_LIMITS.totalBytes) {
          finish(() => reject(new ZipRefused(`حجم الصور بعد فك الضغط أكبر من ${Math.round(PHOTO_ZIP_LIMITS.totalBytes / 1048576)} ميغابايت. قسّم الصور على أكثر من ملف ZIP.`)));
          stream.destroy();
          return;
        }
        if (size > PHOTO_ZIP_LIMITS.imageBytes) {
          finish(() => resolve({ tooLarge: true }));
          stream.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', (streamError) => finish(() => reject(streamError)));
      stream.on('end', () => finish(() => resolve({ data: Buffer.concat(chunks, size) })));
    });
  });
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1048576)} ميغابايت`;

/**
 * Reads the archive entry by entry. Refuses it whole (and keeps nothing) when it
 * is not a ZIP, has unsafe paths, carries a program, or passes a limit; every
 * other problem is reported on its own entry.
 */
export async function scanPhotoZip(buffer: Buffer): Promise<ZipScan> {
  const signature = buffer.length >= 4 ? buffer.readUInt32LE(0) : 0;
  if (signature !== 0x04034b50 && signature !== 0x06054b50) throw badRequest('الملف ليس ملفاً مضغوطاً بصيغة ZIP.');
  if (buffer.length > PHOTO_ZIP_LIMITS.zipBytes) throw badRequest(`ملف ZIP أكبر من ${megabytes(PHOTO_ZIP_LIMITS.zipBytes)}.`);
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(buffer);
  } catch (error) {
    throw readFailure(error);
  }
  // Errors are taken where each read waits for them; this keeps a late one from stopping the server.
  zip.on('error', () => undefined);
  const photos: ZipPhoto[] = [];
  const counter = { bytes: 0 };
  let entries = 0;
  let images = 0;
  let ignored = 0;
  try {
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      entries += 1;
      if (entries > PHOTO_ZIP_LIMITS.entries) throw new ZipRefused(`في الملف أكثر من ${PHOTO_ZIP_LIMITS.entries} عنصر. قسّمه على أكثر من ملف ZIP.`);
      const fileName = entry.fileName;
      if (fileName.endsWith('/')) continue;
      const base = fileName.split('/').pop() ?? fileName;
      if (isSystemFile(fileName, base)) { ignored += 1; continue; }
      const ext = extensionOf(base);
      if (EXECUTABLE_EXTENSIONS.has(ext)) throw new ZipRefused(`الملف المضغوط يحتوي ملفاً تنفيذياً (${base}). أزله ثم أعد المحاولة.`);
      const stem = normaliseDigits(ext ? base.slice(0, base.length - ext.length - 1) : base).trim();
      const unixMode = (entry.versionMadeBy >> 8) === 3 ? (entry.externalFileAttributes >>> 16) & 0o170000 : 0;
      if (unixMode === 0o120000) {
        photos.push({ entry: fileName, stem: '', status: 'not_image', reason: 'رابط لملف آخر وليس صورة' });
        continue;
      }
      if (!IMAGE_EXTENSIONS.has(ext)) {
        // A photo in another format keeps its number (so the person knows whose photo to convert); other files have none.
        const pictureLike = ['heic', 'heif', 'gif', 'bmp', 'tif', 'tiff', 'svg'].includes(ext);
        const reason = ext === 'heic' || ext === 'heif'
          ? 'صيغة HEIC غير مدعومة؛ احفظ الصورة بصيغة JPG'
          : ARCHIVE_EXTENSIONS.has(ext) ? 'ملف مضغوط داخل الملف؛ ضع الصور مباشرة في ملف ZIP واحد'
            : ['gif', 'bmp', 'tif', 'tiff', 'svg'].includes(ext) ? `صيغة ${ext.toUpperCase()} غير مدعومة؛ المقبول JPG وJPEG وPNG وWebP`
              : 'ليس صورة؛ المقبول JPG وJPEG وPNG وWebP';
        photos.push({ entry: fileName, stem: pictureLike ? stem : '', status: 'not_image', reason });
        continue;
      }
      images += 1;
      if (images > PHOTO_ZIP_LIMITS.images) throw new ZipRefused(`في الملف أكثر من ${PHOTO_ZIP_LIMITS.images} صورة. قسّمها على أكثر من ملف ZIP.`);
      if (entry.isEncrypted()) {
        photos.push({ entry: fileName, stem, status: 'encrypted', reason: 'الصورة محمية بكلمة مرور داخل الملف المضغوط' });
        continue;
      }
      if (entry.uncompressedSize > PHOTO_ZIP_LIMITS.imageBytes) {
        photos.push({ entry: fileName, stem, status: 'too_large', reason: `أكبر من ${megabytes(PHOTO_ZIP_LIMITS.imageBytes)}` });
        continue;
      }
      if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > PHOTO_ZIP_LIMITS.ratio) {
        photos.push({ entry: fileName, stem, status: 'corrupt', reason: 'نسبة ضغط غير طبيعية لصورة' });
        continue;
      }
      let read: ReadResult;
      try {
        read = await readEntry(zip, entry, counter);
      } catch (error) {
        if (error instanceof ZipRefused) throw error;
        const unsupported = /compression method/i.test(String((error as Error)?.message));
        photos.push({ entry: fileName, stem, status: 'corrupt', reason: unsupported ? 'طريقة ضغط غير مدعومة؛ أعد ضغط الصور بأداة ZIP العادية' : 'تعذر فك ضغطها؛ الملف تالف' });
        continue;
      }
      if ('tooLarge' in read) {
        photos.push({ entry: fileName, stem, status: 'too_large', reason: `أكبر من ${megabytes(PHOTO_ZIP_LIMITS.imageBytes)}` });
        continue;
      }
      if (looksExecutable(read.data)) throw new ZipRefused(`الملف المضغوط يحتوي ملفاً تنفيذياً باسم صورة (${base}). أزله ثم أعد المحاولة.`);
      if (!isImageSignature(read.data)) {
        photos.push({ entry: fileName, stem, status: 'corrupt', reason: 'محتواه ليس صورة رغم امتداده' });
        continue;
      }
      try {
        const prepared = await preparePhoto(read.data);
        photos.push({ entry: fileName, stem, status: 'ok', reason: null, ...prepared });
      } catch (error) {
        const tooBig = /pixel limit|exceeds pixel/i.test(String((error as Error)?.message));
        photos.push({ entry: fileName, stem, status: tooBig ? 'too_large' : 'corrupt', reason: tooBig ? 'أبعاد الصورة أكبر من المسموح' : 'الصورة تالفة أو غير مكتملة' });
      }
    }
  } catch (error) {
    if (error instanceof ZipRefused) throw badRequest(error.message);
    throw readFailure(error);
  } finally {
    zip.close();
  }
  return { photos, ignored, inflatedBytes: counter.bytes };
}

function readFailure(error: unknown) {
  const message = String((error as Error)?.message ?? '');
  if (/absolute path|invalid relative path|invalid characters in fileName/i.test(message)) {
    return badRequest('الملف المضغوط يحتوي مسارات غير آمنة (خارج المجلد). لم يُقرأ شيء منه.');
  }
  if (/encrypted/i.test(message)) return badRequest('الملف المضغوط محمي بكلمة مرور. أعد ضغطه بدونها.');
  if (/multi-disk/i.test(message)) return badRequest('الملف المضغوط مقسّم على أكثر من جزء. اجمعه في ملف ZIP واحد.');
  return badRequest('تعذرت قراءة ملف ZIP: الملف تالف أو غير مكتمل.');
}

// --- Between the preview and the confirmation -------------------------------------------------
// The checked photos wait, encrypted like every stored file, under photo-imports/<id>/ for the
// person who uploaded them; the confirmation takes exactly what was previewed. Nothing waits longer
// than STAGING_HOURS.

export const STAGING_HOURS = 2;
const STAGING_DIR = 'photo-imports';

export interface StagedItem {
  index: number;
  entry: string;
  employeeNo: string;
  employeeId: string | null;
  status: 'ready' | 'has_photo' | 'unmatched' | 'duplicate' | ZipEntryStatus;
  reason: string | null;
  stagedKey: string | null;
  sha256: string | null;
  bytes: number | null;
}

export interface StagedImport {
  id: string;
  userId: string;
  createdAt: string;
  fileName: string;
  zipSha256: string;
  ignored: number;
  items: StagedItem[];
}

const stagingKey = (importId: string, name: string) => `${STAGING_DIR}/${importId}/${name}`;

async function writeEncrypted(key: string, data: Buffer): Promise<void> {
  const target = resolveKey(key);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
  await fsp.writeFile(target, encryptBuffer(data), { mode: 0o640 });
}

export async function stagePhoto(importId: string, index: number, photo: Buffer): Promise<string> {
  const key = stagingKey(importId, `${index}.jpg`);
  await writeEncrypted(key, photo);
  return key;
}

export async function saveStagedImport(staged: StagedImport): Promise<void> {
  await writeEncrypted(stagingKey(staged.id, 'manifest.json'), Buffer.from(JSON.stringify(staged)));
}

/** The waiting import, or null when it is missing, expired, or belongs to someone else. */
export async function loadStagedImport(importId: string, userId: string): Promise<StagedImport | null> {
  let staged: StagedImport;
  try {
    staged = JSON.parse(decryptBuffer(await fsp.readFile(resolveKey(stagingKey(importId, 'manifest.json')))).toString('utf8')) as StagedImport;
  } catch {
    return null;
  }
  if (staged.id !== importId || staged.userId !== userId) return null;
  if (Date.now() - Date.parse(staged.createdAt) > STAGING_HOURS * 3600_000) {
    await discardStagedImport(importId);
    return null;
  }
  return staged;
}

export async function readStagedPhoto(key: string): Promise<Buffer> {
  if (!key.startsWith(`${STAGING_DIR}/`)) throw new Error('Not a staged photo');
  return decryptBuffer(await fsp.readFile(resolveKey(key)));
}

export async function discardStagedImport(importId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(importId)) return;
  await fsp.rm(resolveKey(`${STAGING_DIR}/${importId}`), { recursive: true, force: true });
}

/** The ZIP upload: one file, held in memory while it is checked, refused past the size limit with a clear message. */
export function uploadPhotoZip(field: string) {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PHOTO_ZIP_LIMITS.zipBytes, files: 1, fields: 5 },
  }).single(field);
  return (req: Request, res: Response, next: NextFunction) => handler(req, res, (error?: unknown) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      next(new HttpError(413, `ملف ZIP أكبر من ${megabytes(PHOTO_ZIP_LIMITS.zipBytes)}. قسّم الصور على أكثر من ملف.`));
      return;
    }
    next(error);
  });
}

/** Removes imports nobody confirmed in time. */
export async function sweepStagedImports(now = Date.now()): Promise<number> {
  const root = path.join(uploadRoot(), STAGING_DIR);
  let names: string[] = [];
  try { names = await fsp.readdir(root); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
    try {
      const info = await fsp.stat(path.join(root, name));
      if (now - info.mtimeMs > STAGING_HOURS * 3600_000) {
        await discardStagedImport(name);
        removed += 1;
      }
    } catch { /* already gone */ }
  }
  return removed;
}
