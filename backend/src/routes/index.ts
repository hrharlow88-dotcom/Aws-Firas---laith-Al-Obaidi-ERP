import express, { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import AuthController from '../controllers/AuthController';
import BranchController from '../controllers/BranchController';
import EmployeeController from '../controllers/EmployeeController';
import UserController from '../controllers/UserController';
import SettingsController from '../controllers/SettingsController';
import { allowPermission, allowRoles, requireAuth } from '../middleware/auth';
import { validateUuidParam } from '../utils/validation';

const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'محاولات كثيرة. انتظر قليلاً ثم حاول مجدداً.' },
});
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'محاولات كثيرة. انتظر قليلاً ثم حاول مجدداً.' },
});

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

router.post('/auth/login', loginLimiter, asyncRoute(AuthController.login));
router.get('/auth/me', requireAuth, AuthController.me);
router.post('/auth/change-password', requireAuth, passwordLimiter, asyncRoute(AuthController.changePassword));

router.get('/branches', requireAuth, asyncRoute(BranchController.list));
router.post('/branches', requireAuth, allowPermission('branches.manage'), asyncRoute(BranchController.create));
router.put('/branches/:id', requireAuth, allowPermission('branches.manage'), validateUuidParam, asyncRoute(BranchController.update));

router.get('/users', requireAuth, allowPermission('users.manage'), asyncRoute(UserController.list));
router.post('/users', requireAuth, allowPermission('users.manage'), asyncRoute(UserController.create));
router.put('/users/:id', requireAuth, allowPermission('users.manage'), validateUuidParam, asyncRoute(UserController.update));

router.get('/settings', requireAuth, asyncRoute(SettingsController.get));
router.put('/settings', requireAuth, allowRoles('super_admin'), asyncRoute(SettingsController.update));

router.get('/employees', requireAuth, asyncRoute(EmployeeController.list));
router.get('/employees/summary', requireAuth, asyncRoute(EmployeeController.summary));
router.post(
  '/employees',
  requireAuth,
  allowPermission('employees.create'),
  asyncRoute(EmployeeController.create),
);
router.put(
  '/employees/:id',
  requireAuth,
  allowPermission('employees.update'),
  validateUuidParam,
  asyncRoute(EmployeeController.update),
);

export default router;
