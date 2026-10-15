import express, { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import AuthController from '../controllers/AuthController';
import BranchController from '../controllers/BranchController';
import EmployeeController from '../controllers/EmployeeController';
import UserController from '../controllers/UserController';
import SettingsController from '../controllers/SettingsController';
import LeaveController from '../controllers/LeaveController';
import LeaveAccrualController from '../controllers/LeaveAccrualController';
import OrgController from '../controllers/OrgController';
import { JobProfileController } from '../controllers/JobProfileController';
import EmployeeFileController from '../controllers/EmployeeFileController';
import AttendanceController from '../controllers/AttendanceController';
import ContractController from '../controllers/ContractController';
import SelfController from '../controllers/SelfController';
import LoanController from '../controllers/LoanController';
import PayrollController from '../controllers/PayrollController';
import FinanceController from '../controllers/FinanceController';
import IntegrationController, { requireApiKey } from '../controllers/IntegrationController';
import AuditController from '../controllers/AuditController';
import { uploadSingle } from '../services/storage';
import CompanyImportController, { uploadWorkbooks } from '../controllers/CompanyImportController';
import SignatureController from '../controllers/SignatureController';
import RequestController from '../controllers/RequestController';
import DisciplineController from '../controllers/DisciplineController';
import TicketController from '../controllers/TicketController';
import RecruitmentController from '../controllers/RecruitmentController';
import NotificationController from '../controllers/NotificationController';
import SecurityController from '../controllers/SecurityController';
import OwnerController from '../controllers/OwnerController';
import ActivityController from '../controllers/ActivityController';
import RecycleBinController from '../controllers/RecycleBinController';
import ArchiveController from '../controllers/ArchiveController';
import PayrollArchiveController from '../controllers/PayrollArchiveController';
import CalendarController from '../controllers/CalendarController';
import AnnouncementController from '../controllers/AnnouncementController';
import MessageController from '../controllers/MessageController';
import ApprovalsController from '../controllers/ApprovalsController';
import { uploadArchive } from '../services/storage';
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
router.post('/auth/login-location', requireAuth, asyncRoute(AuthController.loginLocation));

// Login-page branding (no sign-in needed).
router.get('/public/branding', publicLimiter, asyncRoute(OwnerController.publicBranding));
router.get('/public/brands/:brandId/logo', asyncRoute(OwnerController.brandLogo));

// Notifications, announcements, approvals inbox, activity.
router.get('/notifications', requireAuth, asyncRoute(NotificationController.mine));
router.post('/notifications/read', requireAuth, asyncRoute(NotificationController.markRead));
router.get('/me/announcements/pending', requireAuth, asyncRoute(AnnouncementController.pending));
router.get('/me/announcements', requireAuth, asyncRoute(AnnouncementController.mine));
router.post('/me/announcements/:id/seen', requireAuth, validateUuidParam, asyncRoute(AnnouncementController.seen));
router.get('/announcements', requireAuth, allowPermission('announcements.manage'), asyncRoute(AnnouncementController.list));
router.post('/announcements', requireAuth, allowPermission('announcements.manage'), asyncRoute(AnnouncementController.create));
router.get('/announcements/:id/receipts', requireAuth, allowPermission('announcements.manage'), validateUuidParam, asyncRoute(AnnouncementController.receipts));
router.post('/announcements/:id/withdraw', requireAuth, allowPermission('announcements.manage'), validateUuidParam, asyncRoute(AnnouncementController.withdraw));
router.get('/messages/templates', requireAuth, allowAnyPermission('messages.send', 'users.manage'), asyncRoute(MessageController.templates));
router.get('/messages/channels', requireAuth, allowAnyPermission('messages.send', 'users.manage'), asyncRoute(MessageController.channels));
router.put('/messages/channels/:channel', requireAuth, allowRoles('super_admin'), asyncRoute(MessageController.saveChannel));
router.post('/messages/channels/:channel/test', requireAuth, allowRoles('super_admin'), asyncRoute(MessageController.test));
router.post('/messages/send', requireAuth, allowPermission('messages.send'), asyncRoute(MessageController.send));
router.get('/messages/outbox', requireAuth, allowPermission('messages.send'), asyncRoute(MessageController.outbox));
router.get('/approvals/inbox', requireAuth, asyncRoute(ApprovalsController.inbox));
router.post('/activity/visit', requireAuth, asyncRoute(ActivityController.visit));
router.get('/activity', requireAuth, allowPermission('audit.view'), asyncRoute(ActivityController.list));

// Calendar.
router.get('/calendar', requireAuth, asyncRoute(CalendarController.range));
router.post('/calendar/events', requireAuth, asyncRoute(CalendarController.save));
router.put('/calendar/events/:id', requireAuth, validateUuidParam, asyncRoute(CalendarController.save));
router.post('/calendar/events/:id/cancel', requireAuth, validateUuidParam, asyncRoute(CalendarController.cancel));
router.put('/calendar/holidays/:date', requireAuth, allowPermission('calendar.manage'), asyncRoute(CalendarController.holiday));

// Document archive and former employees.
router.get('/archive', requireAuth, allowPermission('archive.view'), asyncRoute(ArchiveController.list));
router.post('/archive', requireAuth, allowPermission('archive.manage'), uploadArchive('file'), asyncRoute(ArchiveController.upload));
router.get('/archive/:id/file', requireAuth, allowPermission('archive.view'), validateUuidParam, asyncRoute(ArchiveController.download));
router.post('/archive/:id/withdraw', requireAuth, allowPermission('archive.manage'), validateUuidParam, asyncRoute(ArchiveController.withdraw));
router.get('/employees/former', requireAuth, allowPermission('archive.view'), asyncRoute(ArchiveController.former));

// Payroll archive (months before the system went live).
router.get('/payroll/archive', requireAuth, allowPermission('payroll.view'), asyncRoute(PayrollArchiveController.list));
router.post('/payroll/archive/preview', requireAuth, allowPermission('payroll.prepare'), uploadSingle('file'), asyncRoute(PayrollArchiveController.preview));
router.post('/payroll/archive', requireAuth, allowPermission('payroll.prepare'), uploadSingle('file'), asyncRoute(PayrollArchiveController.save));
router.get('/payroll/archive/:id', requireAuth, allowPermission('payroll.view'), validateUuidParam, asyncRoute(PayrollArchiveController.lines));
router.get('/payroll/archive/:id/file', requireAuth, allowPermission('payroll.view'), validateUuidParam, asyncRoute(PayrollArchiveController.file));
router.post('/payroll/archive/:id/withdraw', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(PayrollArchiveController.withdraw));

// Owner console: security guard, recycle bin, brands, company template.
router.get('/security/overview', requireAuth, allowRoles('super_admin'), asyncRoute(SecurityController.overview));
router.get('/security/alerts', requireAuth, allowRoles('super_admin'), asyncRoute(SecurityController.alerts));
router.post('/security/alerts/:id/resolve', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(SecurityController.resolve));
router.get('/security/logins', requireAuth, allowRoles('super_admin'), asyncRoute(SecurityController.logins));
router.get('/security/events', requireAuth, allowRoles('super_admin'), asyncRoute(SecurityController.events));
router.get('/security/chain', requireAuth, allowRoles('super_admin'), asyncRoute(SecurityController.chain));
router.post('/security/scan', requireAuth, allowRoles('super_admin'), asyncRoute(SecurityController.scan));
router.post('/security/users/:id/sign-out', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(SecurityController.signOutUser));
router.get('/recycle-bin', requireAuth, allowRoles('super_admin'), asyncRoute(RecycleBinController.list));
router.post('/recycle-bin/:id/restore', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(RecycleBinController.restore));
router.post('/recycle-bin/:id/purge', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(RecycleBinController.purge));
router.post('/owner/brands/:brandId/logo', requireAuth, allowRoles('super_admin'), uploadSingle('file'), asyncRoute(OwnerController.uploadBrandLogo));
router.delete('/owner/brands/:brandId/logo', requireAuth, allowRoles('super_admin'), asyncRoute(OwnerController.removeBrandLogo));
router.get('/owner/template', requireAuth, allowRoles('super_admin'), asyncRoute(OwnerController.exportTemplate));
router.post('/owner/template', requireAuth, allowRoles('super_admin'), asyncRoute(OwnerController.importTemplate));
router.post('/auth/set-password', passwordLimiter, asyncRoute(AuthController.setPasswordWithLink));
router.get('/auth/signature', requireAuth, asyncRoute(SignatureController.get));
router.put('/auth/signature', requireAuth, asyncRoute(SignatureController.save));
router.post('/auth/change-password', requireAuth, passwordLimiter, asyncRoute(AuthController.changePassword));

router.get('/me/profile', requireAuth, allowPermission('self.service'), asyncRoute(SelfController.profile));
router.get('/me/payslips', requireAuth, allowPermission('self.service'), asyncRoute(SelfController.payslips));
router.get('/me/requests', requireAuth, allowPermission('self.service'), asyncRoute(RequestController.mine));
router.post('/me/requests', requireAuth, allowPermission('self.service'), asyncRoute(RequestController.create));
router.post('/me/requests/:id/receipt', requireAuth, allowPermission('self.service'), validateUuidParam, uploadSingle('file'), asyncRoute(RequestController.uploadReceipt));
router.post('/me/requests/:id/cancel', requireAuth, allowPermission('self.service'), validateUuidParam, asyncRoute(RequestController.cancelMine));
router.get('/me/attendance', requireAuth, allowPermission('self.service'), asyncRoute(RequestController.myAttendance));
router.get('/requests', requireAuth, allowAnyPermission('requests.manage', 'payroll.disburse'), asyncRoute(RequestController.list));
router.post('/requests/:id/decision', requireAuth, allowPermission('requests.manage'), validateUuidParam, asyncRoute(RequestController.decide));
router.post('/requests/:id/paid', requireAuth, allowPermission('payroll.disburse'), validateUuidParam, asyncRoute(RequestController.markPaid));
router.get('/requests/:id/receipt', requireAuth, validateUuidParam, asyncRoute(RequestController.receipt));
router.get('/portal/accounts', requireAuth, allowPermission('users.manage'), asyncRoute(RequestController.portalAccounts));
router.post('/portal/accounts/:employeeId/invite', requireAuth, allowPermission('users.manage'), asyncRoute(RequestController.invite));
router.get('/me/discipline', requireAuth, allowPermission('self.service'), asyncRoute(DisciplineController.mine));
router.post('/me/discipline/:id/acknowledge', requireAuth, allowPermission('self.service'), validateUuidParam, asyncRoute(DisciplineController.acknowledge));
router.get('/discipline', requireAuth, allowPermission('discipline.view'), asyncRoute(DisciplineController.list));
router.post('/discipline', requireAuth, allowPermission('discipline.manage'), asyncRoute(DisciplineController.create));
router.post('/discipline/:id/cancel', requireAuth, allowPermission('discipline.manage'), validateUuidParam, asyncRoute(DisciplineController.cancel));
router.get('/tickets', requireAuth, asyncRoute(TicketController.list));
router.get('/tickets/agents', requireAuth, allowPermission('tickets.manage'), asyncRoute(TicketController.agents));
router.post('/tickets', requireAuth, asyncRoute(TicketController.create));
router.get('/tickets/:id', requireAuth, validateUuidParam, asyncRoute(TicketController.get));
router.patch('/tickets/:id', requireAuth, validateUuidParam, asyncRoute(TicketController.update));
router.post('/tickets/:id/comments', requireAuth, validateUuidParam, asyncRoute(TicketController.comment));
router.get('/recruitment/positions', requireAuth, allowPermission('recruitment.view'), asyncRoute(RecruitmentController.positions));
router.post('/recruitment/positions', requireAuth, allowPermission('recruitment.manage'), asyncRoute(RecruitmentController.savePosition));
router.put('/recruitment/positions/:id', requireAuth, allowPermission('recruitment.manage'), validateUuidParam, asyncRoute(RecruitmentController.savePosition));
router.get('/recruitment/applicants', requireAuth, allowPermission('recruitment.view'), asyncRoute(RecruitmentController.applicants));
router.post('/recruitment/applicants', requireAuth, allowPermission('recruitment.manage'), asyncRoute(RecruitmentController.createApplicant));
router.get('/recruitment/applicants/:id', requireAuth, allowPermission('recruitment.view'), validateUuidParam, asyncRoute(RecruitmentController.applicant));
router.patch('/recruitment/applicants/:id', requireAuth, allowPermission('recruitment.manage'), validateUuidParam, asyncRoute(RecruitmentController.updateApplicant));
router.post('/recruitment/applicants/:id/cv', requireAuth, allowPermission('recruitment.manage'), validateUuidParam, uploadSingle('file'), asyncRoute(RecruitmentController.uploadCv));
router.get('/recruitment/applicants/:id/cv', requireAuth, allowPermission('recruitment.view'), validateUuidParam, asyncRoute(RecruitmentController.cv));
router.post('/recruitment/applicants/:id/hire', requireAuth, allowPermission('recruitment.manage'), validateUuidParam, asyncRoute(RecruitmentController.hire));
router.get('/me/payslips/:runId', requireAuth, allowPermission('self.service'), asyncRoute(SelfController.payslip));
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
router.get('/leaves/accruals', requireAuth, allowPermission('leaves.manage_balances'), asyncRoute(LeaveAccrualController.list));
router.get('/leaves/accruals/preview', requireAuth, allowPermission('leaves.manage_balances'), asyncRoute(LeaveAccrualController.preview));
router.post('/leaves/accruals', requireAuth, allowPermission('leaves.manage_balances'), asyncRoute(LeaveAccrualController.apply));
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
router.post('/employees/:id/separate', requireAuth, allowPermission('employees.update'), validateUuidParam, asyncRoute(ArchiveController.separate));
router.post('/employees/:id/reinstate', requireAuth, allowPermission('employees.update'), validateUuidParam, asyncRoute(ArchiveController.reinstate));
router.get('/employees/:id/payroll-history', requireAuth, allowPermission('payroll.view'), validateUuidParam, asyncRoute(PayrollArchiveController.employeeHistory));
router.get('/employees/:id/photo', requireAuth, validateUuidParam, asyncRoute(EmployeeFileController.photo));
router.post('/employees/:id/photo', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, uploadSingle('file'), asyncRoute(EmployeeFileController.uploadPhoto));
router.get('/employees/:id/profile', requireAuth, allowPermission('employees.view_profile'), validateUuidParam, asyncRoute(EmployeeFileController.getProfile));
router.put('/employees/:id/profile', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(EmployeeFileController.updateProfile));
router.get('/employees/:id/compensation', requireAuth, allowPermission('compensation.view'), validateUuidParam, asyncRoute(EmployeeFileController.listCompensation));
router.post('/employees/:id/compensation', requireAuth, allowPermission('compensation.manage'), validateUuidParam, asyncRoute(EmployeeFileController.addCompensation));
router.get('/employees/:id/contracts', requireAuth, allowPermission('employees.view_profile'), validateUuidParam, asyncRoute(EmployeeFileController.listContracts));
router.post('/employees/:id/contracts', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(EmployeeFileController.saveContract));
router.put('/employees/:id/contracts/:contractId', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(EmployeeFileController.saveContract));
router.get('/contracts/fields', requireAuth, allowPermission('employees.view_profile'), asyncRoute(ContractController.fields));
router.get('/contracts/templates', requireAuth, allowPermission('employees.view_profile'), asyncRoute(ContractController.listTemplates));
router.post('/contracts/templates', requireAuth, allowPermission('employees.manage_profile'), uploadSingle('file'), asyncRoute(ContractController.uploadTemplate));
router.get('/contracts/templates/:id/file', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(ContractController.downloadTemplate));
router.patch('/contracts/templates/:id', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(ContractController.setTemplateActive));
router.get('/employees/:id/contracts/preview', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(ContractController.preview));
router.post('/employees/:id/contracts/generate', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(ContractController.generate));
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
router.get('/org/job-profiles', requireAuth, asyncRoute(JobProfileController.list));
router.post('/org/job-profiles/import', requireAuth, allowPermission('org.manage'), asyncRoute(JobProfileController.import));
router.get('/org/job-titles/:id/profile', requireAuth, validateUuidParam, asyncRoute(JobProfileController.get));
router.get('/org/import/template.xlsx', requireAuth, allowPermission('org.manage'), asyncRoute(OrgController.importTemplate));
router.post('/admin/company-import', requireAuth, allowRoles('super_admin'), uploadWorkbooks, asyncRoute(CompanyImportController.upload));
router.post('/org/import/preview', requireAuth, allowPermission('org.manage'), uploadSingle('file'), asyncRoute(OrgController.importPreview));
router.post('/org/import/apply', requireAuth, allowPermission('org.manage'), uploadSingle('file'), asyncRoute(OrgController.importApply));

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
router.post('/payroll/runs/:id/sign', requireAuth, allowPermission('payroll.view'), validateUuidParam, asyncRoute(PayrollController.sign));
router.post('/payroll/runs/:id/return', requireAuth, allowAnyPermission('payroll.prepare', 'payroll.audit', 'payroll.approve'), validateUuidParam, asyncRoute(PayrollController.returnRun));
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
router.get('/payroll/day-adjustments', requireAuth, allowPermission('payroll.view'), asyncRoute(PayrollController.listAdjustments));
router.put('/payroll/day-adjustments', requireAuth, allowPermission('payroll.prepare'), asyncRoute(PayrollController.setAdjustment));
router.get('/payroll/loans', requireAuth, allowPermission('payroll.view'), asyncRoute(LoanController.list));
router.get('/payroll/loans/deductions', requireAuth, allowPermission('payroll.view'), asyncRoute(LoanController.deductions));
router.get('/payroll/loans/:id/schedule', requireAuth, allowPermission('payroll.view'), validateUuidParam, asyncRoute(LoanController.schedule));
router.post('/payroll/loans', requireAuth, allowPermission('payroll.prepare'), asyncRoute(LoanController.create));
router.patch('/payroll/loans/:id', requireAuth, allowPermission('payroll.prepare'), validateUuidParam, asyncRoute(LoanController.setStatus));

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
