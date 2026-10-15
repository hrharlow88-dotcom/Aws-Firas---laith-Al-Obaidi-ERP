export const ROLES = [
  'super_admin',
  'hr_manager',
  'hr_staff',
  'finance',
  'branch_manager',
  'viewer',
  'employee',
  'line_manager',
  'payroll_officer',
  'auditor',
  'executive',
  'it_admin',
] as const;

export type UserRole = (typeof ROLES)[number];

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  branchId: string | null;
  /** The employee record of the person behind the account, when linked. */
  employeeId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
