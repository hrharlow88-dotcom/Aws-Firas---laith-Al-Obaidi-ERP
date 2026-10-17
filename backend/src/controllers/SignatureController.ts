import { Request, Response } from 'express';
import { transaction } from '../db/query';
import { saveUserSignature, userSignature, validSignatureImage } from '../services/signatures';
import { recordAudit } from '../utils/audit';
import { badRequest, body } from '../utils/http';

/** The signed-in person's own drawn signature, used for approvals. */
export class SignatureController {
  static async get(req: Request, res: Response): Promise<void> {
    res.json({ data: { image: await userSignature(req.user!.id) } });
  }

  static async save(req: Request, res: Response): Promise<void> {
    const image = body(req).image;
    if (!validSignatureImage(image)) throw badRequest('ارسم التوقيع ثم احفظه.');
    await transaction(async (tx) => {
      await saveUserSignature(req.user!.id, image, tx);
      await recordAudit(req, tx, 'user.signature_saved', 'user', req.user!.id);
    });
    res.json({ data: { saved: true } });
  }
}

export default SignatureController;
