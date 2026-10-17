import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { badRequest } from './http';

/**
 * Field-level encryption for identity and bank numbers (AES-256-GCM).
 * Values are stored as "enc:v1:<iv>:<tag>:<ciphertext>" in base64 parts.
 * The key comes from DATA_ENCRYPTION_KEY (32 bytes, base64) and never
 * touches the database, so a leaked database dump does not expose them.
 */
const PREFIX = 'enc:v1:';

function key(): Buffer | null {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) return null;
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes encoded in base64 (openssl rand -base64 32).');
  }
  return decoded;
}

export function encryptionConfigured(): boolean {
  return key() !== null;
}

export function encryptField(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null || value === '') return value === '' ? null : value;
  const secret = key();
  if (!secret) {
    throw badRequest('لا يمكن حفظ أرقام الهوية والحسابات قبل ضبط مفتاح التشفير DATA_ENCRYPTION_KEY على الخادم.');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptField(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith(PREFIX)) return value;
  const secret = key();
  if (!secret) return null;
  const [iv, tag, data] = value.slice(PREFIX.length).split(':');
  try {
    const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Shows only the last four characters, e.g. for lists and payslips. */
export function maskTail(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Files at rest: "LOENC1" + iv(12) + tag(16) + AES-256-GCM ciphertext. Without a key, files stay as they are. */
const FILE_MAGIC = Buffer.from('LOENC1');

export function isEncryptedFile(buffer: Buffer): boolean {
  return buffer.length > 34 && buffer.subarray(0, 6).equals(FILE_MAGIC);
}

export function encryptBuffer(plain: Buffer): Buffer {
  const secret = key();
  if (!secret) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([FILE_MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptBuffer(stored: Buffer): Buffer {
  if (!isEncryptedFile(stored)) return stored;
  const secret = key();
  if (!secret) throw new Error('DATA_ENCRYPTION_KEY is needed to read encrypted files');
  const decipher = createDecipheriv('aes-256-gcm', secret, stored.subarray(6, 18));
  decipher.setAuthTag(stored.subarray(18, 34));
  return Buffer.concat([decipher.update(stored.subarray(34)), decipher.final()]);
}
