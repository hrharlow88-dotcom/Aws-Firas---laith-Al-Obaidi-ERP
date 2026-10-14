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
import AttendanceController from '../controllers/AttendanceController';
import PayrollController from '../controllers/PayrollController';
import FinanceController from '../controllers/FinanceController';
import IntegrationController, { requireApiKey } from '../controllers/IntegrationController';
import AuditController from '../controllers/AuditController';
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

const integrationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
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

router.get('/attendance/shifts', requireAuth, allowPermission('attendance.view'), asyncRoute(AttendanceController.listShifts));
router.post('/attendance/shifts', requireAuth, allowPermission('attendance.manage'), asyncRoute(AttendanceController.saveShift));
router.put('/attendance/shifts/:id', requireAuth, allowPermission('attendance.manage'), validateUuidParam, asyncRoute(AttendanceController.saveShift));
router.post('/attendance/shifts-assign', requireAuth, allowPermission('attendance.manage'), asyncRoute(AttendanceController.assignShift));
router.get('/attendance/devices', requireAuth, allowPermission('attendance.view'), asyncRoute(AttendanceController.listDevices));
router.post('/attendance/devices', requireAuth, allowPermission('attendance.manage'), asyncRoute(AttendanceController.saveDevice));
router.put('/attendance/devices/:id', requireAuth, allowPermission('attendance.manage'), validateUuidParam, asyncRoute(AttendanceController.saveDevice));
router.post('/attendance/imports', requireAuth, allowPermission('attendance.manage'), uploadSingle('file'), asyncRoute(AttendanceController.importFile));
router.get('/attendance/imports', requireAuth, allowPermission('attendance.view'), asyncRoute(AttendanceController.listImports));
router.get('/attendance/punches', requireAuth, allowPermission('attendance.view'), asyncRoute(AttendanceController.listPunches));
router.post('/attendance/punches', requireAuth, allowPermission('attendance.manage'), asyncRoute(AttendanceController.addPunch));
router.post('/attendance/punches/:id/void', requireAuth, allowPermission('attendance.manage'), validateUuidParam, asyncRoute(AttendanceController.voidPunch));
router.get('/attendance/unmatched', requireAuth, allowPermission('attendance.manage'), asyncRoute(AttendanceController.unmatched));
router.post('/attendance/unmatched/assign', requireAuth, allowPermission('attendance.manage'), asyncRoute(AttendanceController.assignPin));
router.post('/attendance/compute', requireAuth, allowPermission('attendance.manage'), asyncRoute(AttendanceController.compute));
router.get('/attendance/days', requireAuth, allowPermission('attendance.view'), asyncRoute(AttendanceController.listDays));
router.get('/attendance/summary', requireAuth, allowPermission('attendance.view'), asyncRoute(AttendanceController.summary));
router.put('/attendance/days/:employeeId/:date', requireAuth, allowPermission('attendance.manage'), asyncRoute(AttendanceController.overrideDay));
router.get('/attendance/today', requireAuth, allowPermission('attendance.view'), asyncRoute(AttendanceController.today));

router.get('/payroll/runs', requireAuth, allowPermission('payroll.view'), asyncRoute(PayrollController.listRuns));
router.post('/payroll/runs', requireAuth, allowPermission('payroll.prepare'), asyncRoute(PayrollController.createRun));
router.get('/payroll/runs/:id', requireAuth, allowPermission('payroll.view'), validateUuidParam, asyncRoute(PayrollController.getRun));
router.post('/payroll/runs/:id/calculate', requireAuth, allowPermission('payroll.prepare'), validateUuidParam, asyncRoute(PayrollController.calculate));
router.post('/payroll/runs/:id/approve', requireAuth, allowPermission('payroll.approve'), validateUuidParam, asyncRoute(PayrollController.approve));
router.post('/payroll/runs/:id/reopen', requireAuth, allowPermission('payroll.approve'), validateUuidParam, asyncRoute(PayrollController.reopen));
router.post('/payroll/runs/:id/cancel', requireAuth, allowPermission('payroll.prepare'), validateUuidParam, asyncRoute(PayrollController.cancel));
router.get('/payroll/runs/:id/payslips/:employeeId', requireAuth, allowPermission('payroll.view'), validateUuidParam, asyncRoute(PayrollController.payslip));
router.get('/payroll/runs/:id/register.xlsx', requireAuth, allowPermission('payroll.view'), validateUuidParam, asyncRoute(PayrollController.exportRegister));
router.get('/payroll/runs/:id/bank.csv', requireAuth, allowPermission('payroll.view'), validateUuidParam, asyncRoute(PayrollController.bankFile));
router.get('/employees/:id/payslips', requireAuth, allowPermission('payroll.view'), validateUuidParam, asyncRoute(PayrollController.employeeHistory));
router.get('/payroll/inputs', requireAuth, allowPermission('payroll.view'), asyncRoute(PayrollController.listInputs));
router.post('/payroll/inputs', requireAuth, allowPermission('payroll.prepare'), asyncRoute(PayrollController.addInput));
router.delete('/payroll/inputs/:id', requireAuth, allowPermission('payroll.prepare'), validateUuidParam, asyncRoute(PayrollController.deleteInput));
router.post('/payroll/inputs/import', requireAuth, allowPermission('payroll.prepare'), uploadSingle('file'), asyncRoute(PayrollController.importInputs));

router.get('/finance/mappings', requireAuth, allowPermission('finance.view'), asyncRoute(FinanceController.listMappings));
router.put('/finance/mappings', requireAuth, allowPermission('finance.manage'), asyncRoute(FinanceController.saveMappings));
router.get('/finance/sap/status', requireAuth, allowPermission('finance.view'), asyncRoute(FinanceController.sapStatus));
router.get('/finance/sap/accounts', requireAuth, allowPermission('finance.manage'), asyncRoute(FinanceController.sapAccounts));
router.get('/finance/sap/cost-centers', requireAuth, allowPermission('finance.manage'), asyncRoute(FinanceController.sapCostCenters));
router.get('/finance/journals', requireAuth, allowPermission('finance.view'), asyncRoute(FinanceController.listJournals));
router.get('/finance/journals/:id', requireAuth, allowPermission('finance.view'), validateUuidParam, asyncRoute(FinanceController.getJournal));
router.get('/finance/journals/:id/export.csv', requireAuth, allowPermission('finance.view'), validateUuidParam, asyncRoute(FinanceController.exportJournal));
router.post('/finance/journals/from-payroll/:runId', requireAuth, allowPermission('finance.post'), asyncRoute(FinanceController.createFromPayroll));
router.post('/finance/journals/:id/post', requireAuth, allowPermission('finance.post'), validateUuidParam, asyncRoute(FinanceController.post));
router.post('/finance/journals/:id/mark-posted', requireAuth, allowPermission('finance.post'), validateUuidParam, asyncRoute(FinanceController.markPostedManually));
router.post('/finance/journals/:id/cancel', requireAuth, allowPermission('finance.post'), validateUuidParam, asyncRoute(FinanceController.cancel));

router.get('/audit', requireAuth, allowPermission('audit.view'), asyncRoute(AuditController.list));

router.get('/integrations/keys', requireAuth, allowPermission('integrations.manage'), asyncRoute(IntegrationController.listKeys));
router.post('/integrations/keys', requireAuth, allowPermission('integrations.manage'), asyncRoute(IntegrationController.createKey));
router.post('/integrations/keys/:id/revoke', requireAuth, allowPermission('integrations.manage'), validateUuidParam, asyncRoute(IntegrationController.revokeKey));
router.get('/integrations/v1/employees', integrationLimiter, requireApiKey('employees.read'), asyncRoute(IntegrationController.employees));
router.get('/integrations/v1/org', integrationLimiter, requireApiKey('org.read'), asyncRoute(IntegrationController.org));
router.get('/integrations/v1/attendance-summary', integrationLimiter, requireApiKey('attendance.read'), asyncRoute(IntegrationController.attendanceSummary));

export default router;
