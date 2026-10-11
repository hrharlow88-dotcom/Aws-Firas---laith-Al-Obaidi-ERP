export const ROLES = [
  'super_admin',
  'hr_manager',
  'hr_staff',
  'finance',
  'branch_manager',
  'viewer',
] as const;

export type UserRole = (typeof ROLES)[number];

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  branchId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
