import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { selectOne } from '../db/query';

/**
 * The nightly backups (database dump and the encrypted documents) live on the
 * server's disk. The owner downloads a copy to keep it off the server; the
 * system reminds them weekly until they do.
 */

const NAME = /^(db|uploads)_(pre-update_)?\d{4}-\d{2}-\d{2}_\d{4}\.(dump|tar\.gz)$/;

export interface BackupFile { name: string; kind: 'database' | 'files'; size: number; createdAt: string }

export function backupDir(): string | null {
  const dir = process.env.BACKUP_DIR;
  return dir && fs.existsSync(dir) ? path.resolve(dir) : null;
}

export async function listBackups(): Promise<BackupFile[]> {
  const dir = backupDir();
  if (!dir) return [];
  const names = (await fsp.readdir(dir)).filter((name) => NAME.test(name));
  const files = await Promise.all(names.map(async (name) => {
    const stat = await fsp.stat(path.join(dir, name));
    return { name, kind: name.startsWith('db_') ? 'database' : 'files', size: stat.size, createdAt: stat.mtime.toISOString() } as BackupFile;
  }));
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 80);
}

/** The full path of a listed backup, or null for any other name. */
export function backupPath(name: string): string | null {
  const dir = backupDir();
  if (!dir || !NAME.test(name)) return null;
  const target = path.resolve(dir, name);
  return target.startsWith(dir + path.sep) && fs.existsSync(target) ? target : null;
}

export async function lastDownload(): Promise<string | null> {
  const row = await selectOne<{ at: string }>(
    "SELECT created_at AS at FROM audit_logs WHERE action = 'backup.downloaded' ORDER BY created_at DESC LIMIT 1",
  );
  return row ? new Date(row.at).toISOString() : null;
}
