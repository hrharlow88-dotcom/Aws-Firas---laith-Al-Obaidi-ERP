import express, { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import AuthController from '../controllers/AuthController';
import BranchController from '../controllers/BranchController';
import EmployeeController from '../controllers/EmployeeController';
import UserController from '../controllers/UserController';
import SettingsController from '../controllers/SettingsController';
import LeaveController from '../controllers/LeaveController';
import OrgController from '../controllers/OrgController';
import EmployeeFileController from '../controllers/EmployeeFileController';
import { uploadSingle } from '../services/storage';
import { allowAnyPermission, allowPermission, allowRoles, requireAuth } from '../middleware/auth';
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

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'طلبات كثيرة. حاول بعد قليل.' },
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

router.get('/leaves', requireAuth, allowPermission('leaves.view'), asyncRoute(LeaveController.listRequests));
router.post('/leaves', requireAuth, allowPermission('leaves.request'), asyncRoute(LeaveController.createRequest));
router.get('/leaves/balances', requireAuth, allowPermission('leaves.view'), asyncRoute(LeaveController.balances));
router.get('/leaves/ledger', requireAuth, allowPermission('leaves.view'), asyncRoute(LeaveController.ledger));
router.post('/leaves/balances', requireAuth, allowPermission('leaves.manage_balances'), asyncRoute(LeaveController.adjustBalance));
router.post('/leaves/:id/decision', requireAuth, allowPermission('leaves.approve'), validateUuidParam, asyncRoute(LeaveController.decide));
router.post('/leaves/:id/cancel', requireAuth, allowAnyPermission('leaves.request', 'leaves.manage_balances'), validateUuidParam, asyncRoute(LeaveController.cancel));

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

router.get('/employees/:id', requireAuth, validateUuidParam, asyncRoute(EmployeeFileController.detail));
router.get('/employees/:id/photo', requireAuth, validateUuidParam, asyncRoute(EmployeeFileController.photo));
router.post('/employees/:id/photo', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, uploadSingle('file'), asyncRoute(EmployeeFileController.uploadPhoto));
router.get('/employees/:id/profile', requireAuth, allowPermission('employees.view_profile'), validateUuidParam, asyncRoute(EmployeeFileController.getProfile));
router.put('/employees/:id/profile', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(EmployeeFileController.updateProfile));
router.get('/employees/:id/compensation', requireAuth, allowPermission('compensation.view'), validateUuidParam, asyncRoute(EmployeeFileController.listCompensation));
router.post('/employees/:id/compensation', requireAuth, allowPermission('compensation.manage'), validateUuidParam, asyncRoute(EmployeeFileController.addCompensation));
router.get('/employees/:id/contracts', requireAuth, allowPermission('employees.view_profile'), validateUuidParam, asyncRoute(EmployeeFileController.listContracts));
router.post('/employees/:id/contracts', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(EmployeeFileController.saveContract));
router.put('/employees/:id/contracts/:contractId', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(EmployeeFileController.saveContract));
router.get('/employees/:id/documents', requireAuth, allowPermission('employees.view_profile'), validateUuidParam, asyncRoute(EmployeeFileController.listDocuments));
router.post('/employees/:id/documents', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, uploadSingle('file'), asyncRoute(EmployeeFileController.uploadDocument));
router.get('/documents/:documentId/file', requireAuth, allowPermission('employees.view_profile'), asyncRoute(EmployeeFileController.downloadDocument));
router.delete('/documents/:documentId', requireAuth, allowPermission('employees.manage_profile'), asyncRoute(EmployeeFileController.deleteDocument));
router.get('/employees/:id/card', requireAuth, allowPermission('employees.view_profile'), validateUuidParam, asyncRoute(EmployeeFileController.card));
router.post('/employees/:id/card', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(EmployeeFileController.issueCard));
router.get('/hr/alerts', requireAuth, allowPermission('employees.view_profile'), asyncRoute(EmployeeFileController.alerts));

router.get('/public/cards/:token', publicLimiter, asyncRoute(EmployeeFileController.verifyCard));

router.get('/org/departments', requireAuth, asyncRoute(OrgController.listDepartments));
router.post('/org/departments', requireAuth, allowPermission('org.manage'), asyncRoute(OrgController.createDepartment));
router.put('/org/departments/:id', requireAuth, allowPermission('org.manage'), validateUuidParam, asyncRoute(OrgController.updateDepartment));
router.get('/org/job-titles', requireAuth, asyncRoute(OrgController.listJobTitles));
router.post('/org/job-titles', requireAuth, allowPermission('org.manage'), asyncRoute(OrgController.createJobTitle));
router.put('/org/job-titles/:id', requireAuth, allowPermission('org.manage'), validateUuidParam, asyncRoute(OrgController.updateJobTitle));
router.get('/org/chart', requireAuth, asyncRoute(OrgController.chart));

export default router;
