import { createHash, randomUUID } from 'node:crypto';
import { Transaction } from 'sequelize';
import { execute, select, selectOne } from '../db/query';

export const STEPS = ['hr', 'audit', 'ceo', 'finance'] as const;
export type SignStep = (typeof STEPS)[number];

export const STEP_LABELS: Record<SignStep, string> = {
  hr: 'الموارد البشرية',
  audit: 'التدقيق',
  ceo: 'المدير التنفيذي',
  finance: 'المالية (الصرف)',
};

/** A drawn signature as a PNG data URL, bounded in size. */
export function validSignatureImage(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) && value.length > 200 && value.length <= 300000;
}

export async function userSignature(userId: string, tx?: Transaction | null): Promise<string | null> {
  const row = await selectOne<{ image: string }>('SELECT image FROM user_signatures WHERE user_id = :userId', { userId }, tx);
  return row?.image ?? null;
}

export async function saveUserSignature(userId: string, image: string, tx?: Transaction | null): Promise<void> {
  await execute(
    `INSERT INTO user_signatures (user_id, image, updated_at) VALUES (:userId, :image, now())
     ON CONFLICT (user_id) DO UPDATE SET image = EXCLUDED.image, updated_at = now()`,
    { userId, image }, tx,
  );
}

export interface Signoff {
  id: string; step: SignStep; userId: string; userName: string; signature: string; note: string | null; signedAt: string;
}

export async function liveSignoffs(runId: string, tx?: Transaction | null): Promise<Signoff[]> {
  return select<Signoff>(
    `SELECT s.id, s.step, s.user_id AS "userId", u.name AS "userName", s.signature, s.note, s.signed_at AS "signedAt"
       FROM payroll_run_signoffs s JOIN users u ON u.id = s.user_id
      WHERE s.run_id = :runId AND s.voided_at IS NULL
      ORDER BY array_position(ARRAY['hr','audit','ceo','finance']::varchar[], s.step)`,
    { runId }, tx,
  );
}

export async function addSignoff(
  runId: string, step: SignStep, userId: string, signature: string, note: string | null, ip: string | null, tx: Transaction,
): Promise<void> {
  await execute(
    `INSERT INTO payroll_run_signoffs (id, run_id, step, user_id, signature, signature_sha256, note, ip)
     VALUES (:id, :runId, :step, :userId, :signature, :hash, :note, :ip)`,
    { id: randomUUID(), runId, step, userId, signature, hash: createHash('sha256').update(signature).digest('hex'), note, ip }, tx,
  );
}

/** Earlier sign-offs stop counting (kept for the record) when the run changes. */
export async function voidSignoffs(runId: string, reason: string, tx: Transaction): Promise<number> {
  const rows = await execute<{ id: string }>(
    `UPDATE payroll_run_signoffs SET voided_at = now(), voided_reason = :reason
      WHERE run_id = :runId AND voided_at IS NULL RETURNING id`,
    { runId, reason }, tx,
  );
  return rows.length;
}
