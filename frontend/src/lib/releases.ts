/**
 * Release history, newest first. The first entry is the running version.
 *
 * Numbering: every release that reaches the server raises the minor number
 * (1.1 → 1.2); a large change of the system raises the major number (2.0);
 * an urgent fix with nothing new adds a third part (1.2.1).
 * The backend's package.json "version" must match the first entry.
 */
export type ReleaseItemKind = 'new' | 'improve' | 'fix' | 'security';

export interface Release {
  version: string;
  date: string;
  title: string;
  titleEn: string;
  items: Array<{ kind: ReleaseItemKind; ar: string; en: string }>;
}

export const RELEASES: Release[] = [
  {
    version: '1.1',
    date: '2026-10-17',
    title: 'المحافظات، الموظفون الأجانب، المساعد الذكي، التكاليف والموافقات',
    titleEn: 'Governorates, foreign staff, AI assistant, expenses and approvals',
    items: [
      { kind: 'new', ar: 'ثلاث محافظات (بغداد، الموصل، أربيل) لكل منها فروعها وملف رواتبها، وكشف الرواتب حسب المحافظة والفرع والقسم بالدينار والدولار أو كليهما', en: 'Three governorates with their own branches and payroll files; payroll register by governorate, branch and department in IQD, USD or both' },
      { kind: 'new', ar: 'نشرة سعر صرف الدولار اليومية، ويظهر راتب كل موظف بعملته ومعادله بالعملة الأخرى', en: 'Daily USD/IQD rate bulletin; every salary shown in its currency and its equivalent' },
      { kind: 'new', ar: 'الموظف المحلي والأجنبي: الجواز والإقامة وتذكير قبل انتهاء الإقامة بـ 60 يوماً والجواز بـ 6 أشهر', en: 'Local and foreign employees: passport and residency with reminders 60 days / 6 months before expiry' },
      { kind: 'new', ar: 'المساعد الذكي: يحتسب الحضور بأوامرك المكتوبة، ويرتب ملفات الإكسل القديمة إلى بطاقات ورواتب، ويفحص اكتمال المستمسكات', en: 'AI assistant: attendance rules from written instructions, old Excel files organized into cards and salaries, document completeness' },
      { kind: 'new', ar: 'العطل الرسمية العراقية لكل سنة (تُقترح وتُؤكد من المالك) والإجازة التعويضية برصيد منفصل', en: 'Iraqi official holidays per year (proposed, confirmed by the owner) and compensatory leave with its own balance' },
      { kind: 'new', ar: 'تذكيرات تلقائية: أعياد الميلاد، انتهاء التجربة، إكمال سنة، تجديد العقود، أقساط السلف', en: 'Automatic reminders: birthdays, probation, service year, contract renewal, loan instalments' },
      { kind: 'new', ar: 'استمارة السلفة من قالب الشركة، والاستقطاع المباشر من الراتب يُغلق ويُؤرشف تلقائياً', en: 'Advance form from the company template; direct deductions close and archive themselves' },
      { kind: 'new', ar: 'تطبيقا التكاليف والموافقات بسلاسل اعتماد مثل أودو', en: 'Expenses and Approvals apps with approval chains, Odoo style' },
      { kind: 'new', ar: 'ترتيب التطبيقات، وتحديد التطبيقات الظاهرة لكل مستخدم (يُطبق على الخادم)', en: 'App ordering and per-user app access, enforced on the server' },
      { kind: 'improve', ar: 'الدعوة: تختار واتساب أو رسالة أو بريد، وترى النص وتعدّله قبل الإرسال، وفيه رابط الدخول', en: 'Invitations: choose WhatsApp, SMS or e-mail, read and edit the text first; it carries the sign-in link' },
      { kind: 'improve', ar: 'إشعارات وموافقات على البريد الشخصي برسائل عربية وإنكليزية', en: 'Notifications and approvals by personal e-mail, in Arabic and English' },
      { kind: 'new', ar: 'رقم النسخة وسجل «ما الجديد» داخل النظام', en: 'Version number and a What\'s new log inside the system' },
    ],
  },
  {
    version: '1.0',
    date: '2026-10-15',
    title: 'الإطلاق',
    titleEn: 'Launch',
    items: [
      { kind: 'new', ar: 'الموظفون والهيكل التنظيمي وملف الموظف وبطاقته، العقود والمستمسكات', en: 'Employees, organization, employee file and card, contracts and documents' },
      { kind: 'new', ar: 'الحضور بالبصمة، الإجازات والاستحقاق الشهري، الرواتب بسلسلة اعتماد وتوقيع إلكتروني، السلف', en: 'Fingerprint attendance, leave and monthly accrual, payroll with approval chain and e-signatures, loans' },
      { kind: 'new', ar: 'بوابة الموظف، سجل الموارد البشرية، التذاكر، التوظيف، المخطط الهرمي، الأرشيف', en: 'Employee portal, HR register, helpdesk, recruitment, org chart, archive' },
      { kind: 'new', ar: 'المالية والترحيل إلى SAP Business One', en: 'Finance and posting to SAP Business One' },
      { kind: 'security', ar: 'الحارس الأمني والرادار والجدار الناري وتشفير الملفات وسجل تدقيق متسلسل', en: 'Security guard, radar, firewall, encrypted files and a hash-chained audit log' },
    ],
  },
];

export const APP_VERSION = RELEASES[0].version;

export const RELEASE_KIND: Record<ReleaseItemKind, { ar: string; en: string; tone: string }> = {
  new: { ar: 'جديد', en: 'New', tone: 'good' },
  improve: { ar: 'تحسين', en: 'Improved', tone: 'info' },
  fix: { ar: 'إصلاح', en: 'Fixed', tone: 'warn' },
  security: { ar: 'أمان', en: 'Security', tone: 'muted' },
};
