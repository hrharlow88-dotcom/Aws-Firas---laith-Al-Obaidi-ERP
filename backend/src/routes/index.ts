import { requirePortal } from '../services/portal';
import { PhotoController } from '../controllers/PhotoController';
import { EmployeeImportController } from '../controllers/EmployeeImportController';
import { FingerprintFileController } from '../controllers/FingerprintFileController';
import express, { NextFunction, Request, RequestHandler, Response } from 'express';
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
import ContractController, { advanceForm } from '../controllers/ContractController';
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
import ChatController from '../controllers/ChatController';
import CompanyController from '../controllers/CompanyController';
import DemoController from '../controllers/DemoController';
import GeoController from '../controllers/GeoController';
import HolidayController from '../controllers/HolidayController';
import ApprovalRequestController from '../controllers/ApprovalRequestController';
import AiController from '../controllers/AiController';
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

// Internal chat.
router.get('/chat/channels', requireAuth, asyncRoute(ChatController.channels));
router.get('/chat/people', requireAuth, asyncRoute(ChatController.people));
router.get('/chat/unread', requireAuth, asyncRoute(ChatController.unread));
router.post('/chat/channels', requireAuth, asyncRoute(ChatController.createChannel));
router.post('/chat/direct', requireAuth, asyncRoute(ChatController.direct));
router.post('/chat/channels/:id/join', requireAuth, validateUuidParam, asyncRoute(ChatController.join));
router.post('/chat/channels/:id/leave', requireAuth, validateUuidParam, asyncRoute(ChatController.leave));
router.get('/chat/channels/:id/members', requireAuth, validateUuidParam, asyncRoute(ChatController.members));
router.post('/chat/channels/:id/members', requireAuth, validateUuidParam, asyncRoute(ChatController.addMembers));
router.get('/chat/channels/:id/messages', requireAuth, validateUuidParam, asyncRoute(ChatController.messages));
router.post('/chat/channels/:id/messages', requireAuth, validateUuidParam, uploadSingle('file'), asyncRoute(ChatController.post));
router.post('/chat/channels/:id/read', requireAuth, validateUuidParam, asyncRoute(ChatController.read));
router.patch('/chat/messages/:id', requireAuth, validateUuidParam, asyncRoute(ChatController.edit));
router.delete('/chat/messages/:id', requireAuth, validateUuidParam, asyncRoute(ChatController.remove));
router.post('/chat/messages/:id/react', requireAuth, validateUuidParam, asyncRoute(ChatController.react));
router.get('/chat/messages/:id/file', requireAuth, validateUuidParam, asyncRoute(ChatController.file));

// Group companies.
router.get('/companies', requireAuth, asyncRoute(CompanyController.list));
router.post('/companies', requireAuth, allowRoles('super_admin'), asyncRoute(CompanyController.save));
router.put('/companies/:id', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(CompanyController.save));
router.post('/companies/:id/logo', requireAuth, allowRoles('super_admin'), validateUuidParam, uploadSingle('file'), asyncRoute(CompanyController.uploadLogo));
router.get('/public/companies/:id/logo', validateUuidParam, asyncRoute(CompanyController.logo));

// Invitations by WhatsApp / SMS / e-mail.
router.post('/invites/deliver', requireAuth, allowPermission('users.manage'), asyncRoute(MessageController.deliverInvite));
router.post('/users/:id/invite', requireAuth, allowPermission('users.manage'), validateUuidParam, asyncRoute(UserController.invite));

// Demo accounts (owner).
router.get('/owner/demo', requireAuth, allowRoles('super_admin'), asyncRoute(DemoController.list));
router.post('/owner/demo', requireAuth, allowRoles('super_admin'), asyncRoute(DemoController.create));
router.patch('/owner/demo/:id', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(DemoController.update));
router.post('/owner/demo-toggle', requireAuth, allowRoles('super_admin'), asyncRoute(DemoController.toggleAll));
router.post('/owner/demo/:id/invite', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(DemoController.invite));
// The demo copy's private door for the real system (shared key; answers 404 otherwise).
const bridgeGate: RequestHandler = (req, res, next) => { void DemoController.bridgeAuth(req, res, next).catch(next); };
router.get('/demo-bridge/accounts', bridgeGate, asyncRoute(DemoController.bridgeList));
router.post('/demo-bridge/accounts', bridgeGate, asyncRoute(DemoController.bridgeCreate));
router.post('/demo-bridge/accounts/:id/invite', bridgeGate, validateUuidParam, asyncRoute(DemoController.bridgeInvite));
router.patch('/demo-bridge/accounts/:id', bridgeGate, validateUuidParam, asyncRoute(DemoController.bridgeUpdate));
router.post('/demo-bridge/toggle', bridgeGate, asyncRoute(DemoController.bridgeToggle));

// Radar, scanner and firewall (owner).
router.get('/security/radar', requireAuth, allowRoles('super_admin'), asyncRoute(SecurityController.radar));
router.get('/security/scan-report', requireAuth, allowRoles('super_admin'), asyncRoute(SecurityController.scanReport));
router.post('/security/fix/:findingId', requireAuth, allowRoles('super_admin'), asyncRoute(SecurityController.fix));
router.get('/security/blocks', requireAuth, allowRoles('super_admin'), asyncRoute(SecurityController.blocks));
router.post('/security/blocks', requireAuth, allowRoles('super_admin'), asyncRoute(SecurityController.block));
router.post('/security/blocks/:id/lift', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(SecurityController.unblock));

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
router.get('/ai/status', requireAuth, allowRoles('super_admin'), asyncRoute(AiController.status));
router.put('/ai/settings', requireAuth, allowRoles('super_admin'), asyncRoute(AiController.configure));
router.get('/ai/jobs', requireAuth, allowRoles('super_admin'), asyncRoute(AiController.jobs));
router.get('/ai/jobs/:id', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(AiController.job));
router.post('/ai/attendance', requireAuth, allowRoles('super_admin'), asyncRoute(AiController.attendance));
router.post('/ai/import', requireAuth, allowRoles('super_admin'), uploadSingle('file'), asyncRoute(AiController.importFile));
router.post('/ai/jobs/:id/apply', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(AiController.apply));
router.post('/ai/jobs/:id/discard', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(AiController.discard));
router.get('/hr/documents-check', requireAuth, allowPermission('employees.view_profile'), asyncRoute(AiController.documentsCheck));
router.post('/hr/documents-check/rule', requireAuth, allowRoles('super_admin'), asyncRoute(AiController.documentRule));
router.get('/approval-categories', requireAuth, asyncRoute(ApprovalRequestController.categories));
router.post('/approval-categories', requireAuth, allowRoles('super_admin'), asyncRoute(ApprovalRequestController.saveCategory));
router.put('/approval-categories/:id', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(ApprovalRequestController.saveCategory));
router.get('/approval-requests', requireAuth, asyncRoute(ApprovalRequestController.list));
router.post('/approval-requests', requireAuth, uploadSingle('file'), asyncRoute(ApprovalRequestController.create));
router.get('/approval-requests/:id', requireAuth, validateUuidParam, asyncRoute(ApprovalRequestController.get));
router.post('/approval-requests/:id/decide', requireAuth, validateUuidParam, asyncRoute(ApprovalRequestController.decide));
router.post('/approval-requests/:id/cancel', requireAuth, validateUuidParam, asyncRoute(ApprovalRequestController.cancel));
router.get('/approval-requests/:id/file', requireAuth, validateUuidParam, asyncRoute(ApprovalRequestController.file));
router.get('/expenses', requireAuth, asyncRoute(ApprovalRequestController.list));
router.post('/expenses', requireAuth, asyncRoute(ApprovalRequestController.createExpense));
router.get('/expenses/:id', requireAuth, validateUuidParam, asyncRoute(ApprovalRequestController.get));
router.post('/expenses/:id/lines', requireAuth, validateUuidParam, uploadSingle('file'), asyncRoute(ApprovalRequestController.addExpenseLine));
router.delete('/expenses/:id/lines/:lineId', requireAuth, validateUuidParam, asyncRoute(ApprovalRequestController.removeExpenseLine));
router.get('/expenses/:id/lines/:lineId/file', requireAuth, validateUuidParam, asyncRoute(ApprovalRequestController.file));
router.post('/expenses/:id/submit', requireAuth, validateUuidParam, asyncRoute(ApprovalRequestController.submitExpense));
router.post('/expenses/:id/decide', requireAuth, validateUuidParam, asyncRoute(ApprovalRequestController.decide));
router.post('/expenses/:id/cancel', requireAuth, validateUuidParam, asyncRoute(ApprovalRequestController.cancel));
router.post('/expenses/:id/pay', requireAuth, validateUuidParam, asyncRoute(ApprovalRequestController.pay));
router.get('/holidays', requireAuth, asyncRoute(HolidayController.list));
router.post('/holidays/propose', requireAuth, allowPermission('calendar.manage'), asyncRoute(HolidayController.propose));
router.post('/holidays', requireAuth, allowPermission('calendar.manage'), asyncRoute(HolidayController.save));
router.post('/holidays/:date/confirm', requireAuth, allowRoles('super_admin'), asyncRoute(HolidayController.confirm));
router.delete('/holidays/:date', requireAuth, allowPermission('calendar.manage'), asyncRoute(HolidayController.remove));
router.get('/leaves/comp-credits', requireAuth, allowPermission('leaves.view'), asyncRoute(HolidayController.compCredits));
router.get('/leaves/comp-credits/suggestions', requireAuth, allowPermission('leaves.manage_balances'), asyncRoute(HolidayController.compSuggestions));
router.post('/leaves/comp-credits', requireAuth, allowPermission('leaves.manage_balances'), asyncRoute(HolidayController.grantComp));
router.get('/governorates', requireAuth, asyncRoute(GeoController.governorates));
router.post('/governorates', requireAuth, allowRoles('super_admin'), asyncRoute(GeoController.saveGovernorate));
router.put('/governorates/:id', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(GeoController.saveGovernorate));
router.get('/exchange-rates', requireAuth, asyncRoute(GeoController.rates));
router.post('/exchange-rates', requireAuth, allowAnyPermission('payroll.prepare', 'finance.manage'), asyncRoute(GeoController.setRate));
router.get('/payroll/register', requireAuth, allowPermission('payroll.view'), asyncRoute(GeoController.payrollRegister));
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
router.get('/me/photo', requireAuth, allowPermission('self.service'), asyncRoute(PhotoController.mine));
router.post('/me/photo', requireAuth, allowPermission('self.service'), requirePortal('photoUpload'), uploadSingle('file'), asyncRoute(PhotoController.submit));
router.get('/me/payslips', requireAuth, allowPermission('self.service'), requirePortal('payslips'), asyncRoute(SelfController.payslips));
router.get('/me/requests', requireAuth, allowPermission('self.service'), asyncRoute(RequestController.mine));
router.post('/me/requests', requireAuth, allowPermission('self.service'), asyncRoute(RequestController.create));
router.post('/me/requests/:id/receipt', requireAuth, allowPermission('self.service'), validateUuidParam, uploadSingle('file'), asyncRoute(RequestController.uploadReceipt));
router.post('/me/requests/:id/cancel', requireAuth, allowPermission('self.service'), validateUuidParam, asyncRoute(RequestController.cancelMine));
router.get('/me/attendance', requireAuth, allowPermission('self.service'), requirePortal('attendance'), asyncRoute(RequestController.myAttendance));
router.get('/requests', requireAuth, allowAnyPermission('requests.manage', 'payroll.disburse'), asyncRoute(RequestController.list));
router.post('/requests/:id/decision', requireAuth, allowPermission('requests.manage'), validateUuidParam, asyncRoute(RequestController.decide));
router.post('/requests/:id/paid', requireAuth, allowPermission('payroll.disburse'), validateUuidParam, asyncRoute(RequestController.markPaid));
router.get('/requests/:id/receipt', requireAuth, validateUuidParam, asyncRoute(RequestController.receipt));
router.get('/portal/accounts', requireAuth, allowPermission('users.manage'), asyncRoute(RequestController.portalAccounts));
router.post('/portal/accounts/:employeeId/invite', requireAuth, allowPermission('users.manage'), asyncRoute(RequestController.invite));
router.get('/me/discipline', requireAuth, allowPermission('self.service'), requirePortal('notices'), asyncRoute(DisciplineController.mine));
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
router.get('/me/payslips/:runId', requireAuth, allowPermission('self.service'), requirePortal('payslips'), asyncRoute(SelfController.payslip));
router.get('/branches', requireAuth, asyncRoute(BranchController.list));
router.post('/branches', requireAuth, allowPermission('branches.manage'), asyncRoute(BranchController.create));
router.put('/branches/:id', requireAuth, allowPermission('branches.manage'), validateUuidParam, asyncRoute(BranchController.update));

router.put('/users/me/notifications', requireAuth, asyncRoute(UserController.setNotifications));
router.put('/users/:id/notifications', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(UserController.setNotifications));
router.put('/users/:id/apps', requireAuth, allowRoles('super_admin'), validateUuidParam, asyncRoute(UserController.setApps));
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
// The employees' master sheet (names, fingerprint numbers, contacts, placement, salary).
router.get('/employees/import/template.xlsx', requireAuth, allowAnyPermission('employees.update', 'employees.create'), asyncRoute(EmployeeImportController.template));
router.post('/employees/import/preview', requireAuth, allowAnyPermission('employees.update', 'employees.create'), uploadSingle('file'), asyncRoute(EmployeeImportController.preview));
router.post('/employees/import/apply', requireAuth, allowAnyPermission('employees.update', 'employees.create'), uploadSingle('file'), asyncRoute(EmployeeImportController.apply));
// Photos: sent from the portal and taken in by HR, or uploaded in bulk named by employee number.
router.get('/employees/photo-submissions', requireAuth, allowPermission('employees.manage_profile'), asyncRoute(PhotoController.list));
router.post('/employees/photo-submissions/accept', requireAuth, allowPermission('employees.manage_profile'), asyncRoute(PhotoController.accept));
router.get('/employees/photo-submissions/:id/file', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(PhotoController.file));
router.post('/employees/photo-submissions/:id/reject', requireAuth, allowPermission('employees.manage_profile'), validateUuidParam, asyncRoute(PhotoController.reject));
router.post('/employees/photos/match', requireAuth, allowPermission('employees.manage_profile'), asyncRoute(PhotoController.match));
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
// The fingerprint system's three exports (attendance, leave, app tasks): preview, then apply.
router.post('/attendance/files/preview', requireAuth, allowPermission('attendance.manage'), uploadSingle('file'), asyncRoute(FingerprintFileController.preview));
router.post('/attendance/files/apply', requireAuth, allowPermission('attendance.manage'), uploadSingle('file'), asyncRoute(FingerprintFileController.apply));
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
router.post('/payroll/loans/:id/form', requireAuth, allowPermission('payroll.prepare'), validateUuidParam, asyncRoute(advanceForm));
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
