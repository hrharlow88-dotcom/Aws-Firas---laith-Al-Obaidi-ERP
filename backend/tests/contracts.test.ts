import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';
import { fillTemplate, templateFields } from '../src/services/contracts';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

/** A minimal Word document whose placeholder is split across runs, as Word does. */
async function docx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const text = async (buffer: Buffer) => (await (await JSZip.loadAsync(buffer)).file('word/document.xml')!.async('string'))
  .replace(/<[^>]+>/g, '');

describe('contract templates', () => {
  it('fills placeholders split across runs and keeps the rest of the paragraph', async () => {
    const template = await docx([
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>الاسم: </w:t></w:r><w:r><w:t>{{اسم_</w:t></w:r><w:r><w:t>الموظف}} / {{position}}</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Salary {{ salary }} {{currency}} &amp; more</w:t></w:r></w:p>',
    ]);
    expect((await templateFields(template)).sort()).toEqual(['currency', 'name', 'position', 'salary']);
    const filled = await fillTemplate(template, { name: 'سارة <علي>', position: 'محاسب', salary: '1,250,000', currency: 'IQD' });
    expect(await text(filled)).toBe('الاسم: سارة &lt;علي&gt; / محاسبSalary 1,250,000 IQD &amp; more');
    await expect((await JSZip.loadAsync(filled)).file('word/document.xml')!.async('string')).resolves.toContain('<w:b/>');
  });

  describe('through the API', () => {
    let hr: Awaited<ReturnType<typeof makeUser>>;
    let employeeId: string;
    beforeAll(async () => {
      hr = await makeUser('hr_manager');
      const branch = await makeBranch('فرع العقود');
      employeeId = (await makeEmployee(branch.id, { fullName: 'مصطفى كريم' })).id;
      await api().post(`/api/employees/${employeeId}/compensation`).set(hr.auth)
        .send({ effectiveFrom: '2026-01-01', grossSalary: 900000, currency: 'IQD', reason: 'تعيين' }).expect(201);
    });

    it('rejects unknown fields, then generates a filled contract into the employee file', async () => {
      const bad = await docx(['<w:p><w:r><w:t>{{راتب_خطأ}}</w:t></w:r></w:p>']);
      const refused = await api().post('/api/contracts/templates').set(hr.auth).field('name', 'خطأ').attach('file', bad, 'bad.docx').expect(400);
      expect(refused.body.message).toContain('راتب_خطأ');

      const good = await docx(['<w:p><w:r><w:t>{{اسم_الموظف}} - {{الراتب}} {{العملة_عربي}} - {{تاريخ_بداية_العقد}}</w:t></w:r></w:p>']);
      const created = await api().post('/api/contracts/templates').set(hr.auth)
        .field('name', 'عقد اختبار').field('contractType', 'fixed_term').attach('file', good, 'good.docx').expect(201);
      const generated = await api().post(`/api/employees/${employeeId}/contracts/generate`).set(hr.auth)
        .send({ templateId: created.body.data.id, startsOn: '2026-11-01', endsOn: '2027-10-31' }).expect(201);

      const contracts = await api().get(`/api/employees/${employeeId}/contracts`).set(hr.auth).expect(200);
      expect(contracts.body.data[0]).toMatchObject({ status: 'draft', documentId: generated.body.data.documentId });
      const file = await api().get(`/api/documents/${generated.body.data.documentId}/file`).set(hr.auth)
        .buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); })
        .expect(200);
      expect(await text(file.body as Buffer)).toBe('مصطفى كريم - 900,000 دينار عراقي - 01/11/2026');
    });
  });
});
