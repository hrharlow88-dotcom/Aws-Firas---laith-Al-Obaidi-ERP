/**
 * Ready, bilingual texts issued in the name of the system administration and
 * Human Resources. Placeholders in braces are filled per recipient:
 * {name} {employeeNo} {link} {date} {time} {place} {title} {details}.
 */
export interface MessageTemplate {
  id: string;
  label: string;
  subject: string;
  body: string;
  fields: string[];
}

const SIGNATURE = `مع التقدير،
إدارة النظام — قسم الموارد البشرية
مجموعة الليث العبيدي للسيارات في العراق

Kind regards,
System Administration — Human Resources Department
Al-Laith Al-Obaidi Automotive Group, Iraq`;

export const MESSAGE_TEMPLATES: MessageTemplate[] = [
  {
    id: 'portal_invite',
    label: 'دعوة لبوابة الموظف · Employee portal invitation',
    subject: 'دعوة للانضمام إلى بوابة الموظف | Invitation to the Employee Portal',
    fields: ['link'],
    body: `السيد/السيدة {name} المحترم/ة،
تحية طيبة وبعد،

يسرّ إدارة الموارد البشرية دعوتكم إلى تفعيل حسابكم في بوابة الموظف ضمن نظام ERP مجموعة الليث العبيدي للسيارات، حيث يمكنكم من خلالها الاطلاع على بطاقتكم الوظيفية وسجل الحضور والانصراف، وتقديم طلبات الإجازات والإجازات الزمنية والسلف وتكاليف العمل ومتابعتها.

رقمكم الوظيفي لتسجيل الدخول: {employeeNo}
لتعيين كلمة المرور الخاصة بكم يُرجى فتح الرابط التالي (صالح لمدة سبعة أيام ولمرة واحدة):
{link}

يُرجى عدم مشاركة هذا الرابط مع أي شخص.

Dear {name},

Human Resources is pleased to invite you to activate your account on the Employee Portal of the Al-Laith Al-Obaidi Automotive Group ERP. Through the portal you can view your employee card and attendance record, and submit and follow up leave, hourly leave, salary advance and work-expense requests.

Your employee number for signing in: {employeeNo}
To set your password, please open the link below (valid once, for seven days):
{link}

Please do not share this link with anyone.

${SIGNATURE}`,
  },
  {
    id: 'staff_invite',
    label: 'دعوة مستخدم للنظام · System user invitation',
    subject: 'دعوة لاستخدام نظام ERP المجموعة | Invitation to the Group ERP',
    fields: ['link'],
    body: `السيد/السيدة {name} المحترم/ة،
تحية طيبة وبعد،

تمت إضافتكم مستخدماً في نظام ERP مجموعة الليث العبيدي للسيارات. لتفعيل الحساب وتعيين كلمة المرور الخاصة بكم يُرجى فتح الرابط التالي (صالح لمدة سبعة أيام ولمرة واحدة):
{link}

اسم الدخول: {login}

Dear {name},

You have been added as a user of the Al-Laith Al-Obaidi Automotive Group ERP. To activate your account and set your password, please open the link below (valid once, for seven days):
{link}

Sign-in: {login}

${SIGNATURE}`,
  },
  {
    id: 'meeting_invite',
    label: 'دعوة اجتماع · Meeting invitation',
    subject: 'دعوة لحضور اجتماع: {title} | Meeting invitation: {title}',
    fields: ['title', 'date', 'time', 'place', 'details'],
    body: `السيد/السيدة {name} المحترم/ة،
تحية طيبة وبعد،

تتشرف إدارة الموارد البشرية بدعوتكم لحضور اجتماع بعنوان «{title}».
التاريخ: {date}
الوقت: {time}
المكان: {place}
{details}

نرجو التكرّم بالحضور في الموعد المحدد، وإبلاغنا في حال تعذّر ذلك.

Dear {name},

Human Resources is honoured to invite you to attend the meeting "{title}".
Date: {date}
Time: {time}
Venue: {place}
{details}

We kindly ask you to be on time, and to let us know if you are unable to attend.

${SIGNATURE}`,
  },
  {
    id: 'interview_invite',
    label: 'دعوة مقابلة عمل · Job interview invitation',
    subject: 'دعوة لمقابلة عمل — {title} | Job interview invitation — {title}',
    fields: ['title', 'date', 'time', 'place'],
    body: `السيد/السيدة {name} المحترم/ة،
تحية طيبة وبعد،

نشكركم على اهتمامكم بالعمل لدى مجموعة الليث العبيدي للسيارات، ويسرّنا دعوتكم لإجراء مقابلة عمل لوظيفة «{title}».
التاريخ: {date}
الوقت: {time}
المكان: {place}

يُرجى إحضار نسخة من السيرة الذاتية والمستمسكات الرسمية، وتأكيد الحضور بالرد على هذه الرسالة.

Dear {name},

Thank you for your interest in joining the Al-Laith Al-Obaidi Automotive Group. We are pleased to invite you to an interview for the position of "{title}".
Date: {date}
Time: {time}
Venue: {place}

Please bring a copy of your CV and official documents, and confirm your attendance by replying to this message.

${SIGNATURE}`,
  },
  {
    id: 'announcement',
    label: 'تعميم · Circular',
    subject: 'تعميم: {title} | Circular: {title}',
    fields: ['title', 'details'],
    body: `إلى جميع منتسبي مجموعة الليث العبيدي للسيارات المحترمين،
تحية طيبة وبعد،

{details}

يُرجى الاطلاع والعمل بموجبه اعتباراً من تاريخه.

To all Al-Laith Al-Obaidi Automotive Group staff,

{details}

Please take note and act accordingly from today.

${SIGNATURE}`,
  },
  {
    id: 'payslip_ready',
    label: 'إشعار صدور قسيمة الراتب · Payslip available',
    subject: 'قسيمة راتب {date} متاحة | Your {date} payslip is available',
    fields: ['date', 'link'],
    body: `السيد/السيدة {name} المحترم/ة،

نُعلمكم بأن قسيمة راتب شهر {date} أصبحت متاحة في بوابة الموظف:
{link}

Dear {name},

Your payslip for {date} is now available on the Employee Portal:
{link}

${SIGNATURE}`,
  },
  {
    id: 'general',
    label: 'رسالة عامة · General message',
    subject: '{title}',
    fields: ['title', 'details'],
    body: `السيد/السيدة {name} المحترم/ة،
تحية طيبة وبعد،

{details}

Dear {name},

{details}

${SIGNATURE}`,
  },
];

export function fillTemplate(text: string, values: Record<string, string | null | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => (values[key] !== undefined && values[key] !== null ? String(values[key]) : match))
    .replace(/\n{3,}/g, '\n\n');
}
