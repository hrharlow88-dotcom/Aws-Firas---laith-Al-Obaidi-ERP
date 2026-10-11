import { NextFunction, Request, Response } from 'express';

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateUuidParam(req: Request, res: Response, next: NextFunction): void {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ message: 'معرّف السجل غير صالح.' });
    return;
  }
  next();
}
