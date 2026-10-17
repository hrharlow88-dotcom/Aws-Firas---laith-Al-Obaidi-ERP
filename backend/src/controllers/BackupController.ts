import fs from 'node:fs';
import { Request, Response } from 'express';
import { backupDir, backupPath, lastDownload, listBackups } from '../services/backups';
import { recordAudit } from '../utils/audit';
import { notFound } from '../utils/http';

/** The owner keeps a copy of the nightly backups off the server. */
export class BackupController {
  static async list(_req: Request, res: Response): Promise<void> {
    res.json({ data: { available: Boolean(backupDir()), files: await listBackups(), lastDownload: await lastDownload() } });
  }

  static async download(req: Request, res: Response): Promise<void> {
    const file = backupPath(String(req.params.name ?? ''));
    if (!file) throw notFound('النسخة الاحتياطية غير موجودة.');
    const name = String(req.params.name);
    await recordAudit(req, null, 'backup.downloaded', 'backup', null, { file: name });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(file).pipe(res);
  }
}
