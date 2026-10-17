import JSZip from 'jszip';

/**
 * Contract templates are ordinary Word files in which HR writes fields as
 * {{name}} — in English or Arabic — wherever employee data should appear.
 * Word often splits typed text across several runs, so placeholders are found
 * on the paragraph's joined text and written back into the runs they span;
 * the formatting of everything else in the paragraph is kept.
 */

export interface ContractField {
  key: string;
  alias: string;
  label: string;
}

export const CONTRACT_FIELDS: ContractField[] = [
  { key: 'employee_no', alias: 'رقم_الموظف', label: 'رقم الموظف' },
  { key: 'name', alias: 'اسم_الموظف', label: 'الاسم الكامل (عربي)' },
  { key: 'name_en', alias: 'الاسم_الانكليزي', label: 'الاسم بالإنكليزي' },
  { key: 'title_ar', alias: 'اللقب', label: 'السيد / السيدة' },
  { key: 'title_en', alias: 'اللقب_انكليزي', label: 'Mr / Mrs' },
  { key: 'nationality', alias: 'الجنسية', label: 'الجنسية' },
  { key: 'id_number', alias: 'رقم_الهوية', label: 'رقم البطاقة الموحدة / الجواز' },
  { key: 'birth_date', alias: 'تاريخ_الميلاد', label: 'تاريخ الميلاد' },
  { key: 'address', alias: 'العنوان', label: 'عنوان السكن' },
  { key: 'phone', alias: 'الهاتف', label: 'رقم الهاتف' },
  { key: 'position', alias: 'المسمى_الوظيفي', label: 'المسمى الوظيفي' },
  { key: 'department', alias: 'القسم', label: 'القسم' },
  { key: 'branch', alias: 'الفرع', label: 'الفرع' },
  { key: 'work_location', alias: 'مكان_العمل', label: 'مكان العمل (الفرع والمدينة)' },
  { key: 'hire_date', alias: 'تاريخ_المباشرة', label: 'تاريخ المباشرة' },
  { key: 'start_date', alias: 'تاريخ_بداية_العقد', label: 'بداية العقد' },
  { key: 'end_date', alias: 'تاريخ_نهاية_العقد', label: 'نهاية العقد' },
  { key: 'probation_end', alias: 'نهاية_التجربة', label: 'نهاية فترة التجربة' },
  { key: 'salary', alias: 'الراتب', label: 'الراتب الإجمالي الشهري' },
  { key: 'daily_wage', alias: 'الأجر_اليومي', label: 'الأجر اليومي' },
  { key: 'currency', alias: 'العملة', label: 'رمز العملة (IQD / USD)' },
  { key: 'currency_ar', alias: 'العملة_عربي', label: 'العملة كتابة (دينار عراقي…)' },
  { key: 'contract_no', alias: 'رقم_العقد', label: 'رقم العقد' },
  { key: 'contract_date', alias: 'تاريخ_العقد', label: 'تاريخ تحرير العقد' },
  { key: 'contract_day', alias: 'يوم_العقد', label: 'يوم تحرير العقد (الأحد…)' },
  { key: 'company', alias: 'اسم_الشركة', label: 'اسم الشركة القانوني' },
  // Advance (salary loan) forms.
  { key: 'loan_no', alias: 'رقم_السلفة', label: 'رقم السلفة / المرجع' },
  { key: 'loan_kind', alias: 'نوع_السلفة', label: 'نوع السلفة (أقساط / استقطاع مباشر)' },
  { key: 'loan_amount', alias: 'مبلغ_السلفة', label: 'مبلغ السلفة' },
  { key: 'loan_months', alias: 'عدد_الأشهر', label: 'عدد أشهر الاستقطاع' },
  { key: 'loan_installment', alias: 'القسط_الشهري', label: 'القسط الشهري' },
  { key: 'loan_start', alias: 'شهر_بداية_الاستقطاع', label: 'شهر بداية الاستقطاع' },
  { key: 'loan_end', alias: 'شهر_آخر_استقطاع', label: 'شهر آخر استقطاع' },
  { key: 'loan_schedule', alias: 'جدول_الاستقطاع', label: 'جدول الاستقطاع شهراً بشهر' },
  { key: 'loan_remaining', alias: 'المتبقي', label: 'المتبقي من السلفة' },
];

const BY_NAME = new Map<string, string>(CONTRACT_FIELDS.flatMap((field) => [[field.key, field.key], [field.alias, field.key]]));
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const PARAGRAPH = /<w:p[\s>][\s\S]*?<\/w:p>/g;
const TEXT_NODE = /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g;
const PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

function decode(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function encode(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Normalises a placeholder name to its field key; unknown names stay as written. */
export function fieldKey(name: string): string {
  const clean = name.trim().replace(/\s+/g, '_');
  return BY_NAME.get(clean) ?? clean;
}

interface Node { open: string; text: string; close: string; start: number; end: number }

function rewriteParagraph(xml: string, replace: (name: string) => string | null, found: Set<string>): string {
  const nodes: Node[] = [];
  let joined = '';
  const skeleton = xml.replace(TEXT_NODE, (_match, open: string, raw: string, close: string) => {
    const text = decode(raw);
    nodes.push({ open, text, close, start: joined.length, end: joined.length + text.length });
    joined += text;
    return `\u0000${nodes.length - 1}\u0000`;
  });
  if (!joined.includes('{{')) return xml;
  const matches = [...joined.matchAll(PLACEHOLDER)];
  if (!matches.length) return xml;
  // Work from the end so earlier offsets stay valid.
  for (const match of matches.reverse()) {
    const name = match[1];
    found.add(fieldKey(name));
    const value = replace(name);
    if (value === null) continue;
    const from = match.index!;
    const to = from + match[0].length;
    const first = nodes.findIndex((node) => from >= node.start && from < node.end);
    if (first < 0) continue;
    for (let index = first; index < nodes.length && nodes[index].start < to; index += 1) {
      const node = nodes[index];
      const cutFrom = Math.max(0, from - node.start);
      const cutTo = Math.min(node.text.length, to - node.start);
      node.text = node.text.slice(0, cutFrom) + (index === first ? value : '') + node.text.slice(cutTo);
    }
  }
  return skeleton.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => {
    const node = nodes[Number(index)];
    const open = node.open.includes('xml:space') ? node.open : node.open.replace('<w:t', '<w:t xml:space="preserve"');
    return `${open}${encode(node.text)}${node.close}`;
  });
}

async function eachPart(zip: JSZip, work: (xml: string) => string): Promise<void> {
  for (const name of Object.keys(zip.files)) {
    if (!PARTS.test(name)) continue;
    const xml = await zip.file(name)!.async('string');
    const next = work(xml);
    if (next !== xml) zip.file(name, next);
  }
}

/** Opens a .docx and checks it really is a Word document. */
export async function openDocx(buffer: Buffer): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error('NOT_DOCX');
  }
  if (!zip.file('word/document.xml')) throw new Error('NOT_DOCX');
  return zip;
}

/** Field keys used by a template (unknown names are returned as written). */
export async function templateFields(buffer: Buffer): Promise<string[]> {
  const zip = await openDocx(buffer);
  const found = new Set<string>();
  await eachPart(zip, (xml) => {
    xml.replace(PARAGRAPH, (paragraph) => rewriteParagraph(paragraph, () => null, found));
    return xml;
  });
  return [...found];
}

/** Returns the template with every known placeholder replaced. */
export async function fillTemplate(buffer: Buffer, values: Record<string, string>): Promise<Buffer> {
  const zip = await openDocx(buffer);
  const found = new Set<string>();
  await eachPart(zip, (xml) => xml.replace(PARAGRAPH, (paragraph) =>
    rewriteParagraph(paragraph, (name) => {
      const key = fieldKey(name);
      return key in values ? values[key] : null;
    }, found)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
