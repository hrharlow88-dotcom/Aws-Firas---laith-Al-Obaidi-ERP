import type { LucideIcon } from 'lucide-react';
import {
  BookOpenCheck, CalendarDays, CircleUserRound, Target, Fingerprint, History, Landmark, LayoutDashboard, PlugZap, Settings, Users, Wallet,
} from 'lucide-react';
import type { Permission } from '../SettingsPage';

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
    id: 'dashboard', label: 'لوحة المعلومات', description: 'ملخص اليوم', icon: LayoutDashboard,
    colors: ['#3d3a40', '#1d1b1f'], menus: [{ page: 'overview', label: 'نظرة عامة' }], staffOnly: true,
  },
  {
    id: 'employees', label: 'الموظفون', description: 'الملفات والبطاقات والعقود', icon: Users,
    colors: ['#f07a52', '#d2461f'],
    menus: [
      { page: 'employees', label: 'الموظفون' },
      { page: 'org', label: 'الأقسام والهيكل' },
      { page: 'branches', label: 'الفروع' },
      { page: 'contract-templates', label: 'قوالب العقود', permission: 'employees.manage_profile' },
    ],
    extraPages: ['card'],
    staffOnly: true,
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
    ],
  },
  {
    id: 'payroll', label: 'الرواتب', description: 'المسيرات والسلف', icon: Wallet,
    colors: ['#9b6bd6', '#6c3fb0'],
    menus: [
      { page: 'payroll', label: 'المسيرات', permission: 'payroll.view' },
      { page: 'payroll-days', label: 'أيام الاستحقاق', permission: 'payroll.view' },
      { page: 'loans', label: 'السلف', permission: 'payroll.view' },
    ],
    extraPages: ['payslip'],
  },
  {
    id: 'performance', label: 'الأداء', description: 'الأوصاف الوظيفية ومؤشرات الأداء', icon: Target,
    colors: ['#d4657d', '#a3324d'],
    menus: [{ page: 'kpi', label: 'الأوصاف ومؤشرات الأداء' }],
    staffOnly: true,
  },
  {
    id: 'finance', label: 'المالية و SAP', description: 'القيود والترحيل', icon: Landmark,
    colors: ['#e3a83b', '#b97c12'], menus: [{ page: 'finance', label: 'القيود والربط', permission: 'finance.view' }],
  },
  {
    id: 'audit', label: 'التدقيق', description: 'سجل كل العمليات', icon: History,
    colors: ['#7d8794', '#4f5864'], menus: [{ page: 'audit', label: 'سجل التدقيق', permission: 'audit.view' }],
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
    id: 'settings', label: 'الإعدادات', description: 'المستخدمون والصلاحيات', icon: Settings,
    colors: ['#8a7f7a', '#5c524d'],
    menus: [
      { page: 'settings', label: 'إعدادات النظام', adminOnly: true },
      { page: 'company-import', label: 'استيراد بيانات الشركة', adminOnly: true },
      { page: 'access', label: 'المستخدمون', permission: 'users.manage' },
      { page: 'security', label: 'أمان الحساب' },
    ],
  },
];

export function appForPage(page: string): AppDefinition | undefined {
  return APPS.find((app) => app.menus.some((menu) => menu.page === page) || app.extraPages?.includes(page));
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
  'الطلبات': 'Requests', 'طلبات الموظفين': 'Employee Requests',
};
export const en = (label: string): string => EN[label] ?? '';
