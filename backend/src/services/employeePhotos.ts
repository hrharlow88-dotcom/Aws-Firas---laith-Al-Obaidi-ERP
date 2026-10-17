import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { decryptBuffer, encryptBuffer } from '../utils/crypto';
import { readStoredFile, resolveKey } from './storage';

/**
 * Small copies of employee photos for lists and the org chart. One thumbnail per
 * stored photo (named after its document), encrypted like the photo, made the
 * first time it is asked for. A new photo is a new document, so a replaced photo
 * never shows its old thumbnail.
 */
export const THUMB_SIZE = 80;
const THUMB_DIR = 'photo-thumbs';

const thumbKey = (documentId: string) => `${THUMB_DIR}/${documentId}.jpg`;

export async function makeThumb(photo: Buffer): Promise<Buffer> {
  return sharp(photo, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 72 })
    .toBuffer();
}

export async function saveThumb(documentId: string, thumb: Buffer): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) throw new Error('Invalid document id');
  const target = resolveKey(thumbKey(documentId));
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
  await fsp.writeFile(target, encryptBuffer(thumb), { mode: 0o640 });
}

/** The thumbnail of a stored photo; null when the photo cannot be read. */
export async function photoThumb(documentId: string, storageKey: string): Promise<Buffer | null> {
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) return null;
  try {
    return decryptBuffer(await fsp.readFile(resolveKey(thumbKey(documentId))));
  } catch { /* not made yet */ }
  try {
    const thumb = await makeThumb(await readStoredFile(storageKey));
    await saveThumb(documentId, thumb);
    return thumb;
  } catch {
    return null;
  }
}
