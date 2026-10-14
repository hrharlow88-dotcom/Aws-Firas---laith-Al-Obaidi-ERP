import { NextFunction, Request, Response } from 'express';

/** An error with an HTTP status and an Arabic message safe to show the user. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const forbidden = (message = 'ليس لديك صلاحية لتنفيذ هذا الإجراء.') => new HttpError(403, message);
export const notFound = (message = 'السجل المطلوب غير موجود.') => new HttpError(404, message);
export const conflict = (message: string, details?: unknown) => new HttpError(409, message, details);

export function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

export function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

export function assertOnlyKeys(input: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw badRequest('يتضمن الطلب حقلاً غير معروف أو غير قابل للتعديل.', { fields: unknown });
}

export function optionalText(input: Record<string, unknown>, key: string, max: number): string | null | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw badRequest('تحقق من نوع الحقول النصية المدخلة.', { field: key });
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`الحقل أطول من المسموح (${max} محرفاً).`, { field: key });
  return trimmed || null;
}

export function requiredText(input: Record<string, unknown>, key: string, max: number, label: string): string {
  const value = optionalText(input, key, max);
  if (!value) throw badRequest(`الحقل «${label}» مطلوب.`, { field: key });
  return value;
}

export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
  { min = -Infinity, max = Infinity, integer = false } = {},
): number | null | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < min || parsed > max ||
    (integer && !Number.isInteger(parsed))) {
    throw badRequest('قيمة رقمية غير صالحة.', { field: key });
  }
  return parsed;
}

export function pageParams(req: Request, defaultSize = 50, maxSize = 200) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number(req.query.pageSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function queryText(req: Request, key: string): string {
  const value = req.query[key];
  return typeof value === 'string' ? value.trim() : '';
}
