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
    version: '2.1.1',
    date: '2026-10-17',
    title: 'تصحيح تحميل الخطوط',
    titleEn: 'Font loading fixed',
    items: [
      { kind: 'fix', ar: 'أجزاء صغيرة من الخط كانت تُرفض عند فتح كل صفحة بسبب سياسة الأمان وتترك أخطاء في المتصفح؛ صارت تُحمّل كملفات عادية', en: 'Small parts of the font were refused by the security policy on every page load and left errors in the browser; they now load as ordinary files' },
      { kind: 'improve', ar: 'الفحص الآلي للشاشات يعمل بسياسة الأمان نفسها التي يعمل بها النظام على الخادم، ويلتقط ما يحدث لحظة فتح النظام', en: 'The automated screen check runs under the same security policy as the live server and catches what happens while the system opens' },
    ],
  },
  {
    version: '2.1',
    date: '2026-10-17',
    title: 'الوضع الداكن أوضح، وتنظيف التنسيق وأدوات التطوير',
    titleEn: 'Clearer dark mode, a cleaner stylesheet and development tools',
    items: [
      { kind: 'fix', ar: 'في الوضع الداكن صارت ألوان الحالات مقروءة: رسائل «حُفظ» والأخطاء، التنبيهات، وشارات «بانتظار الاعتماد» و«اطلعت»، بدل نص داكن على خلفية داكنة أو شارات فاتحة لامعة', en: 'In dark mode status colours are now readable: saved and error messages, warnings, and badges such as awaiting approval and seen, instead of dark text on dark backgrounds or glaring light badges' },
      { kind: 'improve', ar: 'ملف التنسيق أخف: حُذفت قواعد الواجهة القديمة التي لم تعد تُستعمل، وتحققنا بمقارنة صور كل الشاشات قبل وبعد أن الشكل لم يتغير', en: 'A lighter stylesheet: rules left from the old layout were removed, and screenshots of every screen before and after confirm nothing else changed' },
      { kind: 'security', ar: 'ترقية أدوات التطوير والاختبار ومكتبة المعرّفات لسد ثغرات معروفة فيها', en: 'Development, test tools and the ID library upgraded to close known flaws' },
    ],
  },
  {
    version: '2.0.1',
    date: '2026-10-17',
    title: 'تصحيح أحجام نصوص صغيرة، وفحص آلي لكل شاشة قبل كل نشر',
    titleEn: 'Small text sizes fixed, and every screen checked before each release',
    items: [
      { kind: 'fix', ar: 'تاريخ الإعلان في لوحة الإعلانات والملاحظات الصغيرة في الإعدادات صارت بحجم 12px على التلفون مثل باقي النصوص', en: 'The date on notice-board cards and small notes in settings are now 12px on phones, like all other text' },
      { kind: 'improve', ar: 'قبل كل نشر: اختبار آلي يمر بدورة موظف كاملة من الشاغر إلى القسيمة والقيد في SAP، وفحص يفتح كل شاشة على التلفون والحاسبة', en: 'Before every release: an automated test that walks one employee from vacancy to payslip and SAP journal, and a check that opens every screen on phone and computer' },
    ],
  },
  {
    version: '2.0',
    date: '2026-10-17',
    title: 'النظام تطبيق على التلفون: إشعارات، شريط سفلي، تثبيت على الشاشة، وملاحظات المستخدمين',
    titleEn: 'The system as a phone app: notifications, a tab bar, home-screen install, and user feedback',
    items: [
      { kind: 'new', ar: 'إشعارات على التلفون والحاسبة حتى والنظام مغلق: الإجازات والاعتمادات والمحادثات والرواتب. المالك يفعّلها مرة من «لوحة المالك ← القنوات»، ثم يفعّلها كل شخص على جهازه من «المزيد» أو من الجرس. على الآيفون تعمل من النظام المثبت على الشاشة الرئيسية', en: 'Notifications on phones and computers even when the system is closed: leave, approvals, chat and payroll. The owner switches them on once in Owner console → Channels; each person then turns them on per device from More or the bell. On iPhone they work in the system installed on the home screen' },
      { kind: 'new', ar: 'شريط سفلي على التلفون مثل التطبيقات: الرئيسية، اعتماداتي أو خدمتي، المحادثات بعدد غير المقروء، والمزيد (الإشعارات، التثبيت، الملاحظات، أمان الحساب، الألوان واللغة، الخروج)', en: 'A tab bar on phones like an app: Home, Approvals or My portal, Chat with its unread count, and More (notifications, install, feedback, account security, colours and language, sign out)' },
      { kind: 'new', ar: 'تثبيت النظام على الشاشة الرئيسية: بطاقة بالخطوات للآيفون والأندرويد، ثم يفتح بملء الشاشة بأيقونته', en: 'Install on the home screen: a card with the steps for iPhone and Android; it then opens full screen from its icon' },
      { kind: 'new', ar: '«ملاحظة على النظام» لكل مستخدم: خطأ أو اقتراح أو سؤال مع لقطة شاشة، تصل للمالك برقم (FB-0001) مع الشاشة ورقم النسخة والجهاز. المالك يرد ويغيّر الحالة من «لوحة المالك ← ملاحظات المستخدمين» فيصل صاحبها إشعار', en: 'Send feedback, for everyone: a fault, an idea or a question with a screenshot, reaching the owner numbered (FB-0001) with the screen, version and device. The owner answers and sets its status in Owner console → User feedback, and the sender is notified' },
      { kind: 'new', ar: 'النسخ الاحتياطي خارج الخادم: المالك ينزّل نسخ الليلة (قاعدة البيانات والملفات) من «لوحة المالك ← النسخ الاحتياطي»، ويذكّره النظام كل أسبوع حتى يفعل. كل تنزيل يُسجّل', en: 'Backups off the server: the owner downloads the nightly copies (database and files) from Owner console → Backups, with a weekly reminder until done. Every download is recorded' },
      { kind: 'improve', ar: 'قائمة «المزيد» على التلفون ترتفع من أسفل الشاشة بدل أن تغطيها كلها', en: 'The More menu on phones rises from the bottom instead of covering the whole screen' },
      { kind: 'security', ar: 'ترقية مكتبة رفع الملفات لسد ثغرة تعطيل، والخادم لا يرسل الإشعارات إلا لخدمات المتصفحات المعروفة (Google وApple وMozilla وMicrosoft)', en: 'File-upload library upgraded to close a denial-of-service flaw; the server sends notifications only to the known browser push services (Google, Apple, Mozilla, Microsoft)' },
    ],
  },
  {
    version: '1.3',
    date: '2026-10-17',
    title: 'بوابة الموظف بيد المالك، إكسل الموظفين الشامل، وملفات البصمة الثلاثة',
    titleEn: 'Owner-controlled employee portal, one employee sheet, the three fingerprint files',
    items: [
      { kind: 'new', ar: 'المالك يحدد ما يظهر في بوابة الموظف وما يُطلب منها (البطاقة، الحضور، الأرصدة، الإجازات، القسائم، السلف، التكاليف، التذاكر، الإنذارات، الصورة) ويضع رسالة أعلاها: لوحة المالك ← بوابة الموظف', en: 'The owner decides what the employee portal shows and offers (card, attendance, balances, leave, payslips, loans, expenses, tickets, notices, photo) and can post a note at its top: Owner console → Employee portal' },
      { kind: 'new', ar: 'ملف Excel واحد لبيانات الموظفين: الاسم بالعربي والإنكليزي، رقم البصمة، البريد والهاتف الشخصيان، المدير، القسم، المسمى، المحافظة، الفرع، المباشرة والراتب. معاينة كل تغيير ثم اعتماد، وسطر برقم جديد يضيف موظفاً: الموظفون ← استيراد وتحديث', en: 'One Excel sheet for employee data: Arabic and English names, fingerprint number, personal e-mail and phone, manager, department, position, governorate, branch, joining date and salary. Preview every change, then apply; a new number adds an employee: Employees → Import and update' },
      { kind: 'new', ar: 'الصور: الموظف يرسل صورته من «خدمتي» والموارد البشرية تعتمدها كلها بضغطة واحدة، أو تُرفع صور كثيرة دفعة واحدة باسم رقم الموظف (10123.jpg)', en: 'Photos: employees send theirs from the portal and HR takes them all in with one click, or many photos are uploaded at once named by employee number (10123.jpg)' },
      { kind: 'new', ar: 'ملفات نظام البصمة الثلاثة كلٌّ على حدة: الحضور، والإجازات بكل أنواعها (تُسجّل معتمدة وتُخصم من الرصيد ولا تتكرر)، ومهام بصمة التطبيق للعمل الخارجي (وقت المهمة يُحتسب دواماً واليوم الكامل حضوراً)', en: 'The fingerprint system\'s three files, each on its own: attendance, leave of every type (recorded as approved, taken from the balance, never twice), and app tasks for external work (task time counts as work, a whole day as present)' },
      { kind: 'improve', ar: 'تُقرأ الملفات برقم البصمة والاسم والتاريخ؛ الأعمدة تُعرف تلقائياً ويمكن تغييرها، ومن طوبق بالاسم يُحفظ رقم بصمته في ملفه', en: 'Files are read by fingerprint number, name and date; columns are recognised automatically and can be changed, and a fingerprint number matched by name is saved to the employee' },
      { kind: 'security', ar: 'إعدادات النظام كاملة للمالك وحده؛ بقية الحسابات تستلم ما تحتاجه شاشاتها فقط', en: 'Full system settings go to the owner only; other accounts receive what their screens need' },
    ],
  },
  {
    version: '1.2',
    date: '2026-10-17',
    title: 'الموبايل أولاً: كل الشاشات تناسب التلفون، خط أوضح، تحميل أسرع',
    titleEn: 'Mobile first: every screen fits the phone, clearer type, faster loading',
    items: [
      { kind: 'fix', ar: 'لا شاشة أعرض من التلفون بعد الآن: فُحصت 59 شاشة على 5 قياسات (من 320 إلى 1440 بكسل) ولا تتزحلق أي منها جانبياً', en: 'No screen is wider than the phone any more: 59 screens checked at five widths (320–1440 px), none scrolls sideways' },
      { kind: 'improve', ar: 'على التلفون: قوائم التطبيق بصف ثانٍ يُسحب، الجداول تتحول إلى بطاقات، النوافذ بملء الشاشة، وأربعة تطبيقات في كل صف', en: 'On phones: app menus in a second swipeable row, tables turn into cards, dialogs fill the screen, four apps per row' },
      { kind: 'improve', ar: 'خط عربي وإنكليزي موحّد (IBM Plex Sans Arabic) ونصوص أكبر وأوضح، ولا تكبير تلقائي مزعج عند الكتابة على الآيفون', en: 'One Arabic/English typeface (IBM Plex Sans Arabic), larger clearer text, no automatic zoom while typing on iPhone' },
      { kind: 'improve', ar: 'الواجهة بالعربي افتراضياً، والإنكليزي أو اللغتان معاً من قائمة الحساب', en: 'Arabic by default; English or both from the account menu' },
      { kind: 'improve', ar: 'فتح أسرع: الملف الأول صار 84 كيلوبايت مضغوط بدل 216، وكل شاشة تُحمّل عند فتحها', en: 'Faster start: the first download is 84 KB compressed instead of 216, each screen loads when opened' },
      { kind: 'fix', ar: 'التطبيق المثبت على الآيفون لم يعد يدخل تحت شريط الساعة', en: 'The installed iPhone app no longer sits under the status bar' },
      { kind: 'fix', ar: 'شاشة بلا صلاحية أو بلا اختيار (قسيمة، بطاقة) تشرح السبب بدل صفحة فارغة', en: 'A screen without access or without a selection explains why instead of showing a blank page' },
      { kind: 'improve', ar: 'زر «تعطيل» أُزيل من كل صف في دليل الموظفين؛ الحالة تُغيّر من ملف الموظف', en: 'The deactivate button left every row of the employee directory; status is changed in the employee file' },
      { kind: 'security', ar: 'HTTPS إلزامي للمتصفحات (HSTS)، ترقية مكتبة البريد لسد ثغرتين، وفهارس وقيود جديدة في قاعدة البيانات', en: 'HTTPS enforced for browsers (HSTS), mail library upgraded to close two flaws, new database indexes and constraints' },
    ],
  },
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
      { kind: 'improve', ar: 'النظام على دومينه الخاص erp.g-n-group.com مباشرة بدل عرضه داخل صفحة GitHub، فتعمل التنزيلات والإشعارات والتثبيت على الموبايل', en: 'The system runs directly on its own domain erp.g-n-group.com instead of inside a GitHub page, so downloads, notifications and mobile install work' },
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
