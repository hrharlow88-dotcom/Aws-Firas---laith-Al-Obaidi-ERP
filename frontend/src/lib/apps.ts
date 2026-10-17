import type { LucideIcon } from 'lucide-react';
import {
  Archive, MessagesSquare, Receipt, Stamp, Building, CalendarRange, ClipboardCheck, Crown, Megaphone, ClipboardList, ShieldAlert, LifeBuoy, Briefcase, BookOpenCheck, CalendarDays, CircleUserRound, Target, Fingerprint, History, Landmark, LayoutDashboard, PlugZap, Settings, Users, Wallet,
} from 'lucide-react';
import type { Permission } from '../SettingsPage';
import { tAr, tEn } from './texts';

/**
 * The system as a set of apps, like Odoo: the home screen shows one icon per
 * app, and inside an app the top bar lists that app's menus.
 */
export interface AppMenu {
  page: string;
  label: string;
  /** Shown only with this permission (super admins see everything). */
  permission?: Permission;
  adminOnly?: boolean;
}

export interface AppDefinition {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Tile colours, as a CSS gradient pair. */
  colors: [string, string];
  menus: AppMenu[];
  /** Pages that belong to the app without being a menu (profile, payslip…). */
  extraPages?: string[];
  /** An app that lives elsewhere opens in a new tab. */
  href?: string;
  /** Not shown to accounts that only see their own record. */
  staffOnly?: boolean;
}

export const APPS: AppDefinition[] = [
  {
    id: 'me', label: 'خدمتي', description: 'ملفي وقسائمي وإجازاتي', icon: CircleUserRound,
    colors: ['#e7745a', '#b43c1d'], menus: [{ page: 'my', label: 'ملفي', permission: 'self.service' }],
    extraPages: ['my-payslip'],
  },
  {
    id: 'chat', label: 'المحادثات', description: 'القنوات والرسائل المباشرة', icon: MessagesSquare,
    colors: ['#6a5acd', '#433899'], menus: [{ page: 'chat', label: 'المحادثات' }],
  },
  {
    id: 'approvals', label: 'اعتماداتي', description: 'كل ما ينتظر قرارك', icon: ClipboardCheck,
    colors: ['#f0a03c', '#c46f12'], menus: [{ page: 'approvals', label: 'اعتماداتي ومهامي' }],
  },
  {
    id: 'calendar', label: 'التقويم', description: 'المواعيد والإجازات والعطل', icon: CalendarRange,
    colors: ['#e2574c', '#a8322a'], menus: [{ page: 'calendar', label: 'التقويم' }, { page: 'holidays', label: 'العطل الرسمية' }],
  },
  {
    id: 'communication', label: 'الإعلانات والرسائل', description: 'التعاميم والدعوات', icon: Megaphone,
    colors: ['#3e8ed0', '#1f5f99'], menus: [
      { page: 'notices', label: 'لوحة الإعلانات' },
      { page: 'announcements', label: 'إدارة الإعلانات', permission: 'announcements.manage' },
      { page: 'messages', label: 'الدعوات والرسائل', permission: 'messages.send' },
    ],
  },
  {
    id: 'dashboard', label: 'لوحة المعلومات', description: 'ملخص اليوم', icon: LayoutDashboard,
    colors: ['#3d3a40', '#1d1b1f'], menus: [{ page: 'overview', label: 'نظرة عامة' }], staffOnly: true,
  },
  {
    id: 'employees', label: 'الموظفون', description: 'الملفات والبطاقات والعقود', icon: Users,
    colors: ['#f07a52', '#d2461f'],
    menus: [
      { page: 'employees', label: 'الموظفون' },
      { page: 'org', label: 'الأقسام والهيكل' },
      { page: 'companies', label: 'شركات المجموعة' },
      { page: 'branches', label: 'الفروع' },
      { page: 'contract-templates', label: 'قوالب العقود', permission: 'employees.manage_profile' },
      { page: 'documents-check', label: 'اكتمال الوثائق', permission: 'employees.view_profile' },
    ],
    extraPages: ['card'],
    staffOnly: true,
  },
  {
    id: 'requests', label: 'الطلبات', description: 'طلبات الموظفين', icon: ClipboardList,
    colors: ['#e0864a', '#b85a1e'], menus: [{ page: 'requests', label: 'طلبات الموظفين', permission: 'requests.manage' }],
    staffOnly: true,
  },
  {
    id: 'register', label: 'سجل الموارد البشرية', description: 'الإنذارات والعقوبات والمخالفات', icon: ShieldAlert,
    colors: ['#c0504d', '#8e2a28'], menus: [{ page: 'discipline', label: 'السجل', permission: 'discipline.view' }],
    staffOnly: true,
  },
  {
    id: 'recruitment', label: 'التوظيف', description: 'الشواغر والمتقدمون', icon: Briefcase,
    colors: ['#4f7cc9', '#2b5299'], menus: [{ page: 'recruitment', label: 'الشواغر', permission: 'recruitment.view' }],
    staffOnly: true,
  },
  {
    id: 'helpdesk', label: 'التذاكر', description: 'تقنية المعلومات والصيانة والنقل', icon: LifeBuoy,
    colors: ['#16a3a3', '#0d7272'], menus: [
      { page: 'tickets', label: 'كل التذاكر', permission: 'tickets.manage' },
      { page: 'my-tickets', label: 'تذاكري' },
    ],
  },
  {
    id: 'attendance', label: 'الحضور', description: 'البصمة والدوامات', icon: Fingerprint,
    colors: ['#3fae8c', '#1f7a5e'], menus: [{ page: 'attendance', label: 'الحضور والانصراف', permission: 'attendance.view' }],
  },
  {
    id: 'leaves', label: 'الإجازات', description: 'الطلبات والأرصدة', icon: CalendarDays,
    colors: ['#5b8def', '#2f5fc4'], menus: [
      { page: 'leaves', label: 'الإجازات والأرصدة', permission: 'leaves.view' },
      { page: 'leave-accrual', label: 'الاستحقاق الشهري', permission: 'leaves.manage_balances' },
      { page: 'comp-leave', label: 'الإجازة التعويضية', permission: 'leaves.view' },
    ],
  },
  {
    id: 'payroll', label: 'الرواتب', description: 'المسيرات والسلف', icon: Wallet,
    colors: ['#9b6bd6', '#6c3fb0'],
    menus: [
      { page: 'payroll', label: 'المسيرات', permission: 'payroll.view' },
      { page: 'payroll-register', label: 'الرواتب حسب المحافظة', permission: 'payroll.view' },
      { page: 'payroll-days', label: 'أيام الاستحقاق', permission: 'payroll.view' },
      { page: 'loans', label: 'السلف', permission: 'payroll.view' },
      { page: 'payroll-archive', label: 'أرشيف المسيرات', permission: 'payroll.view' },
    ],
    extraPages: ['payslip'],
  },
  {
    id: 'expenses', label: 'التكاليف', description: 'تقارير المصاريف والاسترداد', icon: Receipt,
    colors: ['#2e9d6b', '#1b6e48'], menus: [{ page: 'expenses', label: 'تقارير المصاريف' }],
  },
  {
    id: 'approval-requests', label: 'الموافقات', description: 'طلبات الشراء والسفر والعهد وغيرها', icon: Stamp,
    colors: ['#c47b2a', '#8e5113'], menus: [
      { page: 'approval-requests', label: 'طلبات الموافقة' },
      { page: 'approval-categories', label: 'أنواع الموافقات', adminOnly: true },
    ],
  },
  {
    id: 'performance', label: 'الأداء', description: 'الأوصاف الوظيفية ومؤشرات الأداء', icon: Target,
    colors: ['#d4657d', '#a3324d'],
    menus: [{ page: 'kpi', label: 'الأوصاف ومؤشرات الأداء' }],
    staffOnly: true,
  },
  {
    id: 'archive', label: 'الأرشيف', description: 'الوثائق والموظفون المنفكّون', icon: Archive,
    colors: ['#8c6d4f', '#5e452e'], menus: [
      { page: 'archive', label: 'أرشيف الوثائق', permission: 'archive.view' },
      { page: 'former-employees', label: 'الموظفون المنفكّون', permission: 'archive.view' },
    ], staffOnly: true,
  },
  {
    id: 'finance', label: 'المالية و SAP', description: 'القيود والترحيل', icon: Landmark,
    colors: ['#e3a83b', '#b97c12'], menus: [{ page: 'finance', label: 'القيود والربط', permission: 'finance.view' }],
  },
  {
    id: 'audit', label: 'التدقيق', description: 'سجل كل العمليات', icon: History,
    colors: ['#7d8794', '#4f5864'], menus: [
      { page: 'audit', label: 'سجل التدقيق', permission: 'audit.view' },
      { page: 'activity', label: 'حركات النظام', permission: 'audit.view' },
    ],
  },
  {
    id: 'integrations', label: 'الربط', description: 'مفاتيح الأنظمة الأخرى', icon: PlugZap,
    colors: ['#3bb3c9', '#1a7f93'], menus: [{ page: 'integrations', label: 'مفاتيح الربط', permission: 'integrations.manage' }],
  },
  {
    id: 'jd', label: 'بوابة التقييم', description: 'تقييم الأداء في نظام الأوصاف', icon: BookOpenCheck,
    colors: ['#c95b8f', '#9b2f63'], menus: [], href: 'https://alobaidi-hr.github.io/',
  },
  {
    id: 'owner', label: 'لوحة المالك', description: 'الحارس الأمني والتحكم الكامل', icon: Crown,
    colors: ['#2f2a33', '#0f0d11'], menus: [
      { page: 'guard', label: 'الحارس الأمني', adminOnly: true },
      { page: 'owner', label: 'تحكم المالك', adminOnly: true },
      { page: 'ai', label: 'المساعد الذكي', adminOnly: true },
      { page: 'recycle-bin', label: 'سلة المحذوفات', adminOnly: true },
      { page: 'activity', label: 'حركات النظام', adminOnly: true },
    ],
  },
  {
    id: 'settings', label: 'الإعدادات', description: 'المستخدمون والصلاحيات', icon: Settings,
    colors: ['#8a7f7a', '#5c524d'],
    menus: [
      { page: 'settings', label: 'إعدادات النظام', adminOnly: true },
      { page: 'company-import', label: 'استيراد بيانات الشركة', adminOnly: true },
      { page: 'access', label: 'المستخدمون', permission: 'users.manage' },
      { page: 'portal-accounts', label: 'حسابات البوابة', permission: 'users.manage' },
      { page: 'security', label: 'أمان الحساب' },
    ],
  },
];

export function appForPage(page: string): AppDefinition | undefined {
  return APPS.find((app) => app.menus.some((menu) => menu.page === page) || app.extraPages?.includes(page));
}

/** Apps the owner hid from everyone else, or kept away from this account. */
export function hiddenFor(app: AppDefinition, hiddenApps: string[] | undefined, isOwner: boolean, appAccess?: string[] | null): boolean {
  if (isOwner) return false;
  if (hiddenApps?.includes(app.id)) return true;
  // Apps always open to everyone: the personal portal, chat, approvals inbox and calendar.
  return Boolean(appAccess) && !['me', 'approvals', 'chat', 'calendar', 'settings'].includes(app.id) && !appAccess!.includes(app.id);
}

/** The apps in the order the owner arranged them; any not placed keep their default position after those. */
export function orderedApps(order: string[] | undefined): AppDefinition[] {
  if (!order?.length) return APPS;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...APPS].sort((a, b) => (rank.get(a.id) ?? 1000 + APPS.indexOf(a)) - (rank.get(b.id) ?? 1000 + APPS.indexOf(b)));
}

export function visibleMenus(app: AppDefinition, can: (permission: Permission) => boolean, isAdmin: boolean): AppMenu[] {
  return app.menus.filter((menu) => (menu.adminOnly ? isAdmin : !menu.permission || can(menu.permission)));
}

/** English for every app, menu and description label, shown beside the Arabic. */
export const EN: Record<string, string> = {
  'خدمتي': 'My Portal', 'ملفي وقسائمي وإجازاتي': 'My file, payslips and leave', 'ملفي': 'My Dashboard',
  'لوحة المعلومات': 'Dashboard', 'ملخص اليوم': "Today's summary", 'نظرة عامة': 'Overview',
  'الموظفون': 'Employees', 'الملفات والبطاقات والعقود': 'Files, cards and contracts', 'الأقسام والهيكل': 'Departments & Structure',
  'الفروع': 'Branches', 'قوالب العقود': 'Contract Templates',
  'الحضور': 'Attendance', 'البصمة والدوامات': 'Fingerprint and shifts', 'الحضور والانصراف': 'Check-in / Check-out',
  'الإجازات': 'Time Off', 'الطلبات والأرصدة': 'Requests and balances', 'الإجازات والأرصدة': 'Requests & Balances', 'الاستحقاق الشهري': 'Monthly Accrual',
  'الرواتب': 'Payroll', 'المسيرات والسلف': 'Payroll runs and loans', 'المسيرات': 'Payroll Runs', 'أيام الاستحقاق': 'Payable Days', 'السلف': 'Loans',
  'أرشيف المسيرات': 'Payroll Archive', 'الاعتمادات': 'Approvals',
  'الأداء': 'Performance', 'الأوصاف الوظيفية ومؤشرات الأداء': 'Job descriptions and KPIs', 'الأوصاف ومؤشرات الأداء': 'JDs & KPIs',
  'المالية و SAP': 'Finance & SAP', 'القيود والترحيل': 'Journal entries and posting', 'القيود والربط': 'Entries & Integration',
  'التدقيق': 'Audit', 'سجل كل العمليات': 'Every action, recorded', 'سجل التدقيق': 'Audit Log',
  'الربط': 'Integrations', 'مفاتيح الأنظمة الأخرى': 'Keys for other systems', 'مفاتيح الربط': 'API Keys',
  'بوابة التقييم': 'Evaluation Portal', 'تقييم الأداء في نظام الأوصاف': 'Performance reviews in the JD system',
  'الإعدادات': 'Settings', 'المستخدمون والصلاحيات': 'Users and permissions', 'إعدادات النظام': 'System Settings',
  'استيراد بيانات الشركة': 'Company Data Import', 'المستخدمون': 'Users', 'أمان الحساب': 'Account Security',
  'سجل الموارد البشرية': 'HR Register', 'الإنذارات والعقوبات والمخالفات': 'Warnings, penalties and violations', 'السجل': 'Register',
  'التذاكر': 'Helpdesk', 'تقنية المعلومات والصيانة والنقل': 'IT, maintenance and transport', 'كل التذاكر': 'All Tickets', 'تذاكري': 'My Tickets',
  'التوظيف': 'Recruitment', 'الشواغر والمتقدمون': 'Job positions and applicants', 'المتقدمون': 'Applicants', 'الشواغر': 'Job Positions',
  'اعتماداتي': 'My Approvals', 'كل ما ينتظر قرارك': 'Everything waiting for you', 'اعتماداتي ومهامي': 'Approvals & To-dos',
  'التقويم': 'Calendar', 'المواعيد والإجازات والعطل': 'Events, leave and holidays',
  'الإعلانات والرسائل': 'Announcements', 'التعاميم والدعوات': 'Circulars and invitations', 'لوحة الإعلانات': 'Notice Board',
  'إدارة الإعلانات': 'Manage Announcements', 'الدعوات والرسائل': 'Invitations & Messages',
  'الأرشيف': 'Archive', 'الوثائق والموظفون المنفكّون': 'Documents and former employees', 'أرشيف الوثائق': 'Document Archive',
  'الموظفون المنفكّون': 'Former Employees', 'حركات النظام': 'System Activity',
  'لوحة المالك': 'Owner Console', 'الحارس الأمني والتحكم الكامل': 'Security guard and full control', 'الحارس الأمني': 'Security Guard',
  'تحكم المالك': 'Owner Controls', 'سلة المحذوفات': 'Recycle Bin',
  'المحادثات': 'Discuss', 'القنوات والرسائل المباشرة': 'Channels and direct messages', 'شركات المجموعة': 'Group Companies',
  'الطلبات': 'Requests', 'طلبات الموظفين': 'Employee Requests', 'حسابات البوابة': 'Portal Accounts',
  'التكاليف': 'Expenses', 'تقارير المصاريف والاسترداد': 'Expense reports and reimbursement', 'تقارير المصاريف': 'Expense Reports',
  'الموافقات': 'Approvals', 'طلبات الشراء والسفر والعهد وغيرها': 'Purchases, trips, items and more', 'طلبات الموافقة': 'Approval Requests',
  'أنواع الموافقات': 'Approval Types', 'المساعد الذكي': 'AI Assistant', 'اكتمال الوثائق': 'Document Completeness',
  'العطل الرسمية': 'Official Holidays', 'الإجازة التعويضية': 'Compensatory Leave', 'الرواتب حسب المحافظة': 'Payroll by Governorate',
};
/** English label, with the owner's rename if any. */
export const en = (label: string): string => tEn(label, EN[label] ?? '');
/** Arabic label, with the owner's rename if any. */
export const arLabel = (label: string): string => tAr(label, label);
