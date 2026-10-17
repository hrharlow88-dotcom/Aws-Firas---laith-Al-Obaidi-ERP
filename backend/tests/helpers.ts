import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app';
import { Branch, Employee, User } from '../src/models';
import type { UserRole } from '../src/types';

export const app = createApp();

let passwordHash: string | null = null;

export async function makeUser(role: UserRole, branchId: string | null = null, employeeId: string | null = null) {
  passwordHash ??= await bcrypt.hash('TestPassword#1', 4);
  const user = await User.create({
    name: `مستخدم ${role}`,
    email: `${role}.${randomUUID().slice(0, 8)}@test.local`,
    passwordHash,
    role,
    branchId,
    employeeId,
  });
  const token = jwt.sign({ sub: user.id, ver: user.tokenVersion }, process.env.JWT_SECRET!, { expiresIn: '1h' });
  return { user, token, auth: { Authorization: `Bearer ${token}` } };
}

export async function makeBranch(name = 'فرع الاختبار') {
  return Branch.create({ code: `B-${randomUUID().slice(0, 6)}`, name, city: 'بغداد' });
}

export async function makeEmployee(branchId: string, overrides: Partial<Parameters<typeof Employee.create>[0]> = {}) {
  return Employee.create({
    employeeNo: `E-${randomUUID().slice(0, 8)}`,
    fullName: 'موظف تجريبي',
    branchId,
    department: 'المبيعات',
    position: 'مندوب مبيعات',
    hireDate: '2024-01-01',
    ...overrides,
  });
}

export const api = () => request(app);
