import { Request, Response } from 'express';
import multer from 'multer';
import { importCompany } from '../db/importCompany';
import { uploadedName } from '../services/storage';

/** Up to ten workbooks of 15 MB each: branch payroll files, the register and the leave system. */
export const uploadWorkbooks = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 10, fields: 5 },
}).array('files', 10);

export class CompanyImportController {
  /**
   * Loads the company's HR workbooks on a server the files cannot be copied
   * to directly. System administrator only; the files are read in memory and
   * never stored. Re-running updates rather than duplicates.
   */
  static async upload(req: Request, res: Response): Promise<void> {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) { res.status(400).json({ message: 'أرفق ملفات الإكسل.' }); return; }
    const bad = files.find((file) => file.buffer.subarray(0, 2).toString('latin1') !== 'PK');
    if (bad) { res.status(400).json({ message: `${uploadedName(bad, 'file')} ليس ملف xlsx.` }); return; }
    try {
      const lines = await importCompany(files.map((file) => ({ name: uploadedName(file, 'file.xlsx'), data: file.buffer })), req.user!.id);
      res.json({ data: { lines } });
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'تعذر الاستيراد.' });
    }
  }
}

export default CompanyImportController;
